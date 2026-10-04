import {
  COMMAND_CHAR_UUID,
  INFO_CHAR_UUID,
  NOTIFY_CHAR_UUID,
  SERVICE_UUID,
  decodeInfo,
  decodeReceiptBody,
  encodeCommand
} from './protocol'
import type {
  AdapterEvents,
  CommandRequest,
  ControllerAdapter,
  DeviceInfo,
  Receipt
} from './types'

export interface WebBluetoothSupport {
  available: boolean
  reason: string | null
}

/** 真实模式必须由用户主动选择；进入入口前先明确检查 API */
export function checkWebBluetoothSupport(): WebBluetoothSupport {
  if (typeof navigator === 'undefined' || !('bluetooth' in navigator)) {
    return {
      available: false,
      reason: '当前浏览器不支持 Web Bluetooth API（建议使用桌面/Android 版 Chrome/Edge，并通过 HTTPS 或 localhost 打开页面）。'
    }
  }
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return { available: false, reason: 'Web Bluetooth 要求安全上下文（HTTPS 或 localhost）。' }
  }
  if (typeof navigator.bluetooth.requestDevice !== 'function') {
    return { available: false, reason: 'navigator.bluetooth.requestDevice 不可用。' }
  }
  return { available: true, reason: null }
}

type Handler<T> = (event: T) => void

const OP_TIMEOUT_MS = 8000

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}超时（${OP_TIMEOUT_MS / 1000}s）`)),
      OP_TIMEOUT_MS
    )
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/**
 * 真实硬件适配器：对接自定义 GATT 服务。
 * 每次连接（含重连）都重新 getPrimaryService / getCharacteristic，
 * 不缓存上一连接周期的特征引用。
 */
export class RealBleAdapter implements ControllerAdapter {
  readonly mode = 'real' as const
  private device: BluetoothDevice | null = null
  private chars: {
    info: BluetoothRemoteGATTCharacteristic
    command: BluetoothRemoteGATTCharacteristic
    notify: BluetoothRemoteGATTCharacteristic
  } | null = null
  private handlers: { [K in keyof AdapterEvents]: Set<Handler<AdapterEvents[K]>> } = {
    receipt: new Set(),
    disconnect: new Set(),
    warn: new Set()
  }
  private manualDisconnect = false

  get connected(): boolean {
    return this.device?.gatt?.connected === true
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

  async connect(): Promise<void> {
    const support = checkWebBluetoothSupport()
    if (!support.available) throw new Error(support.reason ?? 'Web Bluetooth 不可用')

    if (!this.device) {
      // 必须由用户手势触发：弹出设备选择器
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID]
      })
      this.device.addEventListener('gattserverdisconnected', this.onGattDisconnected)
    }

    const gatt = this.device.gatt
    if (!gatt) throw new Error('设备没有 GATT 服务')

    this.manualDisconnect = false
    // 重连也走这里：重新发现服务与特征
    await withTimeout(gatt.connect(), 'GATT 连接')
    await this.discover()
  }

  private async discover(): Promise<void> {
    const gatt = this.device!.gatt!
    const service = await withTimeout(gatt.getPrimaryService(SERVICE_UUID), '发现自定义服务')
    const [info, command, notify] = await Promise.all([
      service.getCharacteristic(INFO_CHAR_UUID),
      service.getCharacteristic(COMMAND_CHAR_UUID),
      service.getCharacteristic(NOTIFY_CHAR_UUID)
    ])
    notify.addEventListener('characteristicvaluechanged', this.onNotify)
    await notify.startNotifications()
    this.chars = { info, command, notify }
  }

  private onNotify = (ev: Event): void => {
    const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value
    if (!dv) return
    const receipt: Receipt = decodeReceiptBody(dv)
    this.emit('receipt', receipt)
  }

  private onGattDisconnected = (): void => {
    const expected = this.manualDisconnect
    this.teardownChars()
    this.emit('disconnect', { expected })
  }

  private teardownChars(): void {
    if (this.chars) {
      try {
        this.chars.notify.removeEventListener(
          'characteristicvaluechanged',
          this.onNotify
        )
      } catch {
        /* 特征随连接失效，忽略 */
      }
    }
    this.chars = null
  }

  async readInfo(): Promise<DeviceInfo> {
    if (!this.chars) throw new Error('尚未连接')
    const value = await withTimeout(this.chars.info.readValue(), '读取信息特征')
    return decodeInfo(value)
  }

  async sendCommand(cmd: CommandRequest): Promise<void> {
    if (!this.chars) throw new Error('尚未连接')
    const payload = encodeCommand(cmd)
    // writeValueWithResponse 完成只代表字节已写入，不代表设备已采用新值。
    // 采用结论只看通知回执（或重连后信息特征里设备保存的回执）。
    const writeWithResponse = (this.chars.command as BluetoothRemoteGATTCharacteristic & {
      writeValueWithResponse?: (v: BufferSource) => Promise<void>
    }).writeValueWithResponse
    if (typeof writeWithResponse === 'function') {
      await withTimeout(
        writeWithResponse.call(this.chars.command, payload.buffer as ArrayBuffer),
        '写入命令（带响应）'
      )
    } else {
      this.emit('warn', '浏览器不支持 writeValueWithResponse，回退到 writeValue；语义保证被削弱。')
      await withTimeout(
        this.chars.command.writeValue(payload.buffer as ArrayBuffer),
        '写入命令'
      )
    }
  }

  async disconnect(): Promise<void> {
    this.manualDisconnect = true
    try {
      this.device?.gatt?.disconnect()
    } finally {
      this.teardownChars()
    }
  }
}
