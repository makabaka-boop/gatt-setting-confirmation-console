<script setup lang="ts">
import { useController } from '../store/controller'

const { state, canSubmit, submitCommand, useDraftConfirmedValue } = useController()
</script>

<template>
  <div class="panel">
    <h2>草稿（仅存在于本页面）</h2>

    <div class="big-value draft">{{ state.draft || '—' }}</div>
    <span class="tag draft">草稿值</span>
    <span class="hint">草稿不是设备值；只有收到绑定命令的 ok 回执后才会进入「已确认」。</span>

    <div class="row" style="margin-top: 14px">
      <label for="draft-input">新设定值（int16，-32768~32767）：</label>
      <input
        id="draft-input"
        v-model="state.draft"
        type="number"
        min="-32768"
        max="32767"
        :disabled="state.connection !== 'connected' || !!state.pending"
        @keyup.enter="submitCommand"
      />
    </div>
    <p v-if="state.draftError" style="color: var(--error); font-size: 12px; margin: 6px 0 0">
      {{ state.draftError }}
    </p>

    <div class="row" style="margin-top: 14px">
      <button :disabled="!canSubmit" @click="submitCommand">
        发起修改（writeValueWithResponse）
      </button>
      <button class="secondary" :disabled="state.connection !== 'connected' || !!state.pending" @click="useDraftConfirmedValue">
        用已确认值填入草稿
      </button>
    </div>

    <p class="hint">
      规则：同一时间最多一个未决命令；写入 Promise 完成只代表字节已写入，
      设备是否采用只以通知回执（或重连后设备保存回执的对账结果）为准。是否发起修改由你手动决定。
    </p>
  </div>
</template>
