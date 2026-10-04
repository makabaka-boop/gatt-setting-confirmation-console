import type {
  AdapterEvents,
  CommandRequest,
  ControllerAdapter,
  DeviceInfo,
  MockTuning,
  Receipt
} from './types'

/**
 * 可控模拟适配器：不依赖真实硬件即可完整演示
 * 「通知先于写入完成」「写入后断线」「回执遗失」「重启后迟到通知」等情形。
 * 与 RealBleAdapter 实现同一 ControllerAdapter 接口。
 *
 * 两台模拟设备（A/B）的状态分桶保存：切换设备后，旧设备迟到的通知只带
 * 旧 deviceId / commandId，无法改写当前设备的确认值。
 */

export const MOCK_DEVICE_A = 'MOCK-CTRL-A-001'
export const MOCK_DEVICE_B = 'MOCK-CTRL-B-002'

interface MockDeviceState {
  deviceId: string
  firmwareRevision: string
  bootId: number
  revision: number
  setpoint: number
  lastReceipt: Receipt | null
}

interface LastSent {
  commandId: number
  bootIdAtSend: number
  setpoint: number
}

type Handler<T> = (event: T) => void

const FIRMWARE = 'fw-1.4.2-demo'

/** 模块级持久桶：切换/重连后设备状态仍然在（真实设备掉电前也会保留状态） */
const registry = new Map<string, MockDeviceState>()

function loadOrCreate(deviceId: string): MockDeviceState {
  let s = registry.get(deviceId)
  if (!s) {
    s = {
      deviceId,
      firmwareRevision: FIRMWARE,
      bootId: 1,
      revision: 1,
      setpoint: 20,
      lastReceipt: null
    }
    registry.set(deviceId, s)
  }
  return s
}

function cloneInfo(s: MockDeviceState): DeviceInfo {
  return {
    deviceId: s.deviceId,
    firmwareRevision: s.firmwareRevision,
    bootId: s.bootId,
    revision: s.revision,
    setpoint: s.setpoint,
    lastReceipt: s.lastReceipt ? { ...s.lastReceipt } : null
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class MockAdapter implements ControllerAdapter {
  readonly mode = 'mock' as const
  private target: string
  private state: MockDeviceState | null = null
  private tuning: MockTuning
  private connectedFlag = false
  /** 每次（重新）连接递增；上一连接周期定时器触发的事件一律作废 */
  private connectionEpoch = 0
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private lastSent: LastSent | null = null
  private handlers: { [K in keyof AdapterEvents]: Set<Handler<AdapterEvents[K]>> } = {
    receipt: new Set(),
    disconnect: new Set(),
    warn: new Set()
  }

  constructor(target: string, tuning: MockTuning) {
    this.target = target
    this.tuning = tuning
  }

  get connected(): boolean {
    return this.connectedFlag
  }

  setTuning(tuning: MockTuning): void {
    this.tuning = tuning
  }

  switchTarget(deviceId: string): void {
    if (this.connectedFlag) throw new Error('请先断开再切换模拟设备')
    this.target = deviceId
    this.lastSent = null
  }

  on<K extends keyof AdapterEvents>(
    type: K,
    handler: Handler<AdapterEvents[K]>
  ): () => void {
    const set = this.handlers[type] as Set<Handler<AdapterEvents[K]>>
    set.add(handler)
    return () => set.delete(handler)
  }

  private emit<K extends keyof AdapterEvents>(type: K, event: AdapterEvents[K]): void {
    for (const h of this.handlers[type]) h(event)
  }

  private armTimer(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(fn, ms)
    this.timers.add(t)
    return t
  }

  async connect(): Promise<void> {
    if (this.connectedFlag) return
    // 模拟真实连接流程：取/创状态（可能重启），随后由调用方重新发现并读取
    const s = loadOrCreate(this.target)
    if (this.tuning.rebootBeforeReconnect) {
      s.bootId += 1
      this.emit('warn', `模拟设备 ${s.deviceId} 已重启，bootId 变为 ${s.bootId}`)
    }
    this.state = s
    await sleep(250)
    this.connectedFlag = true
    this.connectionEpoch += 1

    if (this.tuning.staleLateNotifyOnReconnect && this.lastSent) {
      // 设备重连后“迟到”地补发重启前那一拍的通知
      const stale: Receipt = {
        commandId: this.lastSent.commandId,
        bootId: this.lastSent.bootIdAtSend,
        status: 'ok',
        revision: s.revision,
        setpoint: this.lastSent.setpoint
      }
      const epoch = this.connectionEpoch
      this.armTimer(350, () => {
        if (!this.connectedFlag || epoch !== this.connectionEpoch) return
        this.emit('warn', '迟到通知：设备补发了重启前 boot 的回执')
        this.emit('receipt', stale)
      })
    }
  }

  async readInfo(): Promise<DeviceInfo> {
    if (!this.connectedFlag || !this.state) throw new Error('尚未连接')
    await sleep(120)
    return cloneInfo(this.state)
  }

  async sendCommand(cmd: CommandRequest): Promise<void> {
    if (!this.connectedFlag || !this.state) throw new Error('尚未连接')
    const s = this.state
    const epoch = this.connectionEpoch
    this.lastSent = {
      commandId: cmd.commandId,
      bootIdAtSend: s.bootId,
      setpoint: cmd.setpoint
    }

    const live = (): boolean =>
      this.connectedFlag && this.state === s && epoch === this.connectionEpoch

    // t_exec：设备侧执行（更新实际值 / 保存回执）
    if (this.tuning.execDelayMs !== null) {
      this.armTimer(this.tuning.execDelayMs, () => {
        if (!live()) return
        if (this.tuning.behavior === 'apply') {
          s.revision += 1
          s.setpoint = cmd.setpoint
          if (!this.tuning.forgetReceipt) {
            s.lastReceipt = {
              commandId: cmd.commandId,
              bootId: s.bootId,
              status: 'ok',
              revision: s.revision,
              setpoint: s.setpoint
            }
          }
        } else {
          // 冲突 / 拒绝：不采用新值，回执带回设备实际修订与实际值
          s.lastReceipt = {
            commandId: cmd.commandId,
            bootId: s.bootId,
            status: this.tuning.behavior === 'conflict' ? 'conflict' : 'rejected',
            revision: s.revision,
            setpoint: s.setpoint
          }
        }
      })
    }

    // t_notify：通知特征发出执行回执
    if (this.tuning.notifyDelayMs !== null) {
      this.armTimer(this.tuning.notifyDelayMs, () => {
        if (!live() || !s.lastReceipt || s.lastReceipt.commandId !== cmd.commandId) return
        this.emit('receipt', { ...s.lastReceipt })
      })
    }

    // t_drop：模拟意外断线
    if (this.tuning.dropDelayMs !== null) {
      this.armTimer(this.tuning.dropDelayMs, () => {
        if (!live()) return
        this.emit('warn', '模拟链路在命令处理期间意外断开')
        this.doDisconnect(false)
      })
    }

    // t_write：writeValueWithResponse 的 Promise 仅在此时刻兑现“字节已写入”
    await sleep(this.tuning.writeDelayMs)
    if (!live()) {
      throw new Error('写入完成前连接已断开：设备是否收到命令未知')
    }
  }

  /** 演示按钮：立刻注入一条“别的设备”的旧通知，用于验证不会污染当前确认值 */
  injectForeignReceipt(): void {
    if (!this.connectedFlag || !this.state) return
    const foreign: Receipt = {
      commandId: 0xdeadbeef >>> 0,
      bootId: (this.state.bootId + 99) >>> 0,
      status: 'ok',
      revision: 9999,
      setpoint: -777
    }
    this.emit('warn', '注入一条来自其他设备/旧会话的通知（应被忽略）')
    this.emit('receipt', foreign)
  }

  /** 演示按钮：立刻模拟设备重启（不换连接周期，bootId +1，状态保留） */
  simulateReboot(): void {
    if (!this.state) return
    this.state.bootId += 1
    this.emit('warn', `模拟设备重启，bootId 变为 ${this.state.bootId}`)
  }

  forceDropNow(): void {
    if (this.connectedFlag) this.doDisconnect(false)
  }

  private doDisconnect(expected: boolean): void {
    this.connectionEpoch += 1
    this.connectedFlag = false
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.emit('disconnect', { expected })
  }

  async disconnect(): Promise<void> {
    if (this.connectedFlag) this.doDisconnect(true)
  }
}
