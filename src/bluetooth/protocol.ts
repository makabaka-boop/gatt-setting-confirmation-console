/**
 * 自定义 GATT 服务协议定义。
 *
 * 服务 (128-bit UUID):
 *   0000a000-0000-1000-8000-00805f9b34fb  "演示设定值控制器"
 *
 * 特征:
 *   ...a001 信息特征 (Read)
 *       0..15   deviceId   16 字节 ASCII，不足以 NUL 补齐
 *       16..23  bootId     uint64 BE，设备每次重启递增/随机
 *       24..27  revision   uint32 BE，设定值每次被设备采纳后 +1
 *       28..31  value      int32 BE，设备当前实际设定值
 *
 *   ...a002 命令特征 (Write / WriteWithoutResponse)
 *       0..3    commandId  uint32 BE，由客户端分配
 *       4..7    expectedRevision uint32 BE，乐观锁：必须等于当前修订
 *       8..11   newValue   int32 BE
 *
 *   ...a003 回执特征 (Read + Notify)
 *       0..3    commandId  uint32 BE
 *       4       status     0=已采纳 1=修订冲突 2=越界/非法 3=设备拒绝
 *       5..8    revision   uint32 BE，执行后的当前修订
 *       9..12   value      int32 BE，执行后的实际设定值
 *       13..20  bootId     uint64 BE，执行所在 boot 的 id
 */

export const CONTROLLER_SERVICE = '0000a000-0000-1000-8000-00805f9b34fb'
export const INFO_CHARACTERISTIC = '0000a001-0000-1000-8000-00805f9b34fb'
export const COMMAND_CHARACTERISTIC = '0000a002-0000-1000-8000-00805f9b34fb'
export const RECEIPT_CHARACTERISTIC = '0000a003-0000-1000-8000-00805f9b34fb'

/** 设备固件接受的设定值闭区间。 */
export const VALUE_MIN = -100
export const VALUE_MAX = 100

/** 回执状态码（与固件一致）。 */
export enum ReceiptStatus {
  Applied = 0,
  RevisionConflict = 1,
  OutOfRange = 2,
  Rejected = 3,
}

export function receiptStatusText(status: ReceiptStatus): string {
  switch (status) {
    case ReceiptStatus.Applied:
      return '已采纳'
    case ReceiptStatus.RevisionConflict:
      return '修订冲突'
    case ReceiptStatus.OutOfRange:
      return '数值越界'
    case ReceiptStatus.Rejected:
      return '设备拒绝'
  }
}

/** 信息特征解码后的结果——唯一的"实际状态"事实来源。 */
export interface DeviceInfo {
  deviceId: string
  bootId: bigint
  revision: number
  value: number
}

/** 回执特征内容；设备从未保存回执时为 null（读到全零字节也视为无回执）。 */
export interface Receipt {
  commandId: number
  status: ReceiptStatus
  revision: number
  value: number
  bootId: bigint
}

/** 发往命令特征的载荷。 */
export interface CommandRequest {
  commandId: number
  expectedRevision: number
  newValue: number
}

/** 读取侧宽松输入：DataView 的底层缓冲可能是 ArrayBufferLike。 */
export type AnyData = ArrayBuffer | DataView<ArrayBufferLike>

/** 编码器产出：确定由普通 ArrayBuffer 支撑的 DataView，可直接当 BufferSource 写入。 */
export type EncodedView = DataView<ArrayBuffer>

export function encodeInfo(info: DeviceInfo): EncodedView {
  const buf = new ArrayBuffer(32)
  const view = new DataView(buf)
  const idBytes = new TextEncoder().encode(info.deviceId.slice(0, 16).padEnd(16, '\0'))
  for (let i = 0; i < 16; i++) view.setUint8(i, idBytes[i] ?? 0)
  view.setBigUint64(16, info.bootId)
  view.setUint32(24, info.revision >>> 0)
  view.setInt32(28, info.value)
  return view
}

export function decodeInfo(data: AnyData): DeviceInfo {
  const view = asDataView(data)
  if (view.byteLength < 32) throw new Error(`信息特征长度无效：${view.byteLength} 字节（应为 32）`)
  let id = new TextDecoder('ascii').decode(new Uint8Array(view.buffer, view.byteOffset + 0, 16))
  id = id.replace(/\0+$/, '')
  return {
    deviceId: id,
    bootId: view.getBigUint64(16),
    revision: view.getUint32(24),
    value: view.getInt32(28),
  }
}

export function encodeCommand(cmd: CommandRequest): EncodedView {
  const buf = new ArrayBuffer(12)
  const view = new DataView(buf)
  view.setUint32(0, cmd.commandId >>> 0)
  view.setUint32(4, cmd.expectedRevision >>> 0)
  view.setInt32(8, cmd.newValue)
  return view
}

export function encodeReceipt(receipt: Receipt): EncodedView {
  const dv = new DataView(new ArrayBuffer(21))
  dv.setUint32(0, receipt.commandId >>> 0)
  dv.setUint8(4, receipt.status)
  dv.setUint32(5, receipt.revision >>> 0)
  dv.setInt32(9, receipt.value)
  dv.setBigUint64(13, receipt.bootId)
  return dv
}

export function decodeReceipt(data: AnyData): Receipt | null {
  const v = asDataView(data)
  if (v.byteLength < 21) throw new Error(`回执特征长度无效：${v.byteLength} 字节（应为 21）`)
  const commandId = v.getUint32(0)
  const status = v.getUint8(4) as ReceiptStatus
  // 未使用的设备：全零字节（commandId=0 且 revision=0）按"无回执"处理
  if (commandId === 0 && v.getUint32(5) === 0 && v.getBigUint64(13) === 0n) return null
  return {
    commandId,
    status,
    revision: v.getUint32(5),
    value: v.getInt32(9),
    bootId: v.getBigUint64(13),
  }
}

function asDataView(data: AnyData): DataView<ArrayBufferLike> {
  if (data instanceof ArrayBuffer) return new DataView(data)
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
}
