<script setup lang="ts">
import { computed } from 'vue'
import { store, phaseText } from '../store/controller'
import { receiptStatusText } from '../bluetooth/protocol'

const bigClass = computed(() => {
  const phase = store.command?.phase
  if (phase === 'acked') return 'confirmed'
  if (phase === 'rejected') return 'rejected-big'
  return 'unknown'
})
</script>

<template>
  <div class="grid grid-3">
    <!-- 草稿 -->
    <section class="panel">
      <h2>草稿（仅本页）</h2>
      <div class="value-big draft">{{ store.draft }}</div>
      <p class="note mt8">
        你在输入框里拟定的新值。它只是草稿：命令未获设备回执前，
        <strong>不会</strong>出现在“已确认值”中，断线也不会把它当成设备值。
      </p>
    </section>

    <!-- 已确认值 -->
    <section class="panel">
      <h2>已确认值（信息特征）</h2>
      <div class="value-big confirmed">
        {{ store.confirmedValue === null ? '—' : store.confirmedValue }}
      </div>
      <dl class="kv mt8">
        <dt>修订</dt>
        <dd>{{ store.revision === null ? '—' : 'r' + store.revision }}</dd>
        <dt>bootId</dt>
        <dd>{{ store.bootId === null ? '—' : '0x' + store.bootId.toString(16) }}</dd>
      </dl>
      <p class="note mt8">
        只来自对信息特征的实际读取。切换设备、设备重启、收到旧通知都不会改写它。
      </p>
    </section>

    <!-- 未决/最近命令结果 -->
    <section class="panel">
      <h2>未决结果</h2>
      <template v-if="store.command">
        <div class="row spread">
          <span class="muted">命令 #{{ store.command.commandId }}</span>
          <span class="pill" :class="store.command.phase">{{ phaseText(store.command.phase) }}</span>
        </div>
        <div class="value-big mt8" :class="bigClass">{{ store.command.draft }}</div>
        <dl class="kv mt8" v-if="store.command.receipt">
          <dt>回执状态</dt>
          <dd>{{ receiptStatusText(store.command.receipt.status) }}</dd>
          <dt>回执修订</dt>
          <dd>r{{ store.command.receipt.revision }}</dd>
          <dt>回执值</dt>
          <dd>{{ store.command.receipt.value }}</dd>
        </dl>
        <p class="note mt8">{{ store.command.note }}</p>
      </template>
      <template v-else>
        <div class="value-big" style="color: var(--muted)">—</div>
        <p class="note mt8">当前没有命令记录。发起修改后，这里展示写入、回执与对账全过程。</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.rejected-big {
  color: var(--warn);
}
</style>
