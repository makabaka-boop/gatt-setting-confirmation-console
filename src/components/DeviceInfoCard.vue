<script setup lang="ts">
import { useController } from '../store/controller'
import { RECEIPT_STATUS_LABEL, fmtTime } from '../utils/format'

const { state, reread } = useController()
</script>

<template>
  <div class="panel">
    <div class="section-title-row">
      <h2>设备实际状态（信息特征 · 权威只读）</h2>
      <button class="ghost" :disabled="state.connection !== 'connected' || state.working" @click="reread">
        重新读取
      </button>
    </div>

    <div v-if="!state.info" class="hint">
      连接后读取信息特征。这里的值来自设备，绝不会被页面草稿覆盖。
    </div>

    <template v-else>
      <dl class="kv">
        <dt>设备标识</dt>
        <dd>{{ state.info.deviceId }}</dd>
        <dt>固件修订</dt>
        <dd>{{ state.info.firmwareRevision }}</dd>
        <dt>bootId</dt>
        <dd>{{ state.info.bootId }}</dd>
        <dt>设定值修订</dt>
        <dd>{{ state.info.revision }}</dd>
      </dl>

      <div style="margin: 14px 0 4px">
        <div class="big-value confirmed">{{ state.info.setpoint }}</div>
        <span class="tag confirmed">已确认的实际设定值</span>
        <span class="hint" style="margin-left:10px">最近读取 {{ fmtTime(state.lastReadAt) }}</span>
      </div>

      <div style="margin-top: 12px">
        <h2 style="margin-bottom:6px">设备保存的最近回执</h2>
        <div v-if="state.info.lastReceipt" class="result-card" :class="state.info.lastReceipt.status === 'ok' ? 'confirmed' : 'rejected'">
          <dl class="kv">
            <dt>绑定命令</dt>
            <dd>#{{ state.info.lastReceipt.commandId }}</dd>
            <dt>bootId</dt>
            <dd>{{ state.info.lastReceipt.bootId }}</dd>
            <dt>结果</dt>
            <dd>{{ RECEIPT_STATUS_LABEL[state.info.lastReceipt.status] }}</dd>
            <dt>回执修订</dt>
            <dd>{{ state.info.lastReceipt.revision }} / 设定值 {{ state.info.lastReceipt.setpoint }}</dd>
          </dl>
        </div>
        <p v-else class="hint">
          无保存回执（设备从未执行过命令，或回执已遗失）。此时重连对账不能得出结论，
          也不会自动重发。
        </p>
      </div>
    </template>
  </div>
</template>
