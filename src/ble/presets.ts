import type { MockTuning } from './types'

export interface MockPreset {
  key: string
  label: string
  desc: string
  tuning: MockTuning
}

/**
 * 时间轴约定（相对命令发出）：
 *   t_write   写入 Promise 兑现 —— 仅表示字节已送达
 *   t_exec    设备执行并保存回执（更新实际值）
 *   t_notify  通知特征发出回执
 *   t_drop    链路意外断开（null = 不断线）
 */
export const MOCK_PRESETS: MockPreset[] = [
  {
    key: 'normal',
    label: '① 正常确认',
    desc: '写入完成 → 设备执行 → 收到 ok 通知，确认值更新。',
    tuning: {
      writeDelayMs: 600,
      execDelayMs: 800,
      notifyDelayMs: 1000,
      dropDelayMs: null,
      behavior: 'apply',
      forgetReceipt: false,
      rebootBeforeReconnect: false,
      staleLateNotifyOnReconnect: false
    }
  },
  {
    key: 'notify-first',
    label: '② 通知先到',
    desc: 't_notify(400) < t_write(600)：写 Promise 未返回时回执已到达，照样据此确认。',
    tuning: {
      writeDelayMs: 600,
      execDelayMs: 100,
      notifyDelayMs: 400,
      dropDelayMs: null,
      behavior: 'apply',
      forgetReceipt: false,
      rebootBeforeReconnect: false,
      staleLateNotifyOnReconnect: false
    }
  },
  {
    key: 'drop-after-write',
    label: '③ 写入后断线',
    desc: '设备先执行并保存回执，随后断线；写入兑现不代表成功。重连后用设备保存的回执对账。',
    tuning: {
      writeDelayMs: 300,
      execDelayMs: 450,
      notifyDelayMs: null,
      dropDelayMs: 700,
      behavior: 'apply',
      forgetReceipt: false,
      rebootBeforeReconnect: false,
      staleLateNotifyOnReconnect: false
    }
  },
  {
    key: 'reboot-stale',
    label: '④ 重启 + 旧通知迟到',
    desc: '勾选“重连前重启”后重连：设备补发旧 boot 的迟到通知（应被忽略），以信息特征中保存的新 boot 回执为准。',
    tuning: {
      writeDelayMs: 300,
      execDelayMs: 450,
      notifyDelayMs: null,
      dropDelayMs: 700,
      behavior: 'apply',
      forgetReceipt: false,
      rebootBeforeReconnect: true,
      staleLateNotifyOnReconnect: true
    }
  },
  {
    key: 'receipt-lost',
    desc: '写入后断线，设备没保存回执：未决保持“结果未知”，不自动重发、不宣称失败；用户手动决定下一步。',
    label: '⑤ 回执遗失',
    tuning: {
      writeDelayMs: 300,
      execDelayMs: 450,
      notifyDelayMs: null,
      dropDelayMs: 700,
      behavior: 'apply',
      forgetReceipt: true,
      rebootBeforeReconnect: false,
      staleLateNotifyOnReconnect: false
    }
  },
  {
    key: 'conflict',
    label: '⑥ 修订冲突',
    desc: '模拟并发修改：设备拒绝采用，回执带冲突状态和实际修订/值，页面据此重显真实状态。',
    tuning: {
      writeDelayMs: 300,
      execDelayMs: 500,
      notifyDelayMs: 700,
      dropDelayMs: null,
      behavior: 'conflict',
      forgetReceipt: false,
      rebootBeforeReconnect: false,
      staleLateNotifyOnReconnect: false
    }
  },
  {
    key: 'rejected',
    label: '⑦ 设备拒绝',
    desc: '新值超出设备允许范围：收到 rejected 回执，草稿不被当成设备值。',
    tuning: {
      writeDelayMs: 300,
      execDelayMs: 500,
      notifyDelayMs: 700,
      dropDelayMs: null,
      behavior: 'reject',
      forgetReceipt: false,
      rebootBeforeReconnect: false,
      staleLateNotifyOnReconnect: false
    }
  }
]

export const DEFAULT_TUNING: MockTuning = { ...MOCK_PRESETS[0].tuning }
