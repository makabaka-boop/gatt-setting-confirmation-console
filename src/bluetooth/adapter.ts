import type { CommandRequest, DeviceInfo, Receipt } from './protocol'

/** 连接生命周期状态。每次（重新）连接成功都会产生新的 sessionId。 */
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting'

export interface AdapterEvents {
  /** GATT 链路断开（意外或手动）。reason 用于日志展示。 */
  disconnect: (reason: string) => void
  /**
   * 回执特征通知。通知只对其所属会话有效：
   * 重连前会话迟到的通知必须按旧通知丢弃，重连后的对账只走 readLastReceipt()。
   */
  receipt: (receipt: Receipt) => void
}

/**
 * 真实 GATT 连接与内存模拟共用同一个接口，页面逻辑对两者无感知。
 */
export interface ControllerAdapter {
  readonly kind: 'real' | 'simulated'
  /** 稳定设备身份（真实设备为浏览器分配的 device id，模拟为 sim:<id>）。 */
  readonly identity: string
  /** 展示名。 */
  readonly label: string
  readonly state: ConnectionState
  /** 首次为 0；每次成功（重新）连接后 +1。 */
  readonly sessionId: number
  /** 该适配器是否曾经选过/拥有设备（决定按钮是"连接"还是"重连"）。 */
  readonly hasDevice: boolean

  connect(): Promise<void>
  reconnect(): Promise<void>
  disconnect(): Promise<void>

  /** 读取信息特征——已确认值、修订、bootId 的唯一事实来源。 */
  readInfo(): Promise<DeviceInfo>
  /** 读取回执特征中设备保存的最近一条回执；设备没有回执时返回 null。 */
  readLastReceipt(): Promise<Receipt | null>
  /**
   * 写命令特征。Promise 完成仅表示字节已被对端接收（writeValueWithResponse），
   * 绝不代表设定值已被采纳——采纳与否以回执为准。
   */
  writeCommand(cmd: CommandRequest): Promise<void>

  on<K extends keyof AdapterEvents>(event: K, handler: AdapterEvents[K]): () => void
}
