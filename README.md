# 演示蓝牙控制器 · Web Bluetooth + Vue 3 + TypeScript

对接一个自定义 GATT 服务的演示控制器。核心原则：**页面草稿不是设备值；
`writeValueWithResponse` 完成只代表字节已写入；命令成败只以绑定命令 ID 的
回执（通知，或重连后设备保存回执的对账结果）为准。**

## 运行

```bash
npm install
npm run dev            # 本地开发（http://localhost:5173）
npm run build          # vue-tsc 类型检查 + 生产构建
npm run test:scenarios # Node 驱动的 35 项关键场景验收（无需浏览器/硬件）
```

普通浏览器无需任何真实硬件：默认使用**模拟适配器**，可完整演示

- ② 通知先于写入 Promise 兑现到达；
- ③ 写入后断线（重连后凭设备保存的最近回执对账确认）；
- ④ 设备重启、旧 boot 通知迟到（被忽略）；
- ⑤ 回执遗失（未决保持「结果未知」，不自动重发、不宣称失败）；
- ⑥/⑦ 修订冲突、设备拒绝（草稿不冒充设备值）；
- 切换设备 A/B、注入其他设备/旧会话通知（不改写当前设备确认值）。

真实连接模式在顶部切换：**只能由用户点击按钮触发系统设备选择器**；
浏览器不支持 Web Bluetooth（或非安全上下文）时在入口处明确提示。

## GATT 协议（自定义服务）

| UUID 后缀 | 特征 | 方向 | 内容 |
| --- | --- | --- | --- |
| `…0000` | Service | — | 自定义控制器服务 |
| `…0001` | info | read | deviceId(16 ASCII) + firmware(24 ASCII) + bootId u32 + revision u32 + setpoint i16 + receiptFlag u8 + [回执 15B]，共 66B |
| `…0002` | command | write with response | commandId u32 + expectedRevision u32 + setpoint i16，共 10B |
| `…0003` | notify | notify | commandId u32 + bootId u32 + status u8(0 ok/1 conflict/2 rejected) + revision u32 + setpoint i16，共 15B |

多字节整数小端序。编解码见 `src/ble/protocol.ts`。

## 状态模型（三者严格分离）

- **草稿 `draft`**：仅存在于页面输入框，任何时刻都不代表设备状态。
- **已确认值 `info.setpoint / info.revision`**：只来自信息特征读取，或
  通过校验（命令 ID、bootId、状态）的回执。
- **未决结果 `pending`**：同一时间最多一个，状态机：
  `pending` →（有效通知）→ `confirmed` / `rejected`；
  断线 → `unknown`；重连后读 info 与设备保存回执对账，
  仅允许 `unknown → confirmed/rejected`；无匹配回执则**保持未知**，
  不自动重发、不判定失败，由用户手动放弃或再发起。

### 防串扰规则

通知必须同时满足：存在未决命令、命令尚未有结论、`commandId` 匹配、
`bootId` 与当前设备一致（重启后旧 boot 通知拒绝），且来自当前适配器
（切换设备/模式后旧适配器事件作废）。切换设备时旧设备未决归档停车，
确认值整体切换为新设备信息特征的读取结果。

## 目录

```
src/ble/protocol.ts        GATT 二进制协议
src/ble/types.ts           共享类型（适配器接口、命令/回执/结果模型）
src/ble/real-adapter.ts    真实 Web Bluetooth 适配器（用户选择入口、重连重新发现）
src/ble/mock-adapter.ts    同接口可控模拟（时序/断线/重启/回执遗失注入）
src/ble/presets.ts         演示预设
src/store/controller.ts    连接、未决命令、通知校验、断线对账状态机
src/components/*.vue       连接栏 / 草稿 / 设备实际状态 / 未决结果 / 模拟控制台 / 日志
scripts/test-scenarios.ts  关键场景自动化验收
```
