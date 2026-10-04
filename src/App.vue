<script setup lang="ts">
import { useController } from './store/controller'
import ConnectionBar from './components/ConnectionBar.vue'
import DeviceInfoCard from './components/DeviceInfoCard.vue'
import SetpointControl from './components/SetpointControl.vue'
import ResultCard from './components/ResultCard.vue'
import MockPanel from './components/MockPanel.vue'
import LogPanel from './components/LogPanel.vue'

const { state } = useController()
</script>

<template>
  <header style="margin-bottom: 16px">
    <h1>演示蓝牙控制器 · 自定义 GATT 服务对接</h1>
    <p class="subtitle">
      信息特征（设备标识 / bootId / 修订 / 实际设定值 / 保存回执）·
      命令特征（命令 ID + 预期修订 + 新值）·
      通知特征（绑定命令 ID 的执行回执）。
      草稿、已确认值、未决结果三者分开呈现；写入完成 ≠ 修改成功。
    </p>
  </header>

  <div v-if="state.banner" class="banner">{{ state.banner }}</div>

  <ConnectionBar />

  <div class="grid" style="margin-top: 14px">
    <div>
      <SetpointControl />
      <ResultCard />
    </div>
    <div>
      <DeviceInfoCard />
    </div>
  </div>

  <MockPanel v-if="state.mode === 'mock'" />

  <LogPanel />
</template>
