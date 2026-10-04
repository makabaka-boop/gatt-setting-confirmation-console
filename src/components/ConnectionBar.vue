<script setup lang="ts">
import { useController } from '../store/controller'
import { CONNECTION_LABEL } from '../utils/format'

const {
  state,
  btSupport,
  mockDevices,
  connect,
  disconnect,
  reconnect,
  setMode,
  setMockTarget
} = useController()

const isBusy = () => state.connection === 'connecting' || state.working
</script>

<template>
  <div class="panel">
    <div class="spread">
      <div class="mode-switch" role="tablist" aria-label="连接模式">
        <button
          :class="{ active: state.mode === 'mock' }"
          :disabled="state.connection === 'connected' || state.connection === 'connecting'"
          @click="setMode('mock')"
        >
          模拟适配器（无需硬件）
        </button>
        <button
          :class="{ active: state.mode === 'real' }"
          :disabled="state.connection === 'connected' || state.connection === 'connecting'"
          @click="setMode('real')"
        >
          真实 Web Bluetooth
        </button>
      </div>

      <span
        class="pill"
        :class="state.connection"
      >
        <span class="dot" />
        {{ CONNECTION_LABEL[state.connection] }}
      </span>
    </div>

    <div class="row" style="margin-top: 12px">
      <template v-if="state.mode === 'mock'">
        <label>模拟设备：</label>
        <select
          :value="state.mockTarget"
          :disabled="state.connection === 'connected' || state.connection === 'connecting'"
          @change="setMockTarget(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="d in mockDevices" :key="d.id" :value="d.id">{{ d.label }}（{{ d.id }}）</option>
        </select>
      </template>

      <button v-if="state.connection !== 'connected'" :disabled="isBusy()" @click="connect">
        {{ state.connection === 'disconnected'
          ? '重连（重新发现服务/特征并读取状态）'
          : state.mode === 'real'
            ? '选择并连接蓝牙设备…'
            : '连接模拟设备' }}
      </button>
      <button
        v-else
        class="danger"
        @click="disconnect"
      >
        手动断开
      </button>
      <button
        v-if="state.connection === 'disconnected'"
        class="secondary"
        :disabled="isBusy()"
        @click="reconnect"
      >
        重连
      </button>
    </div>

    <p v-if="state.mode === 'real' && !btSupport.available" class="banner" style="margin-top:12px;margin-bottom:0">
      ⚠️ {{ btSupport.reason }}
    </p>
    <p v-else-if="state.mode === 'real'" class="hint" style="margin-bottom:0">
      真实模式由用户点击按钮后弹出系统设备选择器，只显示广播自定义服务
      <code>7c1a0000-…</code> 的控制器。浏览器不提供后台静默连接。
    </p>
    <p v-else class="hint" style="margin-bottom:0">
      模拟适配器与真实适配器实现同一接口，可在右侧注入通知时序、断线、重启与回执遗失，无需真实硬件即可验收。
    </p>
  </div>
</template>
