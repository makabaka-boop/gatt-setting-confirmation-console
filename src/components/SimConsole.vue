<script setup lang="ts">
import { store } from '../store/controller'
import type { ScenarioId } from '../bluetooth/sim-adapter'
</script>

<template>
  <section class="panel">
    <h2>模拟故障控制台（仅模拟适配器）</h2>
    <p class="note">
      场景决定<strong>下一条命令</strong>在固件侧的命运；下方按钮可在任意时刻注入事件。
    </p>

    <h3 class="mt12">执行场景</h3>
    <div class="grid mt8" style="grid-template-columns: 1fr 1fr;">
      <button
        v-for="opt in store.scenarioOptions"
        :key="opt.id"
        class="scenario-btn"
        :class="{ active: store.simScenario === opt.id }"
        @click="store.setSimScenario(opt.id as ScenarioId)"
      >{{ opt.label }}</button>
    </div>

    <h3 class="mt16">随时注入</h3>
    <div class="row mt8">
      <button :disabled="!store.isConnected" @click="store.simExternalBump(42)">
        模拟他端改值（修订+1）
      </button>
      <button :disabled="!store.isConnected" @click="store.simReboot(true)">
        设备重启（保留回执）
      </button>
      <button :disabled="!store.isConnected" @click="store.simReboot(false)">
        设备重启（清空回执）
      </button>
    </div>
    <div class="row mt8">
      <button @click="store.simInjectLate('same-device')">
        注入旧会话迟到通知
      </button>
      <button @click="store.simInjectLate('foreign')">
        注入冒充其他设备的通知
      </button>
    </div>

    <p class="note mt12">
      推荐验收路径：连接 SIM-A → 发送任意值观察正常回执；选“通知先到”再发一次；
      选“写入后断线”，发送后点“重连”，观察设备保存的回执完成对账；
      再试“重启（回执遗失）”，重连后看到结果保持未知且不自动重发；
      切换到 SIM-B 后再点“注入冒充其他设备的通知”，确认 SIM-B 的确认值纹丝不动。
    </p>
  </section>
</template>
