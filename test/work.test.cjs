// work 通道（0.3）：信令状态机 + 分片器 + 目标解析的单测。
// 分片器协议两端一致（qt WorkFramer），这里只验客户端实现自身的往返。

const test = require('node:test')
const assert = require('node:assert/strict')

const { WorkSignaling } = require('../.tmp/worksignaling.cjs')
const { encode, WorkFramer, WHOLE_LIMIT, CHUNK, MESSAGE_LIMIT } = require('../.tmp/workframer.cjs')
const { parseTarget, targetToText } = require('../.tmp/targetparse.cjs')

// MARK: 信令状态机

function rig() {
  const sent = []
  const events = []
  const signaling = new WorkSignaling(
    {
      sendCallFrame: (botID, event, data) => sent.push({ botID, event, data }),
      accountID: () => 42
    },
    (event) => events.push(event)
  )
  return { signaling, sent, events }
}

test('work 信令：拨号 → 接受 → 互送 → 挂断', () => {
  const { signaling, sent, events } = rig()
  signaling.dial(100)
  // 发出 p2p_request(callType work)
  assert.equal(sent[0].event, 'p2p_request')
  assert.equal(sent[0].data.callType, 'work')
  assert.equal(sent[0].data.fromUserId, 42)
  const requestId = sent[0].data.requestId
  assert.ok(requestId)

  // 接受 → 渲染进程收到 accepted
  signaling.onResponse(requestId, true, '')
  assert.equal(events[0].kind, 'accepted')

  // 渲染进程发 offer → p2p_signaling
  signaling.send('offer', 'v=0…')
  assert.equal(sent[1].event, 'p2p_signaling')
  assert.equal(sent[1].data.type, 'offer')
  assert.equal(sent[1].data.payload, 'v=0…')

  // 对端 answer → 渲染进程
  signaling.onSignal(requestId, 'answer', 'a=…')
  assert.equal(events[1].kind, 'signal')
  assert.equal(events[1].type, 'answer')

  // 挂断（已接受 → hangup）
  signaling.hangup()
  assert.equal(sent[2].data.type, 'hangup')
  assert.equal(events[2].kind, 'ended')
  assert.equal(signaling.isActive, false)
})

test('work 信令：重复拨号：旧的作废，信令只认新的 requestId', () => {
  const { signaling, sent, events } = rig()
  signaling.dial(100)
  const first = sent[0].data.requestId
  signaling.dial(100)
  const second = sent[1].data.requestId
  assert.notEqual(first, second)
  // 旧 requestId 的信令不再认
  signaling.onResponse(first, true, '')
  assert.equal(events.filter((item) => item.kind === 'accepted').length, 0)
  signaling.onResponse(second, true, '')
  assert.equal(events.filter((item) => item.kind === 'accepted').length, 1)
})

test('work 信令：被拒（不同 reason 有不同说法），requestId 不对的一律忽略', () => {
  const { signaling, events } = rig()
  signaling.dial(100)
  // 别的 requestId 的帧：忽略
  signaling.onResponse('别人家的', true, '')
  signaling.onSignal('别人家的', 'offer', 'x')
  assert.equal(events.length, 0)
  assert.equal(signaling.isActive, true)
})

test('work 信令：还没被接受就挂断 → request_cancel（口径同 CallService）', () => {
  const { signaling, sent } = rig()
  signaling.dial(100)
  signaling.hangup()
  assert.equal(sent[1].data.type, 'request_cancel')
})

test('work 信令：hangup 带「新的连接来了」→ ended 标记 replaced（上层不重拨）', () => {
  const { signaling, sent, events } = rig()
  signaling.dial(100)
  const requestId = sent[0].data.requestId
  signaling.onResponse(requestId, true, '')
  // 旧版服务端（≤ 2.43）新拨顶旧时发的 hangup：reason 在信令帧顶层
  signaling.onSignal(requestId, 'hangup', '', '新的连接来了')
  assert.equal(events.at(-1).kind, 'ended')
  assert.equal(events.at(-1).replaced, true)
  assert.ok(events.at(-1).reason.includes('另一台设备'))
})

test('work 信令：普通 hangup / 别的 reason → 不算被顶，照旧重拨', () => {
  const { signaling, sent, events } = rig()
  signaling.dial(100)
  const requestId = sent[0].data.requestId
  signaling.onResponse(requestId, true, '')
  // 无 reason（服务端收尾不带原因）、别的 reason（通道断了）
  signaling.onSignal(requestId, 'hangup', '')
  assert.equal(events.at(-1).replaced, false)
  assert.equal(events.at(-1).reason, '机器人挂断了工作连接')

  const second = rig()
  second.signaling.dial(100)
  second.signaling.onResponse(second.sent[0].data.requestId, true, '')
  second.signaling.onSignal(second.sent[0].data.requestId, 'hangup', '', '通道断了')
  assert.equal(second.events.at(-1).replaced, false)
})

test('work 信令：英文机器码 replaced 也认（服务端未来换成机器可读码）', () => {
  const { signaling, sent, events } = rig()
  signaling.dial(100)
  const requestId = sent[0].data.requestId
  signaling.onSignal(requestId, 'hangup', '', 'replaced')
  assert.equal(events.at(-1).replaced, true)
})

// MARK: 分片器

test('小消息：一条文本帧原样往返', () => {
  const message = JSON.stringify({ method: 'ping', id: 1 })
  const frames = encode(message)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].binary, false)
  const framer = new WorkFramer()
  const bytes = Buffer.from(frames[0].data, 'utf8')
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const result = framer.feed(false, buffer)
  assert.equal(result.state, 'ready')
  assert.equal(result.message, message)
})

test('大消息：切片乱序重组（每片 ≤ 128KB，条数向上取整）', () => {
  const payload = 'x'.repeat(WHOLE_LIMIT + Math.floor(CHUNK / 2))
  const frames = encode(payload)
  assert.ok(frames.length >= 2)
  for (const frame of frames) assert.equal(frame.binary, true)
  assert.ok(frames.every((frame) => frame.data.byteLength <= CHUNK + 19))

  const framer = new WorkFramer()
  let ready = null
  // 倒序喂（DataChannel 有序，这里验重组不依赖到达顺序）
  for (let index = frames.length - 1; index >= 0; index--) {
    const result = framer.feed(true, frames[index].data)
    if (result.state === 'ready') ready = result.message
    else assert.equal(result.state, 'more')
  }
  assert.equal(ready, payload)
})

test('两条大消息交错：各自的 sid 各自拼回', () => {
  const first = 'a'.repeat(WHOLE_LIMIT + 1000)
  const second = 'b'.repeat(WHOLE_LIMIT + 2000)
  const framesA = encode(first)
  const framesB = encode(second)
  assert.ok(framesA.length >= 2 && framesB.length >= 2)

  const framer = new WorkFramer()
  const done = []
  const count = Math.max(framesA.length, framesB.length)
  for (let index = 0; index < count; index++) {
    if (index < framesA.length) {
      const result = framer.feed(true, framesA[index].data)
      if (result.state === 'ready') done.push(result.message)
    }
    if (index < framesB.length) {
      const result = framer.feed(true, framesB[index].data)
      if (result.state === 'ready') done.push(result.message)
    }
  }
  assert.deepEqual(done.sort(), [first, second].sort())
})

test('协议错：坏 magic / 重复片 → invalid', () => {
  const framer = new WorkFramer()
  assert.equal(framer.feed(true, new ArrayBuffer(4)).state, 'invalid')

  const frames = encode('y'.repeat(WHOLE_LIMIT + 1))
  const dup = new WorkFramer()
  assert.equal(dup.feed(true, frames[0].data).state, 'more')
  assert.equal(dup.feed(true, frames[0].data).state, 'invalid')
})

// MARK: 目标解析

test('work:<botUserID> 解析与序列化', () => {
  const target = parseTarget('work:12345')
  assert.deepEqual(target, { kind: 'work', botUserID: 12345 })
  assert.equal(targetToText(target), 'work:12345')
  assert.equal(parseTarget('work:abc'), null)
  assert.equal(parseTarget('work:0'), null)
  assert.equal(parseTarget('work:-3'), null)
})

test('work 信令：not_friends / user_rejected 标记 permanent（上层不再自动重拨），其他拒绝不标', () => {
  for (const [reason, permanent] of [['not_friends', true], ['user_rejected', true], ['error', false], ['busy', false]]) {
    const { signaling, events } = rig()
    signaling.dial(100)
    signaling.onResponse(signaling.currentRequestID(), false, reason)
    const ended = events.find((event) => event.kind === 'ended')
    assert.ok(ended, reason)
    assert.equal(!!ended.permanent, permanent, reason)
  }
  const { signaling, events } = rig()
  signaling.dial(100)
  signaling.onResponse(signaling.currentRequestID(), false, 'not_friends')
  assert.match(events[0].reason, /好友/)
})
