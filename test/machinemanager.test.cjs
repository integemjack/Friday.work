// 机器连接（0.3 work 通道）：被同一账号另一台设备顶掉时不自动重拨（防止互踢循环）。

const test = require('node:test')
const assert = require('node:assert/strict')

const { MachineConnection } = require('../.tmp/machinemanager.cjs')

function rig() {
  const frames = [] // 协议进程发出的 p2p_* 信令帧
  const stateChanges = []
  const host = {
    appVersion: 'test',
    onStateChange: (connection) => stateChanges.push({ state: connection.state, detail: connection.detail }),
    onEvent: () => {},
    workSignalingHost: () => ({
      sendCallFrame: (botID, event, data) => frames.push({ botID, event, data }),
      accountID: () => 42
    }),
    workPortSend: () => {}
  }
  const connection = new MachineConnection('m1', '测试机', { kind: 'work', botUserID: 100 }, host)
  connection.connect()
  return { connection, frames, stateChanges }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('被另一台设备顶掉（hangup reason=新的连接来了）：失败原因写明、不自动重拨', async () => {
  const { connection, frames, stateChanges } = rig()
  const requestId = frames[0].data.requestId
  assert.equal(frames[0].event, 'p2p_request')
  // 服务端接受，之后旧版服务端（≤2.43）发来顶掉的 hangup（reason 在信令帧顶层）
  assert.equal(connection.handleWorkEnvelope('p2p_response', { requestId, accepted: true, fromUserId: 100 }), true)
  assert.equal(
    connection.handleWorkEnvelope('p2p_signaling', { requestId, type: 'hangup', payload: '', reason: '新的连接来了', fromUserId: 100 }),
    true
  )
  const last = stateChanges.at(-1)
  assert.equal(last.state, 'failed')
  assert.ok(last.detail.includes('另一台设备'), last.detail)
  // 第一个退避是 1 秒：等过这个点，确认没有再拨（互踢循环就是从这里的重拨开始的）
  await sleep(1300)
  assert.equal(frames.filter((frame) => frame.event === 'p2p_request').length, 1)
})

test('普通 hangup（没被顶）：照旧退避重拨（用新的 requestId）', async () => {
  const { connection, frames } = rig()
  const requestId = frames[0].data.requestId
  connection.handleWorkEnvelope('p2p_response', { requestId, accepted: true, fromUserId: 100 })
  connection.handleWorkEnvelope('p2p_signaling', { requestId, type: 'hangup', payload: '', reason: '通道断了', fromUserId: 100 })
  await sleep(1300)
  const dials = frames.filter((frame) => frame.event === 'p2p_request')
  assert.equal(dials.length, 2)
  assert.notEqual(dials[1].data.requestId, dials[0].data.requestId)
  connection.disconnect()
})

test('机器人接受后迟迟建不好通道（ICE 不通 / 接受帧丢了）：看门狗到点报失败并退避重拨，不再永远「正在呼叫」', async () => {
  const frames = []
  const stateChanges = []
  const host = {
    appVersion: 'test',
    workConnectTimeoutMs: 200,
    onStateChange: (connection) => stateChanges.push({ state: connection.state, detail: connection.detail }),
    onEvent: () => {},
    workSignalingHost: () => ({ sendCallFrame: (botID, event, data) => frames.push({ botID, event, data }), accountID: () => 42 }),
    workPortSend: () => {}
  }
  const connection = new MachineConnection('m1', '测试机', { kind: 'work', botUserID: 100 }, host)
  connection.connect()
  const requestId = frames[0].data.requestId
  connection.handleWorkEnvelope('p2p_response', { requestId, accepted: true, fromUserId: 100 })
  assert.ok(stateChanges.some((change) => change.detail?.includes('已接听')), '接受后状态文案往前走')
  await sleep(350)
  const failed = stateChanges.find((change) => change.state === 'failed')
  assert.ok(failed, '到点报失败')
  assert.ok(failed.detail.includes('WebRTC 通道'), failed.detail)
  await sleep(1300)
  assert.equal(frames.filter((frame) => frame.event === 'p2p_request').length, 2, '退避后重拨了')
  connection.disconnect()
})

test('通道按时打开：看门狗收掉，不会在握手阶段被误判超时', async () => {
  const frames = []
  const stateChanges = []
  const host = {
    appVersion: 'test',
    workConnectTimeoutMs: 200,
    onStateChange: (connection) => stateChanges.push({ state: connection.state, detail: connection.detail }),
    onEvent: () => {},
    workSignalingHost: () => ({ sendCallFrame: (botID, event, data) => frames.push({ botID, event, data }), accountID: () => 42 }),
    workPortSend: () => {}
  }
  const connection = new MachineConnection('m1', '测试机', { kind: 'work', botUserID: 100 }, host)
  connection.connect()
  connection.handleWorkEnvelope('p2p_response', { requestId: frames[0].data.requestId, accepted: true, fromUserId: 100 })
  connection.handleWorkOpen()
  assert.ok(stateChanges.at(-1).detail.includes('握手'), stateChanges.at(-1).detail)
  await sleep(350)
  assert.ok(!stateChanges.some((change) => change.detail?.includes('没建好')), '看门狗没误触发')
  connection.disconnect()
})

test('机器人不在好友里（not_friends）：原因写明、停止自动重拨', async () => {
  const { connection, frames, stateChanges } = rig()
  const requestId = frames[0].data.requestId
  connection.handleWorkEnvelope('p2p_response', { requestId, accepted: false, reason: 'not_friends', fromUserId: 100 })
  const last = stateChanges.at(-1)
  assert.equal(last.state, 'failed')
  assert.ok(last.detail.includes('好友'), last.detail)
  assert.ok(!last.detail.includes('秒后重试'), '没排重拨')
  await sleep(1300)
  assert.equal(frames.filter((frame) => frame.event === 'p2p_request').length, 1)
  // 手动重连照常能拨
  connection.connect()
  assert.equal(frames.filter((frame) => frame.event === 'p2p_request').length, 2)
  connection.disconnect()
})
