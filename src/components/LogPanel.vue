<script setup lang="ts">
import { store } from '../store/controller'
</script>

<template>
  <section class="panel">
    <div class="row spread">
      <h2 style="margin: 0;">事件日志</h2>
      <button @click="store.clearLogs()">清空</button>
    </div>
    <div class="log mt12">
      <div v-for="line in store.logs" :key="line.id" class="log-line" :class="line.level">
        <span class="t">{{ line.time }}</span><span class="m">{{ line.message }}</span>
      </div>
      <p v-if="store.logs.length === 0" class="muted">暂无日志。</p>
    </div>
  </section>
</template>
