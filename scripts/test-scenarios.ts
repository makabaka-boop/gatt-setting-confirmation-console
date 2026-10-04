/* 逻辑验收：不依赖浏览器，直接驱动 store + MockAdapter */
import { useController } from '../src/store/controller'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name} ${extra}`)
  }
}

async function main(): Promise<void> {
  const c = useController()
  const s = c.state

  // ① 正常确认
  console.log('① 正常确认')
  await c.connect()
  await sleep(300)
  check('已连接', s.connection === 'connected')
  check('初始实际值 20 / 修订 1', s.info?.setpoint === 20 && s.info.revision === 1)
  s.draft = '30'
  await c.submitCommand()
  check('发出后立即处于 pending', s.pending?.outcome === 'pending')
  await sleep(1200)
  check('收到通知后 confirmed', s.pending?.outcome === 'confirmed')
  check('结论来源 notify', s.pending?.source === 'notify')
  check('确认值随回执更新为 30', s.info?.setpoint === 30 && s.info.revision === 2)
  c.dismissResult()

  // ② 通知先到
  console.log('② 通知先于写入完成')
  c.selectPreset('notify-first')
  s.draft = '31'
  await c.submitCommand()
  await sleep(500)
  check('t_notify=400 时、t_write=600 前已经确认', s.pending?.outcome === 'confirmed', s.pending?.outcome)
  check('确认值=31 修订=3', s.info?.setpoint === 31 && s.info.revision === 3)
  await sleep(300)
  check('写入兑现后结论不被改写', s.pending?.outcome === 'confirmed')
  c.dismissResult()

  // ③ 写入后断线 → 重连凭设备保存回执对账
  console.log('③ 写入后断线，重连对账')
  c.selectPreset('drop-after-write')
  s.draft = '32'
  await c.submitCommand() // 内部已等待 t_write=300
  await sleep(300)
  check('写入(300)已兑现、断线(700)前仍是 pending', s.pending?.outcome === 'pending', s.pending?.outcome)
  await sleep(250)
  check('t_drop=700 后连接断开', s.connection === 'disconnected')
  check('未决被标记为结果未知', s.pending?.outcome === 'unknown')
  await c.reconnect()
  await sleep(300)
  check('重连后对账成功 confirmed', s.pending?.outcome === 'confirmed', s.pending?.outcome)
  check('来源 reconnect', s.pending?.source === 'reconnect')
  check('确认值取自信息特征=32 修订=4', s.info?.setpoint === 32 && s.info.revision === 4)
  c.dismissResult()

  // ④ 重启 + 旧 boot 迟到通知
  console.log('④ 设备重启，旧 boot 通知迟到')
  c.selectPreset('reboot-stale')
  const bootBefore = s.info!.bootId
  s.draft = '33'
  await c.submitCommand()
  await sleep(900)
  check('断线且结果未知', s.connection === 'disconnected' && s.pending?.outcome === 'unknown')
  await c.reconnect()
  await sleep(700) // 等 350ms 的迟到通知触发并被忽略
  check('bootId 已递增', s.info?.bootId === bootBefore + 1)
  check('迟到旧通知未改写结论，仍为对账确认', s.pending?.outcome === 'confirmed' && s.pending.source === 'reconnect')
  check('实际值=33 修订=5', s.info?.setpoint === 33 && s.info.revision === 5)
  c.dismissResult()

  // ⑤ 回执遗失 → 保持未知，不自动重发/不宣称失败
  console.log('⑤ 回执遗失')
  c.selectPreset('receipt-lost')
  s.draft = '34'
  await c.submitCommand()
  await sleep(900)
  await c.reconnect()
  await sleep(300)
  check('查不到本命令回执后保持 unknown', s.pending?.outcome === 'unknown', s.pending?.outcome)
  check('没有新命令被自动发出（仍是同一 commandId #5）', s.pending?.commandId === 5)
  check('信息特征可读：设备实际值=34（设备确实执行了，但页面无法凭无回执宣称确认）', s.info?.setpoint === 34)
  c.abandonUnknown()
  check('用户放弃后可发起新修改（pending 清空）', s.pending === null)

  // ⑥ 修订冲突
  console.log('⑥ 修订冲突')
  c.selectPreset('conflict')
  s.draft = '40'
  await c.submitCommand()
  await sleep(900)
  check('结论 rejected', s.pending?.outcome === 'rejected')
  check('回执带回实际修订/值', s.pending?.receipt?.status === 'conflict')
  check('草稿值 40 没有冒充设备值', s.info?.setpoint !== 40)
  c.dismissResult()

  // ⑦ 注入其他设备/旧会话通知
  console.log('⑦ 外来/迟到通知忽略')
  c.selectPreset('normal')
  s.draft = '41'
  await c.submitCommand()
  await sleep(1100)
  c.mockInjectForeign()
  await sleep(50)
  check('外来通知不改写当前结论', s.pending?.outcome === 'confirmed' && s.info?.setpoint === 41)
  c.dismissResult()
  c.mockInjectForeign()
  await sleep(50)
  check('无未决时的迟到通知被忽略', s.pending === null)

  // ⑧ 切换设备：旧设备未决不能被新设备事件改写
  console.log('⑧ 切换设备')
  c.selectPreset('receipt-lost')
  s.draft = '50'
  await c.submitCommand()
  await sleep(900)
  check('A 设备断线 unknown', s.pending?.outcome === 'unknown' && s.info?.deviceId === 'MOCK-CTRL-A-001')
  await c.disconnect()
  await c.setMockTarget('MOCK-CTRL-B-002')
  await c.connect()
  await sleep(300)
  check('已连到设备 B', s.info?.deviceId === 'MOCK-CTRL-B-002')
  check('B 的确认值是它自己的初始值 20', s.info?.setpoint === 20)
  check('A 的未决已归档停车，不在当前未决位', s.pending === null)
  check('历史里保留了 A 的 unknown 命令', s.history[0]?.outcome === 'unknown')

  // ⑨ 写入完成前断线：断线语义优先（结果未知），不宣称写入成功也不宣称失败
  console.log('⑨ 写入完成前断线')
  c.selectPreset('drop-after-write')
  c.patchTuning({ writeDelayMs: 500, dropDelayMs: 150, execDelayMs: null })
  s.draft = '51'
  await c.submitCommand()
  await sleep(500)
  check('断线先于写入完成 → 结果未知（不重发）', s.pending?.outcome === 'unknown', s.pending?.outcome)
  check('设备未执行（无 exec），B 的实际值未变（20）', s.info?.setpoint === 20)

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
