<script setup lang="ts">
import { useController } from '../store/controller'

const {
  state,
  presets,
  isMockConnected,
  selectPreset,
  patchTuning,
  mockInjectForeign,
  mockForceDrop,
  mockReboot
} = useController()

function nullableNumber(raw: string): number | null {
  if (raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function num(raw: string): number {
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}
</script>

<template>
  <div class="panel">
    <h2>模拟适配器 · 场景与故障注入</h2>

    <div class="preset-grid">
      <button
        v-for="p in presets"
        :key="p.key"
        class="preset-btn"
        :class="{ active: state.selectedPresetKey === p.key }"
        @click="selectPreset(p.key)"
      >
        {{ p.label }}
        <small>{{ p.desc }}</small>
      </button>
    </div>

    <div class="tuning-grid">
      <label>
        t_write 写入兑现(ms)
        <input
          type="number"
          :value="state.tuning.writeDelayMs"
          @input="patchTuning({ writeDelayMs: num(($event.target as HTMLInputElement).value) })"
        />
      </label>
      <label>
        t_exec 设备执行(ms)，空=不执行
        <input
          type="number"
          :value="state.tuning.execDelayMs ?? ''"
          @input="patchTuning({ execDelayMs: nullableNumber(($event.target as HTMLInputElement).value) })"
        />
      </label>
      <label>
        t_notify 通知到达(ms)，空=不通知
        <input
          type="number"
          :value="state.tuning.notifyDelayMs ?? ''"
          @input="patchTuning({ notifyDelayMs: nullableNumber(($event.target as HTMLInputElement).value) })"
        />
      </label>
      <label>
        t_drop 意外断线(ms)，空=不断
        <input
          type="number"
          :value="state.tuning.dropDelayMs ?? ''"
          @input="patchTuning({ dropDelayMs: nullableNumber(($event.target as HTMLInputElement).value) })"
        />
      </label>
      <label>
        设备行为
        <select
          :value="state.tuning.behavior"
          @change="patchTuning({ behavior: ($event.target as HTMLSelectElement).value as 'apply' | 'conflict' | 'reject' })"
        >
          <option value="apply">采用新值 (apply)</option>
          <option value="conflict">修订冲突 (conflict)</option>
          <option value="reject">设备拒绝 (reject)</option>
        </select>
      </label>
    </div>

    <div class="row" style="margin-top: 12px">
      <label class="checkbox">
        <input
          type="checkbox"
          :checked="state.tuning.forgetReceipt"
          @change="patchTuning({ forgetReceipt: ($event.target as HTMLInputElement).checked })"
        />
        执行时不保存回执（回执遗失）
      </label>
      <label class="checkbox">
        <input
          type="checkbox"
          :checked="state.tuning.rebootBeforeReconnect"
          @change="patchTuning({ rebootBeforeReconnect: ($event.target as HTMLInputElement).checked })"
        />
        下次重连时设备重启（bootId +1，值与修订保留）
      </label>
      <label class="checkbox">
        <input
          type="checkbox"
          :checked="state.tuning.staleLateNotifyOnReconnect"
          @change="patchTuning({ staleLateNotifyOnReconnect: ($event.target as HTMLInputElement).checked })"
        />
        重连后补发旧 boot 迟到通知
      </label>
    </div>

    <div class="row" style="margin-top: 14px">
      <button class="secondary" :disabled="!isMockConnected" @click="mockForceDrop">
        立即模拟意外断线
      </button>
      <button class="secondary" :disabled="!isMockConnected" @click="mockReboot">
        立即模拟设备重启
      </button>
      <button class="ghost" :disabled="!isMockConnected" @click="mockInjectForeign">
        注入其他设备/旧会话通知
      </button>
    </div>

    <p class="hint">
      推荐验收：② 通知先到（写入返回前确认）；③ 写入后断线（断开后点重连，用保存回执对账）；
      ④ 重启迟到通知（旧 boot 通知被忽略）；⑤ 回执遗失（重连后保持结果未知，不自动重发）。
      切换设备可在顶部选择 A/B：旧设备迟到通知不会改写当前设备确认值。
    </p>
  </div>
</template>
