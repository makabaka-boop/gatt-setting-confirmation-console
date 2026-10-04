<script setup lang="ts">
import { store } from '../store/controller'
import { VALUE_MAX, VALUE_MIN } from '../bluetooth/protocol'
</script>

<template>
  <section class="panel">
    <h2>发起修改（手动决定）</h2>

    <label class="field">
      草稿设定值（设备允许范围 {{ VALUE_MIN }} … {{ VALUE_MAX }}）
      <input
        type="number"
        :value="store.draft"
        :min="VALUE_MIN"
        :max="VALUE_MAX"
        @input="store.setDraft(Number(($event.target as HTMLInputElement).value))"
      />
    </label>

    <div class="row spread">
      <button
        class="primary"
        :disabled="!store.canApply"
        @click="store.apply()"
      >写入命令（预期修订 {{ store.revision === null ? '—' : 'r' + store.revision }}）</button>

      <button
        :disabled="!store.command || store.hasPending"
        @click="store.dismissCommand()"
      >关闭当前命令记录</button>
    </div>

    <p class="note mt12">
      规则：同时最多一个未决命令；<code>writeValueWithResponse</code>
      完成只表示字节写入，是否采纳以绑定 commandId 的回执为准。
      上一条命令“结果未知”时，必须由你核对实际值后手动关闭，才允许发起下一次修改——系统不会自动重发。
    </p>

    <div v-if="store.hasUnresolved" class="warn-box mt12">
      上一条命令结果未知。请重连后核对“设备保存的最近回执”和信息特征中的实际值：
      若没有匹配回执，结果只能保持未知——不会自动重发，也不会宣称失败。
    </div>
  </section>
</template>
