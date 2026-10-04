/**
 * 自定义 GATT 服务协议（演示控制器）
 *
 * Service: 7c1a0000-...
 * ├─ 信息特征（read）：设备标识 / 固件修订 / bootId / 设定值修订 / 实际设定值 / 设备保存的最近回执
 * ├─ 命令特征（write with response）：命令 ID + 预期修订 + 新值
 * └─ 通知特征（notify）：绑定命令 ID 的执行回执
 *
 * 多字节整数一律小端序。
 */

export const SERVICE_UUID = '7c1a0000-9b3e-4f7a-8d21-c5f6a7b80901'
export const INFO_CHAR_UUID = '7c1a0001-9b3e-4f7a-8d21-c5f6a7b80901'
export const COMMAND_CHAR_UUID = '7c1a0002-9b3e-4f7a-8d21-c5f6a7b80901'
export const NOTIFY_CHAR_UUID = '7c1a0003-9b3e-4f7a-8d21-c5f6a7b80901'

export const DEVICE_ID_LEN = 16
export const FIRMWARE_LEN = 24

/** 信息特征固定布局，共 66 字节 */
const INFO_TOTAL_LEN = 66
const INFO_RECEIPT_FLAG_OFFSET = 50
const RECEIPT_BODY_LEN = 15
/** 命令特征负载，共 10 字节 */
export const COMMAND_BODY_LEN = 10

import type { CommandRequest, DeviceInfo, Receipt } from './types'

function readFixedAscii(view: DataView, offset: number, len: number): string {
  let bytes = ''
  for (let i = 0; i < len; i++) {
    const b = view.getUint8(offset + i)
    if (b === 0) break
    bytes += String.fromCharCode(b)
  }
  return bytes
}

function writeFixedAscii(view: DataView, offset: number, len: number, text: string): void {
  for (let i = 0; i < len; i++) {
    view.setUint8(offset + i, i < text.length ? text.charCodeAt(i) : 0)
  }
}

export function encodeReceiptBody(r: Receipt): Uint8Array {
  const buf = new ArrayBuffer(RECEIPT_BODY_LEN)
  const view = new DataView(buf)
  view.setUint32(0, r.commandId >>> 0, true)
  view.setUint32(4, r.bootId >>> 0, true)
  view.setUint8(8, r.status === 'ok' ? 0 : r.status === 'conflict' ? 1 : 2)
  view.setUint32(9, r.revision >>> 0, true)
  view.setInt16(13, r.setpoint, true)
  return new Uint8Array(buf)
}

export function decodeReceiptBody(data: DataView, base = 0): Receipt {
  const statusByte = data.getUint8(base + 8)
  return {
    commandId: data.getUint32(base + 0, true) >>> 0,
    bootId: data.getUint32(base + 4, true) >>> 0,
    status: statusByte === 0 ? 'ok' : statusByte === 1 ? 'conflict' : 'rejected',
    revision: data.getUint32(base + 9, true) >>> 0,
    setpoint: data.getInt16(base + 13, true)
  }
}

export function encodeInfo(info: DeviceInfo): Uint8Array {
  const buf = new ArrayBuffer(INFO_TOTAL_LEN)
  const view = new DataView(buf)
  writeFixedAscii(view, 0, DEVICE_ID_LEN, info.deviceId)
  writeFixedAscii(view, DEVICE_ID_LEN, FIRMWARE_LEN, info.firmwareRevision)
  view.setUint32(40, info.bootId >>> 0, true)
  view.setUint32(44, info.revision >>> 0, true)
  view.setInt16(48, info.setpoint, true)
  view.setUint8(INFO_RECEIPT_FLAG_OFFSET, info.lastReceipt ? 1 : 0)
  if (info.lastReceipt) {
    const body = encodeReceiptBody(info.lastReceipt)
    new Uint8Array(buf).set(body, INFO_RECEIPT_FLAG_OFFSET + 1)
  }
  return new Uint8Array(buf)
}

export function decodeInfo(view: DataView): DeviceInfo {
  const lastReceipt =
    view.getUint8(INFO_RECEIPT_FLAG_OFFSET) === 1
      ? decodeReceiptBody(view, INFO_RECEIPT_FLAG_OFFSET + 1)
      : null
  return {
    deviceId: readFixedAscii(view, 0, DEVICE_ID_LEN),
    firmwareRevision: readFixedAscii(view, DEVICE_ID_LEN, FIRMWARE_LEN),
    bootId: view.getUint32(40, true) >>> 0,
    revision: view.getUint32(44, true) >>> 0,
    setpoint: view.getInt16(48, true),
    lastReceipt
  }
}

export function encodeCommand(cmd: CommandRequest): Uint8Array {
  const buf = new ArrayBuffer(COMMAND_BODY_LEN)
  const view = new DataView(buf)
  view.setUint32(0, cmd.commandId >>> 0, true)
  view.setUint32(4, cmd.expectedRevision >>> 0, true)
  view.setInt16(8, cmd.setpoint, true)
  return new Uint8Array(buf)
}
