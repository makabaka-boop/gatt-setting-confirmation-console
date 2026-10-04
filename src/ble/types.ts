/** 控制器 GATT 对接的共享类型（真实适配器与模拟适配器同接口） */

export type ReceiptStatus = 'ok' | 'conflict' | 'rejected'

/** 通知特征 / 信息特征中携带的执行回执 */
export interface Receipt {
  commandId: number
  /** 回执产生时设备所在的 boot，用于识别重启前的旧通知 */
  bootId: number
  status: ReceiptStatus
  /** 设备当前修订；ok 时为新修订，冲突/拒绝时为设备实际修订 */
  revision: number
  /** 设备当前实际设定值 */
  setpoint: number
}

/** 信息特征读出的设备状态 */
export interface DeviceInfo {
  deviceId: string
  firmwareRevision: string
  /** 每次设备启动递增 */
  bootId: number
  /** 实际设定值的单调修订号 */
  revision: number
  /** 设备当前实际设定值（不是页面草稿） */
  setpoint: number
  /** 设备持久保存的最近一条回执，可能为空（回执遗失） */
  lastReceipt: Receipt | null
}

/** 写入命令特征的负载 */
export interface CommandRequest {
  commandId: number
  expectedRevision: number
  setpoint: number
}

export interface AdapterEvents {
  /** 绑定命令的执行回执（通知特征） */
  receipt: Receipt
  /** 连接断开（手动或意外） */
  disconnect: { expected: boolean }
  /** 适配器层面的提示信息 */
  warn: string
}

export interface ControllerAdapter {
  readonly mode: 'real' | 'mock'
  readonly connected: boolean
  connect(target?: string): Promise<void>
  disconnect(): Promise<void>
  /** 每次连接（含重连）都重新发现服务/特征后读取信息特征 */
  readInfo(): Promise<DeviceInfo>
  /**
   * 仅把命令字节写入命令特征。
   * Promise 完成 = 字节已写入，绝不代表设备已采用新值；
   * 成功与否只能以通知回执（或重连后读到的持久回执）为准。
   */
  sendCommand(cmd: CommandRequest): Promise<void>
  on<K extends keyof AdapterEvents>(
    type: K,
    handler: (event: AdapterEvents[K]) => void
  ): () => void
}

/** 命令在页面侧的最终结论 */
export type OutcomeStatus =
  | 'pending' // 未决：已发出，尚无回执
  | 'confirmed' // 收到 ok 回执（通知或重连对账）
  | 'rejected' // 收到 conflict / rejected 回执
  | 'write-failed' // 写入本身失败，设备是否收到未知
  | 'unknown' // 断线且无回执，结果未知

export interface PendingCmd {
  commandId: number
  expectedRevision: number
  setpoint: number
  deviceId: string
  bootIdAtSend: number
  startedAt: number
  finishedAt: number | null
  outcome: OutcomeStatus
  /** 结论来源：实时通知 / 重连对账 / null=尚无 */
  source: 'notify' | 'reconnect' | null
  receipt: Receipt | null
  detail: string
}

export interface OutcomeRecord extends PendingCmd {
  archivedAt: number
}

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'protocol'

export interface LogEntry {
  t: number
  level: LogLevel
  source: string
  message: string
}

/** 模拟适配器的时序/故障注入参数（相对命令发出时刻的毫秒数，null = 不发生） */
export interface MockTuning {
  writeDelayMs: number
  execDelayMs: number | null
  notifyDelayMs: number | null
  dropDelayMs: number | null
  behavior: 'apply' | 'conflict' | 'reject'
  /** 执行时不更新设备保存的最近回执（模拟回执遗失） */
  forgetReceipt: boolean
  /** 下次连接时设备重启（bootId +1） */
  rebootBeforeReconnect: boolean
  /** 重连后补发上一 boot 的迟到通知 */
  staleLateNotifyOnReconnect: boolean
}
