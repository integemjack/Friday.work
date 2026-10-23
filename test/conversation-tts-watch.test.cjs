// 复现并锁定「会话里播几次后 TTS 不再合成播放，换新会话能播，旧会话新回复仍不播」：
// 把 AssistantChat.vue 会话模式的播报 watch 复刻到这里（真 Vue reactivity，随产品代码同步），
// 配真实的 speechOutput 泵（.tmp/speechoutput.cjs）+ 受控 mock 桥（学 speechoutput.test.cjs）。
// 锁定的行为：
//  - 新会话/刚订阅的会话，进入监听后流式长出来的文本要播（旧 bug：首帧整片被当历史丢掉）；
//  - 会话被订阅上限淘汰/关掉再重订阅，快照里已完成的历史不重播、新回复照播（旧 bug：念旧账）；
//  - 服务端重推历史换了块 id，完结消息不重播（旧 bug：新 key 游标从 0 整条重播）；
//  - 合成失败一次后，同会话后续回复恢复送合成（泵自愈）。
// 依赖 run-tests.cjs 先编译出 .tmp/protocol.cjs 和 .tmp/speechoutput.cjs（vue 直接 require node_modules）。
const test = require('node:test')
const assert = require('node:assert')
const { reactive, computed, watch, nextTick } = require('vue')

const speech = require('../.tmp/speechoutput.cjs')
const { blockCase, blockPayload } = require('../.tmp/protocol.cjs')
const { createSpeechIncrement } = speech

// ---- mock 桥：记录每次合成调用、手动放行（空 samples 让泵跳过播放，不碰 AudioContext） ----
function mockBridge() {
  const calls = []
  const pending = []
  globalThis.window = {
    fridayBridge: {
      speakReply: ({ text }) => {
        calls.push(text)
        return new Promise((resolve, reject) => pending.push({ resolve, reject }))
      },
      cancelCosyVoice: () => Promise.resolve()
    }
  }
  const flushMicro = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  const release = (value) => {
    const p = pending.shift()
    if (p) p.resolve(value ?? { samples: new Float32Array(0), sampleRate: 24000 })
  }
  const fail = (message) => {
    const p = pending.shift()
    if (p) p.reject(new Error(message ?? '和语音引擎的连接断了'))
  }
  const drain = async () => {
    while (pending.length) {
      release()
      await flushMicro()
    }
  }
  const restore = () => {
    speech.stopSpeaking()
    for (const p of pending.splice(0)) p.resolve({ samples: new Float32Array(0), sampleRate: 24000 })
    delete globalThis.window
  }
  return { calls, release, fail, flushMicro, drain, restore }
}

// ---- 复刻 AssistantChat.vue 会话模式 watch（与产品代码保持一致，仅替换依赖名） ----
function setupWatch(store) {
  const conversationID = computed(() => store.activeConversationID)
  const seenConversations = new Set()
  const seenMessageFinish = new Map()
  const blockStreams = new Map()
  const stop = watch(
    () => {
      const snapshot = []
      // 会话清单项：本帧监听范围内有哪些会话（含没有任何消息的），豁免判定的单位
      snapshot.push({ key: '__convs__', convs: Object.keys(store.details) })
      for (const conv of Object.keys(store.details)) {
        const current = conv === conversationID.value
        for (const { message } of store.details[conv]?.messages ?? []) {
          if (message.role === 'user') {
            if (current) snapshot.push({ key: `u:${conv}:${message.id}`, user: true })
            continue
          }
          if (message.role !== 'assistant') continue
          const lens = (message.blocks ?? [])
            .map((block) =>
              blockCase(block) === 'text' ? `${block.id}:${String(blockPayload(block, 'text') ?? '').length}` : ''
            )
            .join('|')
          snapshot.push({
            key: `a:${conv}:${message.id}`,
            conv,
            msgID: message.id,
            finishedAt: message.finishedAt,
            stoppedByUser: message.stoppedByUser,
            error: message.error,
            notice: message.notice,
            lens
          })
        }
      }
      return snapshot
    },
    (list, prev) => {
      const initial = prev === undefined
      const freshConvs = new Set()
      for (const conv of list.find((item) => item.key === '__convs__')?.convs ?? []) {
        if (!seenConversations.has(conv)) freshConvs.add(conv)
      }
      for (const conv of freshConvs) seenConversations.add(conv)
      for (const item of list) {
        if (item.key === '__convs__') continue
        if (item.user) {
          seenMessageFinish.set(item.key, undefined)
          continue
        }
        if (item.conv === undefined || item.msgID === undefined) continue
        const entry = store.details[item.conv]?.messages.find((candidate) => candidate.message.id === item.msgID)
        if (!entry) continue
        const before = seenMessageFinish.get(item.key)
        const done = !!item.finishedAt
        const historical = initial || freshConvs.has(item.conv)
        const justFinished = !initial && done && !before && !historical
        const speakable = !item.stoppedByUser && !item.error && !item.notice
        for (const block of entry.message.blocks ?? []) {
          if (blockCase(block) !== 'text') continue
          const full = String(blockPayload(block, 'text') ?? '')
          const key = `${item.conv}:${item.msgID}:${block.id}`
          let stream = blockStreams.get(key)
          if (!stream) {
            // 完结消息里「新出现的块」= 服务端重推历史换了块 id：念过了，不重播
            stream = { inc: createSpeechIncrement(), len: historical || done ? full.length : 0 }
            blockStreams.set(key, stream)
          }
          if (!historical && speakable && full.length > stream.len) stream.inc.push(full.slice(stream.len))
          if (full.length !== stream.len) stream.len = full.length
          if (justFinished && speakable) stream.inc.flush()
        }
        seenMessageFinish.set(item.key, item.finishedAt)
      }
    },
    { immediate: true }
  )
  return { stop, seenConversations, blockStreams, seenMessageFinish }
}

// ---- store / 消息模拟 ----
function freshStore() {
  return reactive({ details: {}, activeConversationID: 'A' })
}

let seq = 0
function newDetail() {
  return { messages: [], nodes: [] }
}
function pushMessage(conv, message) {
  store.details[conv].messages.push({ message, version: 0 })
}
function userMsg(text) {
  seq += 1
  return { id: `u${seq}`, role: 'user', blocks: text ? [{ id: `ub${seq}`, kind: { text } }] : [] }
}
function assistantMsg() {
  seq += 1
  return { id: `a${seq}`, role: 'assistant', blocks: [{ id: `ab${seq}`, kind: { text: '' } }] }
}
/** 从 reactive store 里拿回 proxy 引用（对原始对象赋值不触发依赖，真实链路走 applyMessagePatch 的 Object.assign 到 proxy） */
function liveMessage(conv, id) {
  const found = store.details[conv]?.messages.find((candidate) => candidate.message.id === id)
  return found?.message
}
/** 流式一片：模拟 applyMessagePatch（整块替换、id 不变），赋值走 proxy */
function streamChunk(conv, message, chunk) {
  const live = liveMessage(conv, message.id)
  if (!live) throw new Error('找不到消息')
  const block = live.blocks[0]
  const prev = blockPayload(block, 'text') ?? ''
  live.blocks = [{ id: block.id, kind: { text: prev + chunk } }]
}
function finishMessage(conv, message) {
  const live = liveMessage(conv, message.id)
  if (live) live.finishedAt = new Date().toISOString()
}
/** 一轮完整回复：push user + assistant 流式几片 + finishedAt（全部走 proxy） */
async function oneReply(conv, chunks) {
  pushMessage(conv, userMsg('问题'))
  const m = assistantMsg()
  pushMessage(conv, m)
  for (const chunk of chunks) {
    streamChunk(conv, m, chunk)
    await nextTick()
  }
  finishMessage(conv, m)
  await nextTick()
  return m
}

let store

test.beforeEach(() => {
  store = freshStore()
  store.details.A = newDetail()
})

// ---- 基线：会话 A 从进入监听起的流式回复逐句实时播（含第一条的第一片） ----
test('基线：A 会话连续两轮回复逐句送合成（第一句也要播）', async () => {
  const { calls, drain, flushMicro, restore } = mockBridge()
  const w = setupWatch(store)
  try {
    await nextTick() // watch immediate 跑一帧：A（空）登记进监听
    await oneReply('A', ['第一句正常。', '第二句也正常。'])
    await flushMicro()
    await drain()
    await oneReply('A', ['第二轮的句子。'])
    await flushMicro()
    await drain()
    assert.ok(calls.includes('第一句正常。'), `会话进入监听后的第一句要播（calls=${JSON.stringify(calls)}）`)
    assert.ok(calls.includes('第二句也正常。'))
    assert.ok(calls.includes('第二轮的句子。'))
  } finally {
    w.stop()
    restore()
  }
})

// ---- 扰动 1：某句合成失败（引擎死亡），A 的后续新回复恢复送合成 ----
test('扰动：合成失败一次后，同会话的新回复应恢复送合成', async () => {
  const { calls, release, fail, flushMicro, drain, restore } = mockBridge()
  const w = setupWatch(store)
  try {
    await nextTick()
    await oneReply('A', ['第一句正常。', '第二句也正常。'])
    await flushMicro()
    release() // 第一句成功
    await flushMicro()
    fail('和语音引擎的连接断了') // 第二句失败（引擎死亡）
    await flushMicro()
    assert.ok(calls.includes('第一句正常。'), '失败前的句子已送合成')
    await oneReply('A', ['新回复的句子。'])
    await flushMicro()
    assert.ok(
      calls.includes('新回复的句子。'),
      `失败自愈：新回复重新送合成（calls=${JSON.stringify(calls)}）`
    )
    await drain()
  } finally {
    w.stop()
    restore()
  }
})

// ---- 扰动 2：服务端重推会话快照（messages 整体换成新对象，同 id）----
test('扰动：会话快照整体重推后，A 的新回复应照常播', async () => {
  const { calls, drain, flushMicro, restore } = mockBridge()
  const w = setupWatch(store)
  try {
    await nextTick()
    await oneReply('A', ['快照前的句子。'])
    await flushMicro()
    await drain()
    // applyConversationSnapshot + rebuildPath：messages 换成新数组、消息对象换成服务端来的新对象（同 id、同内容）
    const old = store.details.A.messages.map((e) => e.message)
    store.details.A.messages = old.map((m) => ({
      message: { ...m, blocks: m.blocks.map((b) => ({ ...b, kind: { ...b.kind } })) },
      version: 1
    }))
    await nextTick()
    await oneReply('A', ['重推之后的新句子。'])
    await flushMicro()
    await drain()
    assert.ok(calls.includes('快照前的句子。'), '快照前的句子播过')
    assert.ok(
      calls.filter((c) => c === '快照前的句子。').length === 1,
      `快照重推不重播旧句（calls=${JSON.stringify(calls)}）`
    )
    assert.ok(calls.includes('重推之后的新句子。'), '重推后新回复照常播')
  } finally {
    w.stop()
    restore()
  }
})

// ---- 扰动 3：A 被淘汰（订阅上限）后重新订阅，不重播历史、新回复照播 ----
test('扰动：会话被淘汰再重订阅，不重播旧账、A 的新回复照常播', async () => {
  const { calls, drain, flushMicro, restore } = mockBridge()
  const w = setupWatch(store)
  try {
    await nextTick()
    await oneReply('A', ['淘汰前的句子。'])
    await flushMicro()
    await drain()
    // closeConversation：delete details[A]（组件的 blockStreams/seenConversations 不清）
    delete store.details.A
    await nextTick()
    // 重新订阅：新 detail、新消息对象（同 message id / block id，内容=已完成状态）
    store.details.A = newDetail()
    for (const message of [
      { id: 'u9', role: 'user', blocks: [] },
      { id: 'a9', role: 'assistant', blocks: [{ id: 'ab9', kind: { text: '淘汰前的句子。' } }], finishedAt: new Date().toISOString() }
    ]) {
      store.details.A.messages.push({ message, version: 0 })
    }
    await nextTick()
    await oneReply('A', ['重订阅之后的新句子。'])
    await flushMicro()
    await drain()
    assert.equal(
      calls.filter((c) => c === '淘汰前的句子。').length,
      1,
      `重订阅不重播旧账（calls=${JSON.stringify(calls)}）`
    )
    assert.ok(calls.includes('重订阅之后的新句子。'), '重订阅后新回复照常播')
  } finally {
    w.stop()
    restore()
  }
})

// ---- 扰动 4：完结消息被服务端重推、块 id 换新——旧句不重播、新回复照播 ----
test('扰动：重推历史块 id 换新，旧句不重播、新回复照播', async () => {
  const { calls, drain, flushMicro, restore } = mockBridge()
  const w = setupWatch(store)
  try {
    await nextTick()
    const m = await oneReply('A', ['旧 id 的句子。'])
    await flushMicro()
    await drain()
    // 服务端重推：同一条消息，text 块 id 换新（内容一样）——也走 proxy
    const live = liveMessage('A', m.id)
    live.blocks = [{ id: 'newblock1', kind: { text: '旧 id 的句子。' } }]
    await nextTick()
    await oneReply('A', ['块 id 换新后的新句子。'])
    await flushMicro()
    await drain()
    assert.ok(calls.includes('块 id 换新后的新句子。'), `新回复照播（calls=${JSON.stringify(calls)}）`)
    assert.equal(calls.filter((c) => c === '旧 id 的句子。').length, 1, '旧句不因块 id 换新重播')
  } finally {
    w.stop()
    restore()
  }
})

// ---- 组合：A 播两轮→淘汰重订阅→B 新会话播→A 再有新回复（用户报的症状序列） ----
test('组合复现：A 播两轮→淘汰 A→B 新会话播→A 重订阅后有新回复', async () => {
  const { calls, drain, flushMicro, restore } = mockBridge()
  const w = setupWatch(store)
  try {
    await nextTick()
    await oneReply('A', ['A 的第一句。'])
    await flushMicro()
    await drain()
    await oneReply('A', ['A 的第二句。'])
    await flushMicro()
    await drain()
    assert.ok(calls.includes('A 的第一句。') && calls.includes('A 的第二句。'), 'A 前两轮正常播')
    // 换新会话 B（用户操作：新建会话并打开；真实场景里这一步可能把 A 挤出订阅上限）
    store.details.B = newDetail()
    store.activeConversationID = 'B'
    await nextTick()
    await oneReply('B', ['B 的新句子。'])
    await flushMicro()
    await drain()
    assert.ok(calls.includes('B 的新句子。'), 'B 会话照播')
    // A 被淘汰后重新打开（重订阅，已有内容当历史），再收到新回复
    delete store.details.A
    await nextTick()
    store.details.A = newDetail()
    store.details.A.messages.push({
      message: { id: 'a9', role: 'assistant', blocks: [{ id: 'ab9', kind: { text: 'A 的第一句。A 的第二句。' } }], finishedAt: new Date().toISOString() },
      version: 0
    })
    store.activeConversationID = 'A'
    await nextTick()
    await oneReply('A', ['A 后来的新句子。'])
    await flushMicro()
    await drain()
    assert.ok(calls.includes('A 后来的新句子。'), `A 重开后的新回复照常播（calls=${JSON.stringify(calls)}）`)
    assert.equal(calls.filter((c) => c === 'A 的第一句。').length, 1, '历史不重播')
  } finally {
    w.stop()
    restore()
  }
})
