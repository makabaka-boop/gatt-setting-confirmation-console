<script setup lang="ts">
import { store } from './store/controller'
import ValueCards from './components/ValueCards.vue'
import ConnectionPanel from './components/ConnectionPanel.vue'
import CommandPanel from './components/CommandPanel.vue'
import SimConsole from './components/SimConsole.vue'
import LogPanel from './components/LogPanel.vue'
</script>

<template>
  <header class="mt8">
    <h1>自定义 GATT 设定值控制器 · Web Bluetooth 演示</h1>
    <p class="subtitle">
      自定义服务 <code>0000a000-…</code>：信息特征（读）/ 命令特征（写）/ 回执特征（读+通知）。
      页面严格区分<strong>草稿值</strong>、<strong>已确认值</strong>与<strong>未决命令结果</strong>。
    </p>
  </header>

  <div v-if="store.error" class="error-box mb12">{{ store.error }}</div>

  <div class="grid grid-2 mt16">
    <ConnectionPanel />
    <CommandPanel />
  </div>

  <div class="mt16">
    <ValueCards />
  </div>

  <div class="grid grid-2 mt16">
    <SimConsole v-if="store.mode === 'sim'" />
    <section class="panel" v-else>
      <h2>真实设备协议要点</h2>
      <dl class="kv">
        <dt>服务</dt><dd>0000a000-0000-1000-8000-00805f9b34fb</dd>
        <dt>信息特征</dt><dd>…a001（Read，32 字节）</dd>
        <dt>命令特征</dt><dd>…a002（Write，12 字节）</dd>
        <dt>回执特征</dt><dd>…a003（Read + Notify，21 字节）</dd>
      </dl>
      <p class="note mt12">
        命令载荷 = commandId(u32) + expectedRevision(u32) + newValue(i32)；
        固件仅在 expectedRevision 等于当前修订时采纳并令修订 +1。
        写操作完成不等于采纳，结果以回执通知或重连后读到的设备保存回执为准。
      </p>
    </section>

    <LogPanel />
  </div>
</template>

<style scoped>
.mb12 {
  margin-bottom: 12px;
}
.mt16 {
  margin-top: 16px;
}
.mt8 {
  margin-top: 8px;
}
code {
  font-family: var(--mono);
  background: rgba(255, 255, 255, 0.06);
  padding: 0 4px;
  border-radius: 4px;
}
</style>
