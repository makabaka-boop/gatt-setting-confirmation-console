import type { ConnectionState } from './ui-types'
import type { OutcomeStatus, ReceiptStatus } from '../ble/types'

export function fmtTime(t: number | null): string {
  if (t === null) return '—'
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(
    d.getMilliseconds()
  ).padStart(3, '0')}`
}

export function fmtClock(t: number): string {
  return fmtTime(t)
}

export const OUTCOME_LABEL: Record<OutcomeStatus, string> = {
  pending: '未决 · 等待回执',
  confirmed: '已确认 · 设备已采用',
  rejected: '设备拒绝 · 新值未采用',
  'write-failed': '写入失败 · 是否送达未知',
  unknown: '结果未知 · 不自动重发'
}

export const RECEIPT_STATUS_LABEL: Record<ReceiptStatus, string> = {
  ok: 'ok（已采用）',
  conflict: 'conflict（修订冲突）',
  rejected: 'rejected（设备拒绝）'
}

export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  idle: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  disconnected: '已断开（可重连）'
}
