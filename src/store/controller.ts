import { markRaw, reactive } from 'vue'
import type { ControllerAdapter } from '../bluetooth/adapter'
import {
  RealBluetoothAdapter,
  isWebBluetoothAvailable,
} from '../bluetooth/real-adapter'
import {
  SimulatedControllerAdapter,
  type ScenarioId,
  scenarioLabel,
} from '../bluetooth/sim-adapter'
import {
  VALUE_MAX,
  VALUE_MIN,
  type DeviceInfo,
  type Receipt,
  receiptStatusText,
} from '../bluetooth/protocol'

export type Mode = 'sim' | 'real'
export type CommandPhase = 'sending' | 'written' | 'acked' | 'rejected' | 'unknown'

/**
 * 一条命令的完整记录。draft 是"想写的值"，任何阶段都不会被当成已确认值。
 */
export interface CommandRecord {
  commandId: number
  draft: number
  expectedRevision: number
  phase: CommandPhase
  receipt: Receipt | null
  note: string
  createdAt: number
  deviceIdentity: string
  /** 发起时所在会话与 boot，用于拒绝旧会话/旧 boot 的迟到通知。 */
  sessionId: number
  bootId: bigint
}

export interface LogEntry {
  id: number
  time: string
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
}

const PHASE_TEXT: Record<CommandPhase, string> = {
  sending: '写入中…',
  written: '字节已写入 · 等待回执',
  acked: '设备已确认采纳',
  rejected: '设备未采纳',
  unknown: '结果未知',
}

export function phaseText(p: CommandPhase): string {
  return PHASE_TEXT[p]
}

const MAX_LOGS = 300

class ControllerStore {
  mode: Mode = 'sim'
  readonly webBluetoothAvailable = isWebBluetoothAvailable()

  /**
   * 适配器含事件目标/原生句柄等非数据对象，标记为 raw 避免被响应式代理；
   * 字段本身的赋值仍会被外层 store 代理追踪。
   */
  adapter: ControllerAdapter | null = null
  private offHandlers: Array<() => void> = []

  connectionState = 'idle' as ControllerAdapter['state']
  connecting = false
  /** 当前会话编号，取自适配器；用于识别新旧会话。 */
  sessionId = 0
  deviceIdentity = ''
  deviceLabel = ''

  // —— 以下四项来自信息特征，是"设备实际状态"的唯一来源 ——
  deviceId = ''
  bootId: bigint | null = null
  revision: number | null = null
  confirmedValue: number | null = null

  /** 重连后读到的、设备保存的最近回执。 */
  lastReadReceipt: Receipt | null = null
  receiptCheckedAt = ''

  /** 草稿：仅存在于页面，未经设备回执确认前永远不是实际值。 */
  draft = 0

  command: CommandRecord | null = null
  private commandCounter = 1

  error = ''
  refreshing = false

  logs = reactive<LogEntry[]>([])
  private logCounter = 1

  simScenario: ScenarioId = 'normal'
  readonly scenarioOptions = Object.entries(SCENARIO_LABEL_CACHE).map(([id, label]) => ({
    id: id as ScenarioId,
    label,
  }))

  get isConnected(): boolean {
    return this.connectionState === 'connected'
  }
  get hasPending(): boolean {
    return this.command !== null && (this.command.phase === 'sending' || this.command.phase === 'written')
  }
  get hasUnresolved(): boolean {
    return this.command?.phase === 'unknown'
  }

  /**
   * 发起新修改的闸门：
   *  - 必须已连接且已知修订；
   *  - 同时最多一个未决命令；
   *  - "结果未知"的命令必须由用户手动关闭后才能再发（绝不自动重发）。
   */
  get canApply(): boolean {
    return (
      this.isConnected &&
      this.revision !== null &&
      !(
        this.command &&
        (this.command.phase === 'sending' ||
          this.command.phase === 'written' ||
          this.command.phase === 'unknown')
      )
    )
  }

  // ---------- 日志 ----------

  private log(level: LogEntry['level'], message: string): void {
    this.logs.unshift({
      id: this.logCounter++,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }) +
        '.' + String(new Date().getMilliseconds()).padStart(3, '0'),
      level,
      message,
    })
    if (this.logs.length > MAX_LOGS) this.logs.length = MAX_LOGS
  }
  info(msg: string): void {
    this.log('info', msg)
  }

  clearLogs(): void {
    this.logs.splice(0)
  }

  // ---------- 适配器 ----------

  setMode(mode: Mode): void {
    if (mode === this.mode) return
    if (this.isConnected) {
      this.error = '请先断开当前设备，再切换模式或设备。'
      return
    }
    this.detachAdapter()
    this.mode = mode
    this.resetSessionView()
    this.command = null
    this.error = mode === 'real' && !this.webBluetoothAvailable
      ? '此浏览器/上下文不可用 Web Bluetooth API：需要 Chrome/Edge 等 Chromium 浏览器，并在 https 或 localhost 下打开。'
      : ''
    this.log('info', mode === 'sim' ? '已切换到模拟适配器（无需硬件）。' : '已切换到真实连接模式。')
  }

  private attachAdapter(adapter: ControllerAdapter): void {
    this.detachAdapter()
    this.adapter = markRaw(adapter)
    const receiptOff = adapter.on('receipt', (r) => this.handleNotification(adapter, r))
    const disconnectOff = adapter.on('disconnect', (reason) => this.handleDisconnect(adapter, reason))
    this.offHandlers = [receiptOff, disconnectOff]
  }

  private detachAdapter(): void {
    this.offHandlers.forEach((off) => off())
    this.offHandlers = []
    this.adapter = null
  }

  private resetSessionView(): void {
    this.connectionState = 'idle'
    this.sessionId = 0
    this.deviceIdentity = ''
    this.deviceLabel = ''
    this.deviceId = ''
    this.bootId = null
    this.revision = null
    this.confirmedValue = null
    this.lastReadReceipt = null
    this.receiptCheckedAt = ''
  }

  // ---------- 连接 ----------

  async connectSim(deviceId: string): Promise<void> {
    if (this.connecting || this.isConnected) return
    this.error = ''
    const adapter = new SimulatedControllerAdapter(deviceId)
    adapter.scenario = this.simScenario
    this.attachAdapter(adapter)
    await this.openConnection(adapter, false, `选择模拟设备 ${deviceId}`)
  }

  async connectReal(): Promise<void> {
    if (!this.webBluetoothAvailable) {
      this.error = 'Web Bluetooth API 不可用：请使用桌面版 Chrome/Edge，并通过 https 或 localhost 访问本页。'
      this.log('error', this.error)
      return
    }
    if (this.connecting || this.isConnected) return
    this.error = ''
    const adapter = new RealBluetoothAdapter()
    this.attachAdapter(adapter)
    await this.openConnection(adapter, false, '用户选择真实蓝牙设备')
  }

  async reconnect(): Promise<void> {
    const adapter = this.adapter
    if (!adapter || this.connecting || this.isConnected) return
    this.error = ''
    await this.openConnection(adapter, true, `重连 ${adapter.label}`)
  }

  private async openConnection(
    adapter: ControllerAdapter,
    isReconnect: boolean,
    actionLabel: string,
  ): Promise<void> {
    this.connecting = true
    this.connectionState = isReconnect ? 'reconnecting' : 'connecting'
    this.log('info', `${actionLabel}：开始${isReconnect ? '重新' : ''}连接…`)
    try {
      if (isReconnect) await adapter.reconnect()
      else await adapter.connect()

      // 重连后必须重新发现服务与特征（适配器内部完成），再读取实际状态。
      const info = await adapter.readInfo()
      const previousIdentity = this.deviceIdentity
      const identityChanged = previousIdentity !== '' && previousIdentity !== adapter.identity

      this.connectionState = 'connected'
      this.connecting = false
      this.sessionId = adapter.sessionId
      this.deviceIdentity = adapter.identity
      this.deviceLabel = adapter.label
      this.applyInfo(info)
      this.log(
        'success',
        `${isReconnect ? '重连' : '连接'}成功（会话 #${adapter.sessionId}）：` +
          `deviceId=${info.deviceId}，bootId=${info.bootId.toString(16)}，` +
          `修订 r${info.revision}，实际设定值=${info.value}`,
      )
      if (identityChanged) {
        this.log('warn', `注意：当前连接的设备与上次不同（${previousIdentity} → ${adapter.identity}）。`)
      }

      // 新设备首次接入或换设备：草稿以设备实际值为起点（草稿仍是独立的）。
      if (previousIdentity !== adapter.identity) this.draft = info.value

      // 读取设备保存的最近回执并尝试对账。
      await this.reconcileAfterConnect(adapter, info)
    } catch (e) {
      this.connecting = false
      this.connectionState = adapter.state
      this.error = `连接失败：${(e as Error).message}`
      this.log('error', this.error)
    }
  }

  private applyInfo(info: DeviceInfo): void {
    const bootChanged = this.bootId !== null && this.bootId !== info.bootId && this.deviceId === info.deviceId
    this.deviceId = info.deviceId
    this.bootId = info.bootId
    this.revision = info.revision
    this.confirmedValue = info.value
    if (bootChanged) {
      this.log('warn', `检测到设备重启：bootId 已变为 ${info.bootId.toString(16)}。`)
    }
  }

  /**
   * 重连/连接后：读取设备保存的最近回执。
   * 仅当它与当前未决命令（同设备、同 commandId、且结果未知）匹配时才用于对账；
   * 查不到匹配回执时：保持"结果未知"，不自动重发，也不宣称失败。
   */
  private async reconcileAfterConnect(adapter: ControllerAdapter, info: DeviceInfo): Promise<void> {
    let receipt: Receipt | null = null
    try {
      receipt = await adapter.readLastReceipt()
    } catch (e) {
      this.lastReadReceipt = null
      this.log('error', `读取设备保存的回执失败：${(e as Error).message}`)
      return
    }
    this.lastReadReceipt = receipt
    this.receiptCheckedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false })

    if (receipt) {
      this.log(
        'info',
        `设备保存的最近回执：命令 #${receipt.commandId}，${receiptStatusText(receipt.status)}，` +
          `r${receipt.revision}，值=${receipt.value}，boot=${receipt.bootId.toString(16)}`,
      )
    } else {
      this.log('info', '设备上读不到已保存的回执（该设备从未产生过回执或回执已丢失）。')
    }

    const cmd = this.command
    if (!cmd || cmd.phase !== 'unknown' || cmd.deviceIdentity !== adapter.identity) {
      if (cmd?.phase === 'unknown') {
        this.log('info', `未决命令属于另一台设备（${cmd.deviceIdentity}），不参与本次对账。`)
      }
      return
    }

    if (receipt && receipt.commandId === cmd.commandId) {
      const fromOldBoot = receipt.bootId !== info.bootId
      cmd.receipt = receipt
      if (receipt.status === 0) {
        cmd.phase = 'acked'
        // 已确认值以刚读取的信息特征为准。
        cmd.note =
          `重连后对账成功：设备保存的回执显示命令 #${cmd.commandId} 已采纳` +
          `${fromOldBoot ? `（回执来自重启前的 boot ${receipt.bootId.toString(16)}）` : ''}；` +
          `实际值=${info.value}，修订 r${info.revision}。`
        this.log('success', cmd.note)
      } else {
        cmd.phase = 'rejected'
        cmd.note = `重连后对账：设备保存的回执为「${receiptStatusText(receipt.status)}」，命令未采纳；实际值=${info.value}。`
        this.log('warn', cmd.note)
      }
    } else {
      cmd.note +=
        ` 重连后${receipt ? '读到的是其他命令的回执' : '读不到任何回执'}，结果仍属未知：` +
        '不会自动重发命令，也不据此判定失败；请读取实际值后由你手动决定下一步。'
      this.log('warn', `命令 #${cmd.commandId} 未找到匹配的设备回执，保持「结果未知」，未自动重发。`)
    }
  }

  async refresh(): Promise<void> {
    const adapter = this.adapter
    if (!adapter || !this.isConnected || this.refreshing) return
    this.refreshing = true
    try {
      const info = await adapter.readInfo()
      const revisionChanged = info.revision !== this.revision
      const valueChanged = info.value !== this.confirmedValue
      this.applyInfo(info)
      this.log(
        revisionChanged || valueChanged ? 'warn' : 'info',
        `手动读取信息特征：实际值=${info.value}，修订 r${info.revision}` +
          (revisionChanged ? '（修订已变化，可能有他端修改）' : ''),
      )
    } catch (e) {
      this.log('error', `读取信息特征失败：${(e as Error).message}`)
    } finally {
      this.refreshing = false
    }
  }

  async disconnect(): Promise<void> {
    const adapter = this.adapter
    if (!adapter) return
    this.log('info', '手动断开连接…')
    try {
      await adapter.disconnect()
    } finally {
      this.handleDisconnect(adapter, '手动断开', true)
    }
  }

  // ---------- 命令 ----------

  setDraft(value: number): void {
    this.draft = value
  }

  /** 用户手动发起一次修改。 */
  async apply(): Promise<void> {
    const adapter = this.adapter
    if (!adapter || !this.isConnected || this.revision === null) {
      this.error = '尚未连接，无法发起修改。'
      return
    }
    if (this.command && (this.command.phase === 'sending' || this.command.phase === 'written')) {
      this.error = '已有一个未决命令，请等待其结果。'
      return
    }
    if (this.command?.phase === 'unknown') {
      this.error = '上一条命令结果未知，请先手动关闭该记录并核对实际值后再决定是否重发。'
      return
    }

    const value = Math.trunc(this.draft)
    if (!Number.isFinite(value)) {
      this.error = '请输入整数设定值。'
      return
    }
    if (value < VALUE_MIN || value > VALUE_MAX) {
      this.error = `设定值超出设备允许范围（${VALUE_MIN}…${VALUE_MAX}），仍可写入让设备演示拒绝回执。`
      // 允许写入：固件会以 OutOfRange 回执演示拒绝路径。
    } else {
      this.error = ''
    }

    const commandId = this.commandCounter++ >>> 0
    const cmd: CommandRecord = {
      commandId,
      draft: value,
      expectedRevision: this.revision,
      phase: 'sending',
      receipt: null,
      note: `命令 #${commandId} 正在写入（草稿值=${value}，预期修订 r${this.revision}）。`,
      createdAt: Date.now(),
      deviceIdentity: adapter.identity,
      sessionId: adapter.sessionId,
      bootId: this.bootId ?? 0n,
    }
    this.command = cmd
    // 后续一律走响应式代理引用：原始对象与 this.command 不是同一引用，
    // 用它做身份判断会误判为"命令已被替换"。
    const live = this.command
    this.log('info', `→ 发送命令 #${commandId}：预期 r${live.expectedRevision}，新值=${value}`)
    this.log('info', '调用 writeValueWithResponse：其完成只代表字节写入，不代表修改成功。')

    try {
      await adapter.writeCommand({
        commandId,
        expectedRevision: live.expectedRevision,
        newValue: value,
      })
      if (this.command !== live) return // 已被切换/关闭
      if (live.phase === 'sending') {
        live.phase = 'written'
        live.note = `命令 #${commandId} 的字节已写入（会话 #${live.sessionId}），等待设备回执；此时实际值尚未确认。`
        this.log('info', `← 写事务完成（命令 #${commandId}）：仅表示字节送达，继续等待回执通知。`)
      } else if (live.phase === 'written') {
        // 极端时序下可能已被其他路径推进。
        this.log('info', `写事务完成（命令 #${commandId}），仍在等待回执。`)
      } else if (live.phase === 'unknown') {
        // 写入 resolve 前链路已断开，断线处理已将其标记为结果未知。
        this.log('warn', `写事务随后完成（命令 #${commandId}），但链路此前已断开，保持「结果未知」。`)
      } else {
        // notify-first 场景：回执已在写入完成前到达并完成确认。
        this.log('success', `写事务随后完成（命令 #${commandId}）：通知先到，确认结果以回执为准。`)
      }
    } catch (e) {
      if (this.command !== live) return
      if (this.connectionState === 'connected') {
        live.phase = 'rejected'
        live.note = `写事务失败：${(e as Error).message}。设备在 ATT 层未受理该命令（未获得设备回执）。`
        this.log('error', live.note)
      } else {
        this.markUnknown(live, `写入期间链路断开（${(e as Error).message}），设备是否采纳无法判定。`)
      }
    }
  }

  /** 用户手动关闭已了结/未知的命令记录。 */
  dismissCommand(): void {
    const cmd = this.command
    if (!cmd) return
    if (cmd.phase === 'sending' || cmd.phase === 'written') {
      this.error = '命令尚无结果，不能关闭（断线后将自动转为结果未知）。'
      return
    }
    this.log('info', `已手动关闭命令 #${cmd.commandId} 的记录。`)
    this.command = null
    this.error = ''
  }

  private markUnknown(cmd: CommandRecord, reason: string): void {
    cmd.phase = 'unknown'
    cmd.note =
      `${reason} 该命令标记为「结果未知」：草稿值 ${cmd.draft} 不会被当作设备值；` +
      '可重连后读取设备保存的回执与实际状态，查不到回执也不会自动重发或判定失败。'
    this.log('warn', `命令 #${cmd.commandId} 转为「结果未知」：${reason}`)
  }

  // ---------- 通知与断线事件 ----------

  private handleNotification(adapter: ControllerAdapter, receipt: Receipt): void {
    this.log(
      'info',
      `⚡ 收到回执通知：命令 #${receipt.commandId}，${receiptStatusText(receipt.status)}，` +
        `r${receipt.revision}，值=${receipt.value}，boot=${receipt.bootId.toString(16)}`,
    )

    // 守卫 1：必须来自当前适配器（切换设备后，旧适配器的通知一律无效）。
    if (this.adapter !== adapter) {
      this.log('warn', '丢弃通知：来自已被替换的适配器（可能属于另一台设备）。')
      return
    }
    // 守卫 2：必须在连接中的当前会话内（断线后迟到的旧通知）。
    if (this.connectionState !== 'connected') {
      this.log('warn', '丢弃通知：链路已断开，属于迟到的旧通知，不改动任何确认值。')
      return
    }
    // 守卫 3：必须能绑定到当前未决命令。
    const cmd = this.command
    if (!cmd || cmd.deviceIdentity !== adapter.identity) {
      this.log('warn', '丢弃通知：没有属于当前设备的命令记录。')
      return
    }
    if (cmd.sessionId !== adapter.sessionId) {
      this.log('warn', `丢弃通知：其会话 #${cmd.sessionId} 不是当前会话 #${adapter.sessionId}。`)
      return
    }
    if (receipt.bootId !== cmd.bootId) {
      this.log('warn', '丢弃通知：回执 bootId 与命令发起时不同（疑似重启前的迟到通知）。')
      return
    }
    if (cmd.phase !== 'sending' && cmd.phase !== 'written') {
      this.log('warn', `丢弃通知：命令 #${cmd.commandId} 当前状态为「${phaseText(cmd.phase)}」，无需再处理。`)
      return
    }
    if (receipt.commandId !== cmd.commandId) {
      this.log('warn', `丢弃通知：commandId ${receipt.commandId} 与未决命令 #${cmd.commandId} 不匹配。`)
      return
    }

    void this.settleFromReceipt(adapter, cmd, receipt, '通知')
  }

  /**
   * 用绑定命令的回执了结命令；随后必须再读信息特征复核实际值。
   */
  private async settleFromReceipt(
    adapter: ControllerAdapter,
    cmd: CommandRecord,
    receipt: Receipt,
    source: string,
  ): Promise<void> {
    cmd.receipt = receipt
    try {
      const info = await adapter.readInfo()
      this.applyInfo(info)
      if (receipt.status === 0) {
        cmd.phase = 'acked'
        cmd.note =
          `${source}确认：命令 #${cmd.commandId} 已采纳；` +
          `信息特征复核实际值=${info.value}，修订 r${info.revision}。`
        this.log('success', cmd.note)
        if (info.value !== cmd.draft) {
          this.log('warn', '注意：回执为采纳，但信息特征实际值与草稿不同，以信息特征为准。')
        }
      } else {
        cmd.phase = 'rejected'
        cmd.note =
          `${source}结果：设备「${receiptStatusText(receipt.status)}」，命令 #${cmd.commandId} 未采纳；` +
          `信息特征实际值=${info.value}，修订 r${info.revision}。草稿值 ${cmd.draft} 未生效。`
        this.log('warn', cmd.note)
      }
    } catch (e) {
      // 通知有效但复核读失败：回执数据来自设备且绑定本命令，可据其了结，
      // 但标注确认值未经信息特征复核。
      cmd.phase = receipt.status === 0 ? 'acked' : 'rejected'
      cmd.note =
        `${source}已收到（${receiptStatusText(receipt.status)}），但信息特征复核失败：${(e as Error).message}。` +
        '确认值暂以回执携带数据为准，请稍后手动读取。'
      this.revision = receipt.revision
      this.confirmedValue = receipt.value
      this.log('error', cmd.note)
    }
  }

  private handleDisconnect(adapter: ControllerAdapter, reason: string, intentional = false): void {
    if (this.adapter !== adapter) return
    if (this.connectionState === 'idle') return // 去重
    this.connectionState = 'idle'
    this.connecting = false
    this.log(intentional ? 'info' : 'warn', `链路断开：${reason}`)

    const cmd = this.command
    if (cmd && (cmd.phase === 'sending' || cmd.phase === 'written')) {
      const when = cmd.phase === 'sending' ? '写入过程中' : '字节写入后、回执到达前'
      this.markUnknown(cmd, `断线发生在${when}（${reason}）。`)
    }
  }

  // ---------- 模拟控制台 ----------

  setSimScenario(id: ScenarioId): void {
    this.simScenario = id
    const adapter = this.adapter
    if (adapter instanceof SimulatedControllerAdapter) adapter.scenario = id
    this.log('info', `模拟场景设置为：${scenarioLabel(id)}（影响下一条命令）。`)
  }

  async switchSimDevice(id: string): Promise<void> {
    if (this.isConnected) await this.disconnect()
    const existing = this.adapter
    if (existing instanceof SimulatedControllerAdapter) {
      existing.selectDevice(id)
    } else {
      this.attachAdapter(new SimulatedControllerAdapter(id))
    }
    this.resetSessionView()
    this.command = null
    this.log('info', `已选择模拟设备 ${id}，点击连接开始会话。`)
  }

  simExternalBump(value: number): void {
    const adapter = this.adapter
    if (!(adapter instanceof SimulatedControllerAdapter) || !this.isConnected) return
    adapter.externalBump(value)
    this.log('warn', `模拟他端操作：设备值被改为 ${value}，修订已 +1（下次用旧修订发起将收到冲突回执）。`)
  }

  simReboot(keepReceipt: boolean): void {
    const adapter = this.adapter
    if (!(adapter instanceof SimulatedControllerAdapter) || !this.isConnected) return
    adapter.reboot(keepReceipt, keepReceipt ? '手动重启（设备保留回执）' : '手动重启（设备清空回执）')
  }

  simInjectLate(kind: 'same-device' | 'foreign'): void {
    const adapter = this.adapter
    if (!(adapter instanceof SimulatedControllerAdapter)) return
    this.log('warn', kind === 'same-device'
      ? '故障注入：补发一条旧会话的迟到通知（commandId/会话均不匹配）。'
      : '故障注入：补发一条冒充其他设备的通知。')
    adapter.injectLateReceipt(kind)
  }
}

const SCENARIO_LABEL_CACHE: Record<ScenarioId, string> = {
  normal: scenarioLabel('normal'),
  'notify-first': scenarioLabel('notify-first'),
  'disconnect-after-write': scenarioLabel('disconnect-after-write'),
  'reboot-kept': scenarioLabel('reboot-kept'),
  'reboot-lost': scenarioLabel('reboot-lost'),
  conflict: scenarioLabel('conflict'),
  'out-of-range': scenarioLabel('out-of-range'),
}

export const store = reactive(new ControllerStore()) as ControllerStore
