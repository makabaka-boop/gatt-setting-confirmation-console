import {
  ReceiptStatus,
  VALUE_MAX,
  VALUE_MIN,
  type CommandRequest,
  type DeviceInfo,
  type Receipt,
  encodeReceipt,
} from './protocol'
import type { AdapterEvents, ConnectionState, ControllerAdapter } from './adapter'

/**
 * 演示脚本：决定一条命令在固件侧的命运。
 */
export type ScenarioId =
  | 'normal' // 正常：写入完成后回执"已采纳"
  | 'notify-first' // 通知先到：字节写入 resolve 之前先推回执
  | 'disconnect-after-write' // 写入后断线：命令执行了，但回执随链路一起丢
  | 'reboot-kept' // 写入后设备重启：命令已执行，新 boot 仍保存旧 boot 的回执
  | 'reboot-lost' // 写入后设备重启且回执丢失：结果无法判定
  | 'conflict' // 模拟他端抢先改值：预期修订过期 -> 修订冲突
  | 'out-of-range' // 设备判定数值越界 -> 拒绝

interface DeviceModel {
  id: string
  info: DeviceInfo
  /** 设备保存的最近一条回执；null 表示从未有过。 */
  lastReceipt: Receipt | null
}

const SCENARIO_LABEL: Record<ScenarioId, string> = {
  normal: '正常（写入后回执）',
  'notify-first': '通知先到',
  'disconnect-after-write': '写入后断线（回执丢失）',
  'reboot-kept': '写入后重启（保留回执）',
  'reboot-lost': '写入后重启（回执遗失）',
  conflict: '修订冲突（他端抢先修改）',
  'out-of-range': '数值越界',
}

export function scenarioLabel(id: ScenarioId): string {
  return SCENARIO_LABEL[id]
}

let simSequence = 0

export class SimulatedControllerAdapter implements ControllerAdapter {
  readonly kind = 'simulated' as const

  private devices = new Map<string, DeviceModel>()
  private selectedId: string
  private _state: ConnectionState = 'idle'
  private _sessionId = 0

  scenario: ScenarioId = 'normal'

  private listeners: { [K in keyof AdapterEvents]: Set<AdapterEvents[K]> } = {
    disconnect: new Set(),
    receipt: new Set(),
  }

  constructor(initialId = 'SIM-A') {
    this.selectedId = initialId
    this.devices.set(initialId, this.makeDevice(initialId))
  }

  private makeDevice(id: string): DeviceModel {
    const boot = this.randomBootId()
    return {
      id,
      info: { deviceId: id, bootId: boot, revision: 1, value: 0 },
      lastReceipt: null,
    }
  }

  private randomBootId(): bigint {
    simSequence += 1
    // 时间戳 + 自增，保证重启后 bootId 一定变化且可辨识
    return (BigInt(Date.now()) << 16n) | BigInt(simSequence & 0xffff)
  }

  get identity(): string {
    return `sim:${this.selectedId}`
  }
  get label(): string {
    return `模拟控制器 · ${this.selectedId}`
  }
  get state(): ConnectionState {
    return this._state
  }
  get sessionId(): number {
    return this._sessionId
  }
  get hasDevice(): boolean {
    return true
  }
  get deviceIds(): string[] {
    return [...this.devices.keys()]
  }

  /** 仅供 UI 展示固件内部状态。 */
  getDeviceInfoForDisplay(): DeviceInfo {
    return this.current().info
  }
  getLastReceiptForDisplay(): Receipt | null {
    return this.current().lastReceipt
  }

  on<K extends keyof AdapterEvents>(event: K, handler: AdapterEvents[K]): () => void {
    this.listeners[event].add(handler)
    return () => this.listeners[event].delete(handler)
  }

  private emit<K extends keyof AdapterEvents>(event: K, ...args: Parameters<AdapterEvents[K]>): void {
    this.listeners[event].forEach((h) => (h as (...a: unknown[]) => void)(...args))
  }

  private current(): DeviceModel {
    const d = this.devices.get(this.selectedId)
    if (!d) throw new Error('模拟设备不存在')
    return d
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async connect(): Promise<void> {
    this._state = 'connecting'
    await this.delay(200)
    this.openSession()
  }

  async reconnect(): Promise<void> {
    this._state = 'reconnecting'
    await this.delay(250)
    this.openSession()
  }

  private openSession(): void {
    this._sessionId += 1
    this._state = 'connected'
  }

  async disconnect(): Promise<void> {
    this._state = 'idle'
    this.emit('disconnect', '手动断开')
  }

  /** 模拟意外掉线：只发事件，固件内部状态保留。 */
  private dropLink(reason: string): void {
    if (this._state === 'connected') {
      this._state = 'idle'
      this.emit('disconnect', reason)
    }
  }

  async readInfo(): Promise<DeviceInfo> {
    this.assertConnected()
    await this.delay(60)
    return { ...this.current().info }
  }

  async readLastReceipt(): Promise<Receipt | null> {
    this.assertConnected()
    await this.delay(60)
    const r = this.current().lastReceipt
    return r ? { ...r } : null
  }

  async writeCommand(cmd: CommandRequest): Promise<void> {
    this.assertConnected()
    const device = this.current()
    const beforeBoot = device.info.bootId

    switch (this.scenario) {
      case 'notify-first': {
        // 回执通知在写事务完成之前到达（固件处理很快，通知抢在写响应前面）
        await this.delay(50)
        this.applyCommand(device, cmd, beforeBoot, { notify: true })
        await this.delay(90)
        return
      }
      case 'disconnect-after-write': {
        await this.delay(90) // 写事务完成
        // 写事务 resolve 后、通知发出前，链路断开；固件其实已经执行并保存了回执。
        this.afterResolve(() => {
          device.info.value = cmd.newValue
          device.info.revision += 1
          device.lastReceipt = {
            commandId: cmd.commandId,
            status: ReceiptStatus.Applied,
            revision: device.info.revision,
            value: device.info.value,
            bootId: beforeBoot,
          }
          this.dropLink('写入后链路断开（回执未能送达）')
        })
        return
      }
      case 'reboot-kept': {
        await this.delay(90)
        this.afterResolve(() => {
          this.applyCommand(device, cmd, beforeBoot, { notify: false })
          this.rebootInternal(device, { keepReceipt: true, reason: '写入后设备重启（回执保留）' })
        })
        return
      }
      case 'reboot-lost': {
        await this.delay(90)
        this.afterResolve(() => {
          this.applyCommand(device, cmd, beforeBoot, { notify: false })
          this.rebootInternal(device, { keepReceipt: false, reason: '写入后设备重启（回执遗失）' })
        })
        return
      }
      case 'conflict': {
        // 模拟另一个主控在本命令到达前先提交一次修改；写响应先回，通知后到。
        device.info.revision += 1
        await this.delay(80)
        this.afterResolve(() => {
          const receipt: Receipt = {
            commandId: cmd.commandId,
            status: ReceiptStatus.RevisionConflict,
            revision: device.info.revision,
            value: device.info.value,
            bootId: beforeBoot,
          }
          device.lastReceipt = receipt
          this.deliverNotification(receipt)
        })
        return
      }
      case 'out-of-range': {
        await this.delay(80)
        this.afterResolve(() => {
          const receipt: Receipt = {
            commandId: cmd.commandId,
            status: ReceiptStatus.OutOfRange,
            revision: device.info.revision,
            value: device.info.value,
            bootId: beforeBoot,
          }
          device.lastReceipt = receipt
          this.deliverNotification(receipt)
        })
        return
      }
      case 'normal': {
        // 写事务先完成（writeCommand resolve），回执通知在其后的独立任务中到达。
        await this.delay(80)
        this.afterResolve(() => {
          this.applyCommand(device, cmd, beforeBoot, { notify: true })
        })
        return
      }
    }
  }

  /**
   * 在写事务 Promise resolve 之后的独立宏任务中执行固件后续动作，
   * 从而如实模拟"写响应先返回、通知/断线随后发生"的真实链路时序。
   */
  private afterResolve(fn: () => void): void {
    setTimeout(fn, 60)
  }

  /**
   * 固件语义：expectedRevision 必须等于当前修订，值必须在范围内，
   * 采纳后修订 +1 并保存回执。
   */
  private applyCommand(
    device: DeviceModel,
    cmd: CommandRequest,
    bootId: bigint,
    opts: { notify: boolean },
  ): void {
    let receipt: Receipt
    if (cmd.expectedRevision !== device.info.revision) {
      receipt = {
        commandId: cmd.commandId,
        status: ReceiptStatus.RevisionConflict,
        revision: device.info.revision,
        value: device.info.value,
        bootId,
      }
    } else if (cmd.newValue < VALUE_MIN || cmd.newValue > VALUE_MAX) {
      receipt = {
        commandId: cmd.commandId,
        status: ReceiptStatus.OutOfRange,
        revision: device.info.revision,
        value: device.info.value,
        bootId,
      }
    } else {
      device.info.value = cmd.newValue
      device.info.revision += 1
      receipt = {
        commandId: cmd.commandId,
        status: ReceiptStatus.Applied,
        revision: device.info.revision,
        value: device.info.value,
        bootId,
      }
    }
    device.lastReceipt = receipt
    if (opts.notify) this.deliverNotification(receipt)
  }

  private deliverNotification(receipt: Receipt): void {
    // 真实链路行为：已断线则通知永远送不到。
    if (this._state !== 'connected') return
    // 拷贝出一份"线上字节"，模拟 GATT 通知的数据形态
    const bytes = encodeReceipt(receipt).buffer
    const clone = decodeUnchecked(bytes)
    this.emit('receipt', clone)
  }

  private rebootInternal(device: DeviceModel, opts: { keepReceipt: boolean; reason: string }): void {
    device.info = { ...device.info, bootId: this.randomBootId() }
    if (!opts.keepReceipt) device.lastReceipt = null
    this.dropLink(opts.reason)
  }

  private assertConnected(): void {
    if (this._state !== 'connected') throw new Error('模拟设备未连接')
  }

  // ---- 演示控制台使用的额外操作（不属于 ControllerAdapter 必需接口） ----

  /** 切换到另一台模拟设备（未连接时）。 */
  selectDevice(id: string): void {
    if (!this.devices.has(id)) this.devices.set(id, this.makeDevice(id))
    this.selectedId = id
  }

  /** 模拟设备重启，可选择是否保留保存的回执。 */
  reboot(keepReceipt: boolean, reason = '手动触发设备重启'): void {
    const device = this.current()
    device.info = { ...device.info, bootId: this.randomBootId() }
    if (!keepReceipt) device.lastReceipt = null
    this.dropLink(reason)
  }

  /** 模拟另一个主控抢先把值改掉（修订 +1）。 */
  externalBump(newValue: number): void {
    if (this._state !== 'connected') return
    const device = this.current()
    device.info.value = newValue
    device.info.revision += 1
  }

  /**
   * 故障注入：补发一条"迟到的旧通知"。
   * - same-device：内容仍是本设备的，但属于旧会话——store 必须按旧通知丢弃
   * - foreign：冒充另一台设备的身份——切换设备后绝不能改写当前设备
   */
  injectLateReceipt(kind: 'same-device' | 'foreign'): void {
    const current = this.current()
    if (kind === 'same-device') {
      this.emit('receipt', {
        commandId: 0xffffffff >>> 0,
        status: ReceiptStatus.Applied,
        revision: current.info.revision + 99,
        value: 999,
        bootId: current.info.bootId,
      })
      return
    }
    this.emit('receipt', {
      commandId: 0xfffffffe >>> 0,
      status: ReceiptStatus.Applied,
      revision: 777,
      value: -777,
      bootId: this.randomBootId(),
    })
  }
}

function decodeUnchecked(buffer: ArrayBufferLike): Receipt {
  // 通知在真实适配器中来自 DataView；这里简单重建对象以获得独立引用
  const dv = new DataView(buffer)
  return {
    commandId: dv.getUint32(0),
    status: dv.getUint8(4) as ReceiptStatus,
    revision: dv.getUint32(5),
    value: dv.getInt32(9),
    bootId: dv.getBigUint64(13),
  }
}
