import {
  COMMAND_CHARACTERISTIC,
  CONTROLLER_SERVICE,
  INFO_CHARACTERISTIC,
  RECEIPT_CHARACTERISTIC,
  type CommandRequest,
  type DeviceInfo,
  type Receipt,
  decodeInfo,
  decodeReceipt,
  encodeCommand,
} from './protocol'
import type { AdapterEvents, ConnectionState, ControllerAdapter } from './adapter'

/** Web Bluetooth 可能不在 TS DOM lib 中，这里只声明本文件用到的最小形状。 */
interface BluetoothRemoteGATTCharacteristicLike extends EventTarget {
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike>
  readValue(): Promise<DataView>
  writeValueWithValue?(value: BufferSource): Promise<unknown>
  writeValue?(value: BufferSource): Promise<unknown>
  value?: DataView
}

interface BluetoothRemoteGATTServerLike {
  device: BluetoothDeviceLike
  connected: boolean
  connect(): Promise<BluetoothRemoteGATTServerLike>
  disconnect(): void
  getPrimaryService(service: string): Promise<{
    getCharacteristic(characteristic: string): Promise<BluetoothRemoteGATTCharacteristicLike>
  }>
}

interface BluetoothDeviceLike extends EventTarget {
  id: string
  name?: string
  gatt?: BluetoothRemoteGATTServerLike
}

interface BluetoothLike {
  requestDevice(options: {
    filters?: Array<{ services?: string[]; namePrefix?: string }>
    optionalServices?: string[]
  }): Promise<BluetoothDeviceLike>
}

export function isWebBluetoothAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'bluetooth' in navigator &&
    typeof (navigator as unknown as { bluetooth?: unknown }).bluetooth === 'object'
  )
}

export class RealBluetoothAdapter implements ControllerAdapter {
  readonly kind = 'real' as const

  private device: BluetoothDeviceLike | null = null
  private infoChar: BluetoothRemoteGATTCharacteristicLike | null = null
  private commandChar: BluetoothRemoteGATTCharacteristicLike | null = null
  private receiptChar: BluetoothRemoteGATTCharacteristicLike | null = null

  private _state: ConnectionState = 'idle'
  private _sessionId = 0
  private listeners: { [K in keyof AdapterEvents]: Set<AdapterEvents[K]> } = {
    disconnect: new Set(),
    receipt: new Set(),
  }
  private disconnectHandler: (() => void) | null = null
  private receiptHandler: (() => void) | null = null
  /** 当前会话是否已上报过断开，避免事件与显式 disconnect() 重复。 */
  private disconnectAnnounced = false

  get identity(): string {
    return this.device ? `real:${this.device.id}` : 'real:<none>'
  }
  get label(): string {
    return this.device?.name ? `真实设备 · ${this.device.name}` : '真实设备（未选择）'
  }
  get state(): ConnectionState {
    return this._state
  }
  get sessionId(): number {
    return this._sessionId
  }
  get hasDevice(): boolean {
    return this.device !== null
  }

  on<K extends keyof AdapterEvents>(event: K, handler: AdapterEvents[K]): () => void {
    this.listeners[event].add(handler)
    return () => this.listeners[event].delete(handler)
  }

  private emit<K extends keyof AdapterEvents>(event: K, ...args: Parameters<AdapterEvents[K]>): void {
    this.listeners[event].forEach((h) => (h as (...a: unknown[]) => void)(...args))
  }

  async connect(): Promise<void> {
    if (!isWebBluetoothAvailable()) {
      throw new Error('当前浏览器不支持 Web Bluetooth API（或非安全上下文 https/localhost）')
    }
    if (!this.device) {
      this._state = 'connecting'
      const bluetooth = (navigator as unknown as { bluetooth: BluetoothLike }).bluetooth
      this.device = await bluetooth.requestDevice({
        filters: [{ services: [CONTROLLER_SERVICE] }],
      })
    }
    await this.openGatt('connecting')
  }

  async reconnect(): Promise<void> {
    if (!this.device) {
      await this.connect()
      return
    }
    await this.openGatt('reconnecting')
  }

  /**
   * 每次（重新）连接都完整重新发现服务与特征——
   * 重连后不缓存旧句柄、不依赖旧通知订阅。
   */
  private async openGatt(entering: 'connecting' | 'reconnecting'): Promise<void> {
    if (!this.device?.gatt) throw new Error('设备没有 GATT 服务')
    this._state = entering
    const server = await this.device.gatt.connect()

    const service = await server.getPrimaryService(CONTROLLER_SERVICE)
    const [infoChar, commandChar, receiptChar] = await Promise.all([
      service.getCharacteristic(INFO_CHARACTERISTIC),
      service.getCharacteristic(COMMAND_CHARACTERISTIC),
      service.getCharacteristic(RECEIPT_CHARACTERISTIC),
    ])
    this.infoChar = infoChar
    this.commandChar = commandChar
    this.receiptChar = receiptChar

    // 旧句柄上的监听一律清理后重新订阅，杜绝旧会话通知漏入新会话。
    if (this.receiptHandler) {
      this.receiptChar.removeEventListener('characteristicvaluechanged', this.receiptHandler)
    }
    this.receiptHandler = () => {
      const dv = this.receiptChar?.value
      if (!dv) return
      try {
        const receipt = decodeReceipt(dv)
        if (receipt) this.emit('receipt', receipt)
      } catch {
        /* 畸形通知忽略 */
      }
    }
    this.receiptChar.addEventListener('characteristicvaluechanged', this.receiptHandler)
    await this.receiptChar.startNotifications()

    if (this.disconnectHandler) {
      this.device.removeEventListener('gattserverdisconnected', this.disconnectHandler)
    }
    this.disconnectHandler = () => {
      // 仅在当前会话仍被视为已连接时上报一次。
      if (this._state === 'connected' && !this.disconnectAnnounced) {
        this.disconnectAnnounced = true
        this._state = 'idle'
        this.emit('disconnect', 'GATT 链路断开')
      }
    }
    this.device.addEventListener('gattserverdisconnected', this.disconnectHandler)

    this._sessionId += 1
    this.disconnectAnnounced = false
    this._state = 'connected'
  }

  async disconnect(): Promise<void> {
    if (this.device?.gatt?.connected) {
      // 先摘掉监听，使显式断开不产生"意外断线"语义以外的重复事件；
      // 但未决命令仍由 store 在调用前后按同一规则处理。
      this.device.gatt.disconnect()
    }
    this._state = 'idle'
    this.emit('disconnect', '手动断开')
  }

  async readInfo(): Promise<DeviceInfo> {
    if (!this.infoChar) throw new Error('未连接')
    return decodeInfo(await this.infoChar.readValue())
  }

  async readLastReceipt(): Promise<Receipt | null> {
    if (!this.receiptChar) throw new Error('未连接')
    return decodeReceipt(await this.receiptChar.readValue())
  }

  async writeCommand(cmd: CommandRequest): Promise<void> {
    if (!this.commandChar) throw new Error('未连接')
    const payload = encodeCommand(cmd)
    // 优先新版 writeValueWithValue；其 resolve 仅表示 ATT 写事务完成。
    if (typeof this.commandChar.writeValueWithValue === 'function') {
      await this.commandChar.writeValueWithValue(payload)
    } else if (typeof this.commandChar.writeValue === 'function') {
      await this.commandChar.writeValue(payload)
    } else {
      throw new Error('当前平台不支持写命令特征')
    }
  }
}
