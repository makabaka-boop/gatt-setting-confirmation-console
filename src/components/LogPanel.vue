<script setup lang="ts">
import { useController } from '../store/controller'
import { fmtClock } from '../utils/format'

const { state } = useController()
</script>

<template>
  <div class="panel">
    <h2>事件与协议日志</h2>
    <ul class="log-list">
      <li v-for="(l, i) in state.logs" :key="l.t + '-' + i">
        <span class="t">{{ fmtClock(l.t) }}</span>
        <span class="src">[{{ l.source }}]</span>
        <span :class="'lvl-' + l.level">{{ l.message }}</span>
      </li>
      <li v-if="!state.logs.length" class="hint">暂无日志。</li>
    </ul>
  </div>
</template>
