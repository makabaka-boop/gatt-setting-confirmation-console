<script setup lang="ts">
import { useController } from '../store/controller'
import { OUTCOME_LABEL, RECEIPT_STATUS_LABEL, fmtTime } from '../utils/format'

const { state, dismissResult, abandonUnknown } = useController()

function outcomeClass(p: { outcome: string }): string {
  return p.outcome
}
</script>

<template>
  <div class="panel">
    <h2>未决 / 最近一次命令结果</h2>

    <div v-if="!state.pending" class="hint">
      当前没有未决命令。可在左侧草稿中修改后手动发起。
    </div>

    <div v-else class="result-card" :class="outcomeClass(state.pending)">
      <div class="spread">
        <strong>命令 #{{ state.pending.commandId }}</strong>
        <span class="tag" :class="outcomeClass(state.pending)">
          {{ OUTCOME_LABEL[state.pending.outcome] }}
        </span>
      </div>

      <dl class="kv" style="margin-top:10px">
        <dt>目标值</dt>
        <dd>{{ state.pending.setpoint }}</dd>
        <dt>预期修订</dt>
        <dd>{{ state.pending.expectedRevision }}</dd>
        <dt>发送时 boot</dt>
        <dd>{{ state.pending.bootIdAtSend }}</dd>
        <dt>设备</dt>
        <dd>{{ state.pending.deviceId }}</dd>
        <dt>发出时刻</dt>
        <dd>{{ fmtTime(state.pending.startedAt) }}</dd>
        <dt>结论时刻</dt>
        <dd>{{ fmtTime(state.pending.finishedAt) }}</dd>
        <dt>结论来源</dt>
        <dd>
          {{ state.pending.source === 'notify' ? '实时通知回执' :
             state.pending.source === 'reconnect' ? '重连后设备保存回执对账' : '—' }}
        </dd>
        <dt v-if="state.pending.receipt">回执内容</dt>
        <dd v-if="state.pending.receipt">
          {{ RECEIPT_STATUS_LABEL[state.pending.receipt.status] }} ·
          rev={{ state.pending.receipt.revision }} · 值={{ state.pending.receipt.setpoint }}
        </dd>
      </dl>

      <p class="detail">{{ state.pending.detail }}</p>

      <div class="row">
        <button
          v-if="state.pending.outcome !== 'pending'"
          class="secondary"
          @click="dismissResult"
        >
          关闭并存档（之后可发起新修改）
        </button>
        <button
          v-if="state.pending.outcome === 'unknown'"
          class="ghost"
          @click="abandonUnknown"
        >
          放弃跟踪此结果未知命令（不自动重发）
        </button>
        <span
          v-if="state.pending.outcome === 'pending'"
          class="hint"
        >
          正在等待绑定命令 {{ state.pending.commandId }} 的通知回执…写入完成不算成功。
        </span>
      </div>
    </div>

    <div v-if="state.history.length" style="margin-top: 14px">
      <h2>历史结论（最近 {{ state.history.length }} 条）</h2>
      <div v-for="h in state.history" :key="h.commandId + '-' + h.archivedAt" class="history-item">
        <span>
          <span class="tag" :class="outcomeClass(h)">{{ OUTCOME_LABEL[h.outcome].split(' ')[0] }}</span>
          命令 #{{ h.commandId }} → {{ h.setpoint }}
        </span>
        <span style="color: var(--muted)">
          {{ h.deviceId }} · {{ fmtTime(h.archivedAt) }}
        </span>
      </div>
    </div>
  </div>
</template>
