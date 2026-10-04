<script setup lang="ts">
import { computed, ref } from 'vue'
import { store } from '../store/controller'
import { receiptStatusText } from '../bluetooth/protocol'

const simDevice = ref('SIM-A')

const connBadgeClass = computed(() => {
  if (store.isConnected) return 'connected'
  if (store.connectionState === 'connecting' || store.connectionState === 'reconnecting') return 'connecting'
  return 'idle'
})
const connText = computed(() => {
  switch (store.connectionState) {
    case 'connected':
      return '已连接'
    case 'connecting':
      return '连接中…（请在系统弹窗中选择设备）'
    case 'reconnecting':
      return '重连中…'
    default:
      return '未连接'
  }
})

function chooseSimDevice(id: string) {
  simDevice.value = id
  void store.switchSimDevice(id)
}
</script>

<template>
  <section class="panel">
    <h2>连接</h2>

    <div class="row spread">
      <div class="row">
        <button
          :class="{ primary: store.mode === 'sim' }"
          @click="store.setMode('sim')"
        >模拟适配器</button>
        <button
          :class="{ primary: store.mode === 'real' }"
          @click="store.setMode('real')"
        >真实蓝牙设备</button>
        <span class="badge mode">{{ store.mode === 'sim' ? '无需硬件' : 'Web Bluetooth' }}</span>
      </div>
      <span class="badge" :class="connBadgeClass">{{ connText }}</span>
    </div>

    <!-- 真实模式 API 不可用提示 -->
    <div class="warn-box mt12" v-if="store.mode === 'real' && !store.webBluetoothAvailable">
      当前浏览器无法使用 Web Bluetooth API。请使用桌面版 Chrome / Edge，并通过
      <code>https://</code> 或 <code>localhost</code> 打开本页；浏览器也可能需要系统蓝牙权限。
      无硬件时可改用左侧“模拟适配器”完成全部演示。
    </div>

    <!-- 模拟模式：设备选择与连接 -->
    <template v-if="store.mode === 'sim'">
      <label class="field mt12">
        模拟设备
        <select :value="simDevice" @change="chooseSimDevice(($event.target as HTMLSelectElement).value)"
          :disabled="store.isConnected">
          <option value="SIM-A">SIM-A</option>
          <option value="SIM-B">SIM-B</option>
          <option value="SIM-C">SIM-C</option>
        </select>
      </label>
      <div class="row">
        <button class="primary" :disabled="store.isConnected || store.connecting"
          @click="store.connectSim(simDevice)">
          连接模拟设备
        </button>
        <button :disabled="store.isConnected || store.connecting || !store.adapter"
          @click="store.reconnect()">重连</button>
        <button class="danger" :disabled="!store.isConnected" @click="store.disconnect()">断开</button>
      </div>
    </template>

    <!-- 真实模式：用户选择入口 -->
    <template v-else>
      <p class="note mt12">
        点击下方按钮后，浏览器会弹出设备选择器——真实设备必须由你手动选择，页面不会也无法自动连接。
        请确保设备广播中包含自定义 GATT 服务
        <code>0000a000-…</code>。
      </p>
      <div class="row">
        <button class="primary" :disabled="store.isConnected || store.connecting || !store.webBluetoothAvailable"
          @click="store.connectReal()">
          选择并连接真实蓝牙设备…
        </button>
        <button :disabled="store.isConnected || store.connecting || !store.adapter"
          @click="store.reconnect()">重连已选设备</button>
        <button class="danger" :disabled="!store.isConnected" @click="store.disconnect()">断开</button>
      </div>
    </template>

    <hr class="divider" />

    <dl class="kv">
      <dt>适配器</dt><dd>{{ store.adapter ? store.deviceLabel : '尚未建立' }}</dd>
      <dt>身份标识</dt><dd>{{ store.deviceIdentity || '—' }}</dd>
      <dt>设备 deviceId</dt><dd>{{ store.deviceId || '—' }}</dd>
      <dt>会话编号</dt><dd>{{ store.sessionId === 0 ? '—' : '#' + store.sessionId }}</dd>
    </dl>

    <div class="row mt12">
      <button :disabled="!store.isConnected || store.refreshing" @click="store.refresh()">
        {{ store.refreshing ? '读取中…' : '手动读取信息特征' }}
      </button>
    </div>

    <hr class="divider" />

    <h3>设备保存的最近回执</h3>
    <p class="note">每次（重新）连接都会重新读取；这是断线对账的唯一设备侧依据。</p>
    <template v-if="store.lastReadReceipt">
      <dl class="kv mt8">
        <dt>命令</dt><dd>#{{ store.lastReadReceipt.commandId }}</dd>
        <dt>状态</dt><dd>{{ receiptStatusText(store.lastReadReceipt.status) }}</dd>
        <dt>修订 / 值</dt><dd>r{{ store.lastReadReceipt.revision }} / {{ store.lastReadReceipt.value }}</dd>
        <dt>boot</dt><dd>0x{{ store.lastReadReceipt.bootId.toString(16) }}</dd>
        <dt>读取时刻</dt><dd>{{ store.receiptCheckedAt }}</dd>
      </dl>
    </template>
    <template v-else>
      <p class="note mt8">
        {{ store.isConnected ? '设备上读不到已保存的回执。' : '连接后读取。' }}
        <template v-if="store.isConnected">此时不会自动重发命令，也不据此宣称失败。</template>
      </p>
      <p class="note" v-if="store.isConnected && store.receiptCheckedAt">读取时刻：{{ store.receiptCheckedAt }}</p>
    </template>
  </section>
</template>
