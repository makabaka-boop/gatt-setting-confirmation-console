import { computed, reactive } from 'vue'
import type {
  DeviceInfo,
  LogEntry,
  LogLevel,
  MockTuning,
  OutcomeRecord,
  OutcomeStatus,
  PendingCmd,
  Receipt
} from '../ble/types'
import { MockAdapter, MOCK_DEVICE_A, MOCK_DEVICE_B } from '../ble/mock-adapter'
import { RealBleAdapter, checkWebBluetoothSupport } from '../ble/real-adapter'
import type { ControllerAdapter } from '../ble/types'
import { DEFAULT_TUNING, MOCK_PRESETS } from '../ble/presets'

type Mode = 'mock' | 'real'
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected'

const MAX_LOGS = 200
const MAX_HISTORY = 30
const SETPOINT_MIN = -32768
const SETPOINT_MAX = 32767

interface ControllerState {
  mode: Mode
  connection: ConnectionState
  /** 最近一次从信息特征读到的权威设备状态 */
  info: DeviceInfo | null
  lastReadAt: number | null
  /** 页面草稿：永远不直接等同于设备值 */
  draft: string
  draftError: string
  pending: PendingCmd | null
  history: OutcomeRecord[]
  logs: LogEntry[]
  tuning: MockTuning
  selectedPresetKey: string
  mockTarget: string
  banner: string
  working: boolean
}

const state = reactive<ControllerState>({
  mode: 'mock',
  connection: 'idle',
  info: null,
  lastReadAt: null,
  draft: '25',
  draftError: '',
  pending: null,
  history: [],
  logs: [],
  tuning: { ...DEFAULT_TUNING },
  selectedPresetKey: 'normal',
  mockTarget: MOCK_DEVICE_A,
  banner: '',
  working: false
})

let activeAdapter: ControllerAdapter | null = null
let commandSeq = 0

function log(level: LogLevel, message: string, source = '页面'): void {
  const entry: LogEntry = { t: Date.now(), level, source, message }
  state.logs.unshift(entry)
  if (state.logs.length > MAX_LOGS) state.logs.length = MAX_LOGS
}

function archiveCurrent(): void {
  if (!state.pending) return
  state.history.unshift({ ...state.pending, archivedAt: Date.now() })
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY
  state.pending = null
}

function finishPending(
  outcome: OutcomeStatus,
  source: PendingCmd['source'],
  receipt: Receipt | null,
  detail: string
): void {
  const p = state.pending
  if (!p || p.outcome !== 'pending') return
  p.outcome = outcome
  p.source = source
  p.receipt = receipt
  p.finishedAt = Date.now()
  p.detail = detail
}

/**
 * 重连对账专用：只允许从「结果未知」推进到有结论。
 * pending 之外的任何状态（已确认/已拒绝/写入失败）都不得被对账改写。
 */
function resolveUnknown(
  outcome: OutcomeStatus,
  source: 'reconnect',
  receipt: Receipt | null,
  detail: string
): void {
  const p = state.pending
  if (!p || p.outcome !== 'unknown') return
  p.outcome = outcome
  p.source = source
  p.receipt = receipt
  p.finishedAt = Date.now()
  p.detail = detail
}

function patchInfoFromReceipt(r: Receipt): void {
  if (!state.info) return
  state.info.revision = r.revision
  state.info.setpoint = r.setpoint
}

function bindAdapter(adapter: ControllerAdapter): void {
  adapter.on('receipt', (receipt) => {
    // 旧适配器（已切换设备/模式）迟到的事件直接忽略
    if (adapter !== activeAdapter) return
    handleReceipt(receipt)
  })
  adapter.on('disconnect', ({ expected }) => {
    if (adapter !== activeAdapter) return
    state.connection = 'disconnected'
    log(
      expected ? 'info' : 'error',
      expected ? '连接已断开（手动）。' : '连接意外断开！',
      adapter.mode === 'mock' ? '模拟' : 'GATT'
    )
    if (state.pending && state.pending.outcome === 'pending') {
      finishPending(
        'unknown',
        null,
        null,
        '断线发生在回执到达前：结果未知。重连后读取设备保存的最近回执进行对账。'
      )
      log('warn', '未决命令已标记为「结果未知」；不会自动重发。')
    }
  })
  adapter.on('warn', (msg) => log('warn', msg, adapter.mode === 'mock' ? '模拟' : 'GATT'))
}

function handleReceipt(r: Receipt): void {
  const base = `收到通知 cmd=${r.commandId} boot=${r.bootId} 状态=${r.status}`
  log('protocol', base, '通知特征')

  if (!state.pending) {
    log('warn', '当前没有未决命令：该通知为迟到通知，忽略，不改变任何已确认值。')
    return
  }
  const p = state.pending
  if (p.outcome !== 'pending') {
    log('warn', `该命令已有结论（${p.outcome}）：迟到通知被忽略。`)
    return
  }
  if (r.commandId !== p.commandId) {
    log('warn', `通知绑定的命令 ${r.commandId} 不是当前未决命令 ${p.commandId}（可能来自其他设备/旧会话），忽略。`)
    return
  }
  if (state.info && r.bootId !== state.info.bootId) {
    log('warn', `通知来自旧 boot ${r.bootId}（当前 boot ${state.info.bootId}，设备已重启），忽略；以信息特征中保存的回执为准。`)
    return
  }

  if (r.status === 'ok') {
    finishPending('confirmed', 'notify', r, '收到设备 ok 回执：新设定值已被采用。')
    patchInfoFromReceipt(r)
    log('success', `命令 ${r.commandId} 已确认，实际设定值 = ${r.setpoint}，修订 = ${r.revision}。`)
  } else {
    finishPending(
      'rejected',
      'notify',
      r,
      r.status === 'conflict'
        ? '设备报告修订冲突：新值未采用，回执带回了设备实际修订与实际值。'
        : '设备拒绝了该值（超出允许范围）：新值未采用。'
    )
    patchInfoFromReceipt(r)
    log('warn', `命令 ${r.commandId} 未被采用（${r.status}）；草稿不会冒充设备值。`)
  }
}

async function refreshInfo(why: 'connect' | 'manual'): Promise<DeviceInfo | null> {
  if (!activeAdapter || state.connection !== 'connected') return null
  try {
    const info = await activeAdapter.readInfo()
    const previous = state.info
    if (why === 'connect' && previous && previous.deviceId !== info.deviceId) {
      // 切换到另一台设备：旧设备的未决不能再被新设备事件改写，归档停车
      if (state.pending) {
        if (state.pending.outcome === 'pending') {
          finishPending(
            'unknown',
            null,
            null,
            `已切换到另一台设备（${info.deviceId}）：该命令属于旧设备 ${state.pending.deviceId}，停止跟踪。`
          )
        }
        archiveCurrent()
      }
      log('info', `设备已切换：${previous.deviceId} → ${info.deviceId}。确认值已切换为新设备的实际状态。`)
    }
    state.info = info
    state.lastReadAt = Date.now()
    log(
      'protocol',
      `信息特征：device=${info.deviceId} fw=${info.firmwareRevision} boot=${info.bootId} rev=${info.revision} 设定值=${info.setpoint} 保存回执=${
        info.lastReceipt ? `cmd ${info.lastReceipt.commandId}/${info.lastReceipt.status}` : '无'
      }`,
      '信息特征'
    )
    return info
  } catch (e) {
    log('error', `读取信息特征失败：${(e as Error).message}`)
    return null
  }
}

function reconcilePendingWithSavedReceipt(info: DeviceInfo): void {
  const p = state.pending
  if (!p) return
  if (p.outcome === 'pending') {
    // 正常情况下断线事件已先标记为未知；保险：只允许 pending → unknown，
    // 绝不允许在这里凭“无回执”直接判定成功或失败。
    finishPending('unknown', null, null, '连接中断后重连：等待与设备保存的回执对账。')
  }
  if (p.outcome !== 'unknown') return

  const saved = info.lastReceipt
  if (!saved) {
    log('warn', `设备未保存命令 ${p.commandId} 的回执：保持「结果未知」。不自动重发，也不宣称失败；由用户手动决定下一步。`)
    return
  }
  if (saved.commandId !== p.commandId) {
    log('warn', `设备保存的最近回执属于命令 ${saved.commandId}，不是未决命令 ${p.commandId}：保持「结果未知」，不自动重发。`)
    return
  }
  const rebooted = saved.bootId !== info.bootId
  if (saved.status === 'ok') {
    resolveUnknown(
      'confirmed',
      'reconnect',
      saved,
      rebooted
        ? `重连后从设备保存的回执对账成功（回执来自重启前 boot ${saved.bootId}，当前 boot ${info.bootId}）。`
        : '重连后从设备保存的回执对账成功。'
    )
    // 已确认值以刚读到的信息特征为准（只读权威，不用回执反写）
    log('success', `对账确认命令 ${saved.commandId}：设备实际设定值 = ${info.setpoint}，修订 = ${info.revision}。`)
  } else {
    resolveUnknown(
      'rejected',
      'reconnect',
      saved,
      `重连对账：设备保存的回执为 ${saved.status}，新值未采用。`
    )
    log('warn', `对账显示命令 ${saved.commandId} 未被采用（${saved.status}）。`)
  }
}

async function connect(): Promise<void> {
  if (state.connection === 'connected' || state.connection === 'connecting') return
  state.banner = ''

  if (state.mode === 'real') {
    const support = checkWebBluetoothSupport()
    if (!support.available) {
      state.banner = support.reason ?? 'Web Bluetooth 不可用'
      log('error', state.banner)
      return
    }
  }

  state.connection = 'connecting'
  state.working = true
  try {
    if (!activeAdapter || activeAdapter.mode !== state.mode) {
      activeAdapter =
        state.mode === 'mock'
          ? new MockAdapter(state.mockTarget, { ...state.tuning })
          : new RealBleAdapter()
      bindAdapter(activeAdapter)
    }
    if (activeAdapter instanceof MockAdapter) {
      activeAdapter.setTuning({ ...state.tuning })
    }
    log('info', state.mode === 'mock' ? '连接模拟设备…' : '请求蓝牙设备（用户选择）…')
    await activeAdapter.connect()

    state.connection = 'connected'
    log('success', 'GATT 连接已建立：重新发现服务与三个特征，订阅通知。')
    const info = await refreshInfo('connect')
    if (info) reconcilePendingWithSavedReceipt(info)
  } catch (e) {
    log('error', `连接失败：${(e as Error).message}`)
    state.connection = activeAdapter?.connected ? 'connected' : 'disconnected'
  } finally {
    state.working = false
  }
}

async function disconnect(): Promise<void> {
  if (!activeAdapter) return
  await activeAdapter.disconnect()
}

async function reconnect(): Promise<void> {
  await connect()
}

async function reread(): Promise<void> {
  if (state.connection !== 'connected') return
  state.working = true
  try {
    await refreshInfo('manual')
  } finally {
    state.working = false
  }
}

function validateDraft(): number | null {
  const raw = state.draft.trim()
  if (!/^-?\d+$/.test(raw)) {
    state.draftError = '请输入整数设定值'
    return null
  }
  const v = Number(raw)
  if (v < SETPOINT_MIN || v > SETPOINT_MAX) {
    state.draftError = `允许范围 ${SETPOINT_MIN} ~ ${SETPOINT_MAX}`
    return null
  }
  state.draftError = ''
  return v
}

async function submitCommand(): Promise<void> {
  if (state.connection !== 'connected' || !state.info || state.pending) return
  const value = validateDraft()
  if (value === null) return

  commandSeq += 1
  const cmd: PendingCmd = {
    commandId: commandSeq,
    expectedRevision: state.info.revision,
    setpoint: value,
    deviceId: state.info.deviceId,
    bootIdAtSend: state.info.bootId,
    startedAt: Date.now(),
    finishedAt: null,
    outcome: 'pending',
    source: null,
    receipt: null,
    detail: '命令字节尚未写入。'
  }
  state.pending = cmd
  log(
    'protocol',
    `组装命令：id=${cmd.commandId} 预期修订=${cmd.expectedRevision} 新值=${value} → writeValueWithResponse`,
    '命令特征'
  )
  try {
    await activeAdapter!.sendCommand({
      commandId: cmd.commandId,
      expectedRevision: cmd.expectedRevision,
      setpoint: cmd.setpoint
    })
    log('info', 'writeValueWithResponse 已兑现：仅表示命令字节已写入，设备是否采用要等回执。')
    cmd.detail = '字节已写入，等待通知回执确认…'
  } catch (e) {
    finishPending('write-failed', null, null, `写入失败：${(e as Error).message}。设备是否收到命令未知。`)
    log('error', `命令 ${cmd.commandId} 写入失败：${(e as Error).message}`)
  }
}

/** 关闭一个已有结论的结果卡片（归档），之后才能发起新修改 */
function dismissResult(): void {
  if (state.pending && state.pending.outcome !== 'pending') archiveCurrent()
}

/** 对断线后「结果未知」的命令放弃跟踪：不自动重发、不宣称失败 */
function abandonUnknown(): void {
  if (state.pending && state.pending.outcome === 'unknown') {
    log('warn', `用户放弃跟踪命令 ${state.pending.commandId}（结果未知）；不会重发。`)
    archiveCurrent()
  }
}

function useDraftConfirmedValue(): void {
  if (state.info) {
    state.draft = String(state.info.setpoint)
    state.draftError = ''
  }
}

function setMode(mode: Mode): void {
  if (state.connection === 'connected' || state.connection === 'connecting') return
  if (mode === state.mode) return
  state.mode = mode
  activeAdapter = null
  state.pending = null
  state.info = null
  state.connection = 'idle'
  log('info', mode === 'mock' ? '已切换到模拟适配器（无需真实硬件）。' : '已切换到真实 Web Bluetooth 模式。')
}

function selectPreset(key: string): void {
  const preset = MOCK_PRESETS.find((p) => p.key === key)
  if (!preset) return
  state.selectedPresetKey = key
  state.tuning = { ...preset.tuning }
  if (activeAdapter instanceof MockAdapter) activeAdapter.setTuning({ ...state.tuning })
  log('info', `载入模拟预设：${preset.label} —— ${preset.desc}`, '模拟')
}

function patchTuning(patch: Partial<MockTuning>): void {
  Object.assign(state.tuning, patch)
  state.selectedPresetKey = 'custom'
  if (activeAdapter instanceof MockAdapter) activeAdapter.setTuning({ ...state.tuning })
}

async function setMockTarget(deviceId: string): Promise<void> {
  if (state.connection === 'connected' || state.connection === 'connecting') return
  if (deviceId === state.mockTarget) return
  state.mockTarget = deviceId
  if (activeAdapter instanceof MockAdapter) {
    activeAdapter.switchTarget(deviceId)
  } else if (state.mode === 'mock' && !activeAdapter) {
    // 尚未建立适配器，connect 时会使用新目标
  }
  log('info', `模拟目标切换为 ${deviceId}（连接后生效）。`, '模拟')
}

function mockInjectForeign(): void {
  if (activeAdapter instanceof MockAdapter) activeAdapter.injectForeignReceipt()
}
function mockForceDrop(): void {
  if (activeAdapter instanceof MockAdapter) activeAdapter.forceDropNow()
}
function mockReboot(): void {
  if (activeAdapter instanceof MockAdapter) activeAdapter.simulateReboot()
}

const btSupport = checkWebBluetoothSupport()

const canSubmit = computed(
  () =>
    state.connection === 'connected' &&
    !!state.info &&
    !state.pending &&
    !state.working
)

const isMockConnected = computed(
  () => state.mode === 'mock' && state.connection === 'connected'
)

export function useController() {
  return {
    state,
    canSubmit,
    isMockConnected,
    btSupport,
    presets: MOCK_PRESETS,
    mockDevices: [
      { id: MOCK_DEVICE_A, label: '模拟设备 A' },
      { id: MOCK_DEVICE_B, label: '模拟设备 B' }
    ],
    connect,
    disconnect,
    reconnect,
    reread,
    submitCommand,
    dismissResult,
    abandonUnknown,
    useDraftConfirmedValue,
    setMode,
    selectPreset,
    patchTuning,
    setMockTarget,
    mockInjectForeign,
    mockForceDrop,
    mockReboot
  }
}
