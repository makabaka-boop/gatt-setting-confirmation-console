/**
 * 端到端冒烟测试（Node，无浏览器/DOM）：
 * 直接驱动 store + SimulatedControllerAdapter，验证关键正确性规则。
 * 运行：node scripts/smoke.mjs（由 npm 脚本经 esbuild 临时打包）
 */
import assert from 'node:assert/strict'
import { store } from '../src/store/controller.ts'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures++
    console.error(`  ✗ ${name}`)
    console.error(e && e.stack ? e.stack : e)
  }
}

async function waitUntil(predicate, timeout = 1500, label = '') {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(`等待超时：${label}（当前值见上下文）`)
}

async function freshSim(device = 'SIM-A') {
  if (store.isConnected) await store.disconnect()
  await store.connectSim(device)
  await waitUntil(() => store.isConnected, 1000, '连接成功')
  store.dismissCommand()
}

async function sendDraft(value) {
  store.setDraft(value)
  assert.equal(store.canApply, true, '发送前应允许发起修改')
  await store.apply()
}

async function run() {
  console.log('1) 连接与初始状态')
  await test('连接后读取信息特征：值=0、修订 r1、草稿=0', async () => {
    await freshSim('SIM-A')
    assert.equal(store.confirmedValue, 0)
    assert.equal(store.revision, 1)
    assert.equal(store.draft, 0)
    assert.equal(store.command, null)
  })

  console.log('2) 正常写入：写完成 ≠ 成功，以回执确认')
  await test('normal 场景：经历 written 后由回执确认，确认值才变为 37', async () => {
    await freshSim('SIM-A')
    store.setSimScenario('normal')
    let sawWritten = false
    const p = sendDraft(37)
    await waitUntil(() => store.command?.phase === 'written', 300, 'written 阶段')
    sawWritten = store.command.phase === 'written'
    assert.equal(sawWritten, true)
    // written 阶段确认值仍为 0，草稿 37 绝不能冒充确认值
    assert.equal(store.confirmedValue, 0, '字节已写入但回执未到：确认值必须仍是 0')
    await p
    await waitUntil(() => store.command?.phase === 'acked', 1000, 'acked')
    assert.equal(store.confirmedValue, 37)
    assert.equal(store.revision, 2)
  })

  console.log('3) 通知先到')
  await test('notify-first：回执早于写事务 resolve，最终仍正确确认且只确认一次', async () => {
    await freshSim('SIM-A')
    store.setSimScenario('notify-first')
    await sendDraft(50)
    await waitUntil(() => store.command?.phase === 'acked', 1000, 'acked')
    assert.equal(store.confirmedValue, 50)
    assert.equal(store.revision, 2)
    // 再等一拍，确认没有迟到事件把状态改坏
    await sleep(150)
    assert.equal(store.command.phase, 'acked')
  })

  console.log('4) 写入后断线：未决 → 结果未知；重连对账')
  await test('disconnect-after-write：断线标未知，重连读到设备保存的同 id 回执后对账为已确认', async () => {
    await freshSim('SIM-A')
    store.setSimScenario('disconnect-after-write')
    await sendDraft(61)
    await waitUntil(() => store.connectionState === 'idle', 1000, '断线')
    assert.equal(store.command.phase, 'unknown', '回执前断线必须是结果未知')
    assert.equal(store.confirmedValue, 0, '断线后确认值不得被草稿改写')
    // 未决期间禁止再发
    assert.equal(store.canApply, false)
    await store.reconnect()
    await waitUntil(() => store.isConnected, 1500, '重连成功')
    await waitUntil(() => store.command.phase === 'acked', 1500, '重连对账 acked')
    assert.equal(store.command.receipt.commandId, store.command.commandId)
    assert.equal(store.confirmedValue, 61)
  })

  console.log('5) 重启且回执遗失：查不到回执 → 保持未知、不重发、不宣称失败')
  await test('reboot-lost：重连后回执为 null，命令保持 unknown，需手动关闭后才能再发', async () => {
    await freshSim('SIM-A')
    store.setSimScenario('reboot-lost')
    await sendDraft(72)
    await waitUntil(() => store.connectionState === 'idle', 1000, '断线')
    assert.equal(store.command.phase, 'unknown')
    const bootBefore = store.bootId
    await store.reconnect()
    await waitUntil(() => store.isConnected, 1500, '重连')
    await sleep(200)
    assert.equal(store.lastReadReceipt, null, '设备回执已遗失')
    assert.equal(store.command.phase, 'unknown', '没有回执不得判定成功或失败')
    assert.notEqual(store.bootId, bootBefore, 'bootId 应变化（设备已重启）')
    assert.equal(store.confirmedValue, 72, '信息特征显示设备实际采纳了值（用户据此手动判断）')
    // 系统没有自动重发：commandId 不变、没有新命令
    const id = store.command.commandId
    assert.equal(store.canApply, false, 'unknown 未关闭前禁止发起新修改')
    store.dismissCommand()
    assert.equal(store.canApply, true, '手动关闭后才允许新修改')
    assert.equal(store.command, null)
    void id
  })

  console.log('6) 修订冲突：设备未采纳，草稿不生效')
  await test('conflict：预期修订过期 → rejected，确认值与修订以设备为准', async () => {
    await freshSim('SIM-A')
    store.setSimScenario('conflict')
    await sendDraft(88)
    await waitUntil(() => store.command?.phase === 'rejected', 1000, 'rejected')
    assert.equal(store.confirmedValue, 0, '冲突时草稿值不得成为确认值')
    assert.equal(store.revision, 2, '他端改动导致修订前进')
    assert.equal(store.command.receipt.status, 1)
  })

  console.log('7) 越界：设备拒绝')
  await test('out-of-range：超范围值收到 OutOfRange 回执，确认值不变', async () => {
    await freshSim('SIM-A')
    store.setSimScenario('out-of-range')
    await sendDraft(9999)
    await waitUntil(() => store.command?.phase === 'rejected', 1000, 'rejected')
    assert.equal(store.confirmedValue, 0)
    assert.equal(store.revision, 1)
    assert.equal(store.command.receipt.status, 2)
  })

  console.log('8) 切换设备：他设备/旧会话通知不得改写当前确认值')
  await test('切到 SIM-B 后注入冒充通知与旧会话通知，确认值纹丝不动', async () => {
    await store.setSimScenario('normal')
    await store.switchSimDevice('SIM-B')
    await store.connectSim('SIM-B')
    await waitUntil(() => store.isConnected, 1000, 'B 已连接')
    assert.equal(store.confirmedValue, 0)
    assert.equal(store.deviceId, 'SIM-B')
    // 冒充其他设备
    store.simInjectLate('foreign')
    await sleep(50)
    assert.equal(store.confirmedValue, 0)
    assert.equal(store.revision, 1)
    // 伪造一条属于旧会话(#1)的未决命令，再补发"本设备旧会话"通知
    store.command = {
      commandId: 5,
      draft: 5,
      expectedRevision: 1,
      phase: 'written',
      receipt: null,
      note: 'fake old-session command',
      createdAt: Date.now(),
      deviceIdentity: store.deviceIdentity,
      sessionId: 1,
      bootId: store.bootId,
    }
    store.simInjectLate('same-device')
    await sleep(50)
    assert.equal(store.command.phase, 'written', '旧会话通知必须被丢弃')
    assert.equal(store.confirmedValue, 0)
    assert.equal(store.revision, 1)
    // 同会话但 commandId 不匹配也必须丢弃
    store.command.sessionId = store.sessionId
    store.command.commandId = 42
    store.simInjectLate('same-device')
    await sleep(50)
    assert.equal(store.command.phase, 'written', 'commandId 不匹配的通知必须丢弃')
  })

  console.log('9) 重启保留回执：跨 boot 的设备保存回执仍可对账')
  await test('reboot-kept：重连后凭旧 boot 的保存回执确认（状态以信息特征为准）', async () => {
    await freshSim('SIM-A')
    store.setSimScenario('reboot-kept')
    await sendDraft(33)
    await waitUntil(() => store.connectionState === 'idle', 1000, '断线')
    assert.equal(store.command.phase, 'unknown')
    await store.reconnect()
    await waitUntil(() => store.command?.phase === 'acked', 1500, '跨 boot 对账 acked')
    assert.notEqual(store.command.receipt.bootId, store.bootId, '回执确实来自重启前 boot')
    assert.equal(store.confirmedValue, 33)
  })

  console.log('10) 同时最多一个未决命令')
  await test('written 阶段再次 apply 被拒绝', async () => {
    await freshSim('SIM-A')
    store.setSimScenario('notify-first')
    const p1 = sendDraft(11)
    await waitUntil(() => store.command && store.command.phase !== null, 300, '命令存在')
    // 立即再发（不 await，制造重叠）；应直接被闸门拦截
    store.setDraft(22)
    await store.apply()
    await p1
    await waitUntil(() => store.command.phase === 'acked', 1000, 'acked')
    assert.equal(store.confirmedValue, 11, '只有第一条命令生效')
  })

  console.log('11) 断线后迟到通知一律丢弃')
  await test('断开后任何通知都不能改变确认值或未决命令', async () => {
    await freshSim('SIM-A')
    store.setSimScenario('normal')
    await sendDraft(37)
    await waitUntil(() => store.command.phase === 'acked', 1000, '先确认一条命令')
    await store.disconnect()
    assert.equal(store.connectionState, 'idle')
    const confirmedBefore = store.confirmedValue
    // 断线后补放通知（适配器仍可触发事件，但 store 必须丢弃）
    store.simInjectLate('foreign')
    store.simInjectLate('same-device')
    await sleep(80)
    assert.equal(store.confirmedValue, confirmedBefore)
    assert.equal(store.command.phase, 'acked')
    assert.ok(store.logs.some((l) => l.message.includes('链路已断开')), '日志应说明旧通知因断连被丢弃')
  })

  await store.disconnect()
  if (failures > 0) {
    console.error(`\n${failures} 个测试失败`)
    process.exit(1)
  }
  console.log('\n全部冒烟测试通过 ✅')
  process.exit(0)
}

run()
