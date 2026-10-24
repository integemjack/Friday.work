// 复现「一个会话里用户发消息，回复有 TTS；再发一条，回复不播；再发又有」的隔条交替 bug。
// 用真 Vue reactivity 复刻 AssistantChat.vue 会话模式 watch + 真实 speechOutput 泵 + 受控 mock 桥，
// 按服务端（Qt Friday AgentRunner/ReasoningParser/RemoteServer）验证过的行为逐轮送事件：
//   1) 每轮开始：conversation partial 快照（上一条带 finishedAt 的消息 + 新 user 消息，versions 前移）
//   2) 流式：message.patch（块 set，text 块 id 稳定，内容增长）
//   3) 收尾：message.patch 带 finishedAt（可能和最后一次内容合并在同一事件）
// 服务端块结构由 ReasoningParser 每帧重解析生成：
//   - <think> 显式模型：流式期间 [thinking] → [thinking, text(新 id)] → text 增长
//   - 纯 </think> 模型（模板预写 <think>）：流式期间解析不到任何标签 → [text(实为思考)] → </think> 到后
//     [thinking(拿走旧 id), text(新 id)]
//   - 答案极短/最后一帧才出现 text：text 块第一次可见时消息已 finishedAt
// 依赖 .tmp/speechoutput.cjs、.tmp/protocol.cjs（run-tests.cjs 同款编译）。
const test = require('node:test')
const assert = require('node:assert')
const { reactive, computed, watch, nextTick } = require('vue')

const speech = require('../.tmp/speechoutput.cjs')
const { blockCase, blockPayload } = require('../.tmp/protocol.cjs')
const { createSpeechIncrement, setSpeechForeground } = speech

// ---- mock 桥：记录每次合成调用、手动放行 ----
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
  const drain = async () => {
    while (pending.length) {
      pending.shift().resolve({ samples: new Float32Array(0), sampleRate: 24000 })
      await flushMicro()
    }
  }
  const restore = () => {
    speech.stopSpeaking()
    for (const p of pending.splice(0)) p.resolve({ samples: new Float32Array(0), sampleRate: 24000 })
    delete globalThis.window
  }
  return { calls, drain, restore }
}

// ---- 复刻 AssistantChat.vue 会话模式 watch（与产品代码逐行一致） ----
function setupWatch(store) {
  const conversationID = computed(() => store.activeConversationID)
  const stopForeground = watch(conversationID, (conv) => setSpeechForeground(conv ?? ''), { immediate: true })
  const seenConversations = new Set()
  const seenMessageFinish = new Map()
  const blockStreams = new Map()
  const stop = watch(
    () => {
      const snapshot = []
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
            history: !!store.historyMessages[message.id],
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
      const entryIndex = new Map()
      for (const conv of Object.keys(store.details)) {
        for (const candidate of store.details[conv]?.messages ?? []) {
          const key = `${conv}:${candidate.message.id}`
          if (!entryIndex.has(key)) entryIndex.set(key, candidate)
        }
      }
      for (const item of list) {
        if (item.key === '__convs__') continue
        if (item.user) {
          seenMessageFinish.set(item.key, undefined)
          continue
        }
        if (item.conv === undefined || item.msgID === undefined) continue
        const entry = entryIndex.get(`${item.conv}:${item.msgID}`)
        if (!entry) continue
        const before = seenMessageFinish.get(item.key)
        const done = !!item.finishedAt
        const historical = initial || freshConvs.has(item.conv) || !!item.history
        const justFinished = !initial && done && !before && !historical
        const speakable = !item.stoppedByUser && !item.error && !item.notice
        for (const block of entry.message.blocks ?? []) {
          if (blockCase(block) !== 'text') continue
          const full = String(blockPayload(block, 'text') ?? '')
          const key = `${item.conv}:${item.msgID}:${block.id}`
          let stream = blockStreams.get(key)
          if (!stream) {
            stream = { inc: createSpeechIncrement(item.conv), len: 0 }
            blockStreams.set(key, stream)
            // 与产品代码同步：首见即已完结且之前没记录过这条消息的 finishedAt（before 为假）
            // 是新回复的收尾帧，不能当重推跳过；之前记录过完结（before 为真）才是重推
            if (historical || (done && before)) {
              stream.inc.skip(full)
              stream.len = full.length
            }
          }
          if (full.length > stream.len) {
            const grown = full.slice(stream.len)
            if (!historical && speakable) stream.inc.push(grown)
            else stream.inc.skip(grown)
          }
          if (full.length !== stream.len) stream.len = full.length
          if (justFinished && speakable) stream.inc.flush()
        }
        seenMessageFinish.set(item.key, item.finishedAt)
      }
    },
    { immediate: true }
  )
  return {
    stop: () => {
      stop()
      stopForeground()
    },
    seenConversations,
    blockStreams
  }
}

// ---- 会话 / 消息模拟（形状对齐服务端 toJson：{id, role, blocks:[{id, kind:{text|thinking}}], finishedAt}） ----
let seq = 0
function freshStore() {
  return reactive({ details: {}, historyMessages: {}, streamMarks: {}, activeConversationID: 'A' })
}
function userMsg(text) {
  seq += 1
  return { id: `u${seq}`, role: 'user', blocks: text ? [{ id: `ub${seq}`, kind: { text } }] : [] }
}
function textBlock(id, text) {
  return { id, kind: { text } }
}
function thinkingBlock(id, text) {
  return { id, kind: { thinking: text } }
}
/** 模拟 store.applyConversationSnapshot partial 合并 + rebuildPath + noteHistory（逐行对齐产品代码） */
function applyPartialSnapshot(store, conv, nodes) {
  const detail = store.details[conv]
  if (!detail) return
  const byID = new Map(detail.nodes.map((node) => [node.id, node]))
  for (const node of nodes) byID.set(node.id, node)
  detail.nodes = [...byID.values()]
  detail.messages = detail.nodes.map((message) => ({ message, version: 0 }))
  // noteAssistantStream 的 streamMarks 简化版：记下已见块长度
  for (const node of nodes) {
    if (node.role !== 'assistant') continue
    const marks = store.streamMarks[node.id] ?? {}
    for (const block of node.blocks ?? []) {
      const kind = blockCase(block)
      if (kind === 'thinking' || kind === 'text') marks[block.id] = String(blockPayload(block, kind) ?? '').length
    }
    store.streamMarks[node.id] = marks
  }
}
/** noteHistory 简化版（订阅时/整段快照时把已有消息记为历史；运行中的末尾除外） */
function noteHistory(store, conv, live) {
  const detail = store.details[conv]
  const tail = [...detail.messages].reverse().find((e) => e.message.role === 'assistant')?.message
  for (const node of detail.nodes) {
    if (node.role !== 'assistant' || store.historyMessages[node.id] || store.streamMarks[node.id]) continue
    const done = !!(node.finishedAt || node.error || node.stoppedByUser)
    if (node.id === tail?.id && !done && live !== false) {
      if (!live) continue
    } else {
      store.historyMessages[node.id] = true
    }
  }
}
function openConversation(store, conv, nodes) {
  store.details[conv] = { messages: [], nodes: [], selectedChildren: {}, runtime: null, versions: {} }
  if (nodes.length) applyPartialSnapshot(store, conv, nodes)
  noteHistory(store, conv, false)
}
/** 整条替换（message 事件 / refetch）：走 proxy 赋值 */
function applyWholeMessage(store, conv, message) {
  const detail = store.details[conv]
  const index = detail.nodes.findIndex((node) => node.id === message.id)
  if (index >= 0) detail.nodes[index] = message
  else detail.nodes.push(message)
  detail.messages = detail.nodes.map((m) => ({ message: m, version: 0 }))
}
function liveMessage(store, conv, id) {
  return store.details[conv]?.messages.find((c) => c.message.id === id)?.message
}

// ---- 一轮回复：按指定「块结构时序」送事件 ----
// ticks: 每项是一次 message.patch 帧的块数组（对齐服务端每帧重解析的产物）
// finishWith: 收尾帧（blocks + finishedAt 同帧 or 分帧）
async function runRound(store, bridge, name, round, ticks, finalBlocks, finishWithText, repushWithNewIds) {
  const conv = 'A'
  const before = bridge.calls.length // 轮开始前取基线：合成可能在任意一帧的微任务里就发出
  await nextTick()
  // 轮开始：partial 快照（历史消息 + 新 user；已完成的历史照发）；
  // repushWithNewIds：模拟服务端换块 id 重推已完结消息（2026-10 修复场景）
  const historyNodes = []
  for (const node of store.details[conv].nodes) {
    if (node.role === 'assistant' && node.finishedAt) {
      if (repushWithNewIds) {
        historyNodes.push({
          ...node,
          blocks: (node.blocks ?? []).map((block, i) => ({ ...block, id: `${node.id}-repush${i}` }))
        })
      } else {
        historyNodes.push(node)
      }
    }
  }
  const user = userMsg(`第${round}条消息`)
  applyPartialSnapshot(store, conv, [...historyNodes, user])
  // 新的助手消息（先空）
  const msgID = `a-${name}-${round}`
  const reply = { id: msgID, role: 'assistant', blocks: [] }
  applyWholeMessage(store, conv, reply)
  await nextTick()
  // 流式帧
  for (const blocks of ticks) {
    applyWholeMessage(store, conv, { ...reply, blocks })
    await nextTick()
  }
  // 收尾
  if (finishWithText) {
    applyWholeMessage(store, conv, { ...reply, blocks: finalBlocks, finishedAt: '2026-10-24T00:00:00Z' })
    await nextTick()
  } else {
    applyWholeMessage(store, conv, { ...reply, blocks: finalBlocks })
    await nextTick()
    applyWholeMessage(store, conv, { ...reply, blocks: finalBlocks, finishedAt: '2026-10-24T00:00:00Z' })
    await nextTick()
  }
  await bridge.drain()
  return bridge.calls.length - before
}

async function drive(name, rounds, build) {
  const store = freshStore()
  const bridge = mockBridge()
  const w = setupWatch(store)
  openConversation(store, 'A', [])
  const spoke = []
  for (let round = 1; round <= rounds; round++) {
    const { ticks, finalBlocks, finishWithText, repushWithNewIds } = build(round)
    spoke.push(await runRound(store, bridge, name, round, ticks, finalBlocks, finishWithText, repushWithNewIds))
  }
  w.stop()
  bridge.restore()
  return spoke
}

// ================= 用例 =================

test('对照：无思考、文本流式增长——每轮都该播', async () => {
  const spoke = await drive('plain', 4, (round) => {
    const answer = `这是第${round}轮的回复。一共两句话。`
    const half = `这是第${round}轮的回复。`
    return {
      ticks: [
        [textBlock('bx', half)],
        [textBlock('bx', answer)]
      ],
      finalBlocks: [textBlock('bx', answer)],
      finishWithText: false
    }
  })
  console.log('plain 每轮合成次数:', spoke)
  assert.deepEqual(spoke.map((n) => n > 0), [true, true, true, true])
})

test('显式 <think> 模型：先思考流式、答案在收尾前可见——每轮都该播', async () => {
  const spoke = await drive('think', 4, (round) => {
    const answer = `第${round}轮的答案。说完这句就结束。`
    return {
      ticks: [
        [thinkingBlock('bt', `思考第${round}轮的问题。`)],
        [thinkingBlock('bt', `思考第${round}轮的问题。深入一点。`), textBlock('bx', `第${round}轮的答案。`)],
        [thinkingBlock('bt', `思考第${round}轮的问题。深入一点。`), textBlock('bx', answer)]
      ],
      finalBlocks: [thinkingBlock('bt', `思考第${round}轮的问题。深入一点。`), textBlock('bx', answer)],
      finishWithText: false
    }
  })
  console.log('think 每轮合成次数:', spoke)
  assert.deepEqual(spoke.map((n) => n > 0), [true, true, true, true])
})

test('极短答案/内容与 finishedAt 同帧落地（text 块第一次可见即已完结）——修复后也要播（原为静音）', async () => {
  const spoke = await drive('coalesce', 4, (round) => {
    const answer = `第${round}轮一句话答完。`
    // 流式期间只有 thinking；答案只在收尾帧（带 finishedAt）第一次出现
    return {
      ticks: [[thinkingBlock('bt', `先想一想。`)]],
      finalBlocks: [thinkingBlock('bt', `先想一想。`), textBlock('bx', answer)],
      finishWithText: true
    }
  })
  console.log('coalesce 每轮合成次数:', spoke)
  // 修复后：首见即完结且消息没见过 = 新回复的收尾帧，照播
  assert.deepEqual(spoke.map((n) => n > 0), [true, true, true, true])
})

test('修复验证：隔条交替场景修复后每轮都播', async () => {
  const spoke = await drive('alt', 4, (round) => {
    const answer = `第${round}轮的答案。`
    if (round % 2 === 1) {
      return {
        ticks: [
          [thinkingBlock('bt', `想一想。`)],
          [thinkingBlock('bt', `想一想。`), textBlock('bx', `第${round}轮的答案。`)]
        ],
        finalBlocks: [thinkingBlock('bt', `想一想。`), textBlock('bx', answer)],
        finishWithText: false
      }
    }
    return {
      ticks: [[thinkingBlock('bt', `想一想。`)]],
      finalBlocks: [thinkingBlock('bt', `想一想。`), textBlock('bx', answer)],
      finishWithText: true
    }
  })
  console.log('alt(修复后) 每轮合成次数:', spoke)
  assert.deepEqual(spoke.map((n) => n > 0), [true, true, true, true])
})

test('回归保护：之前见过的完结消息被重推且换了块 id——仍不重播（2026-10 修复不倒退）', async () => {
  const spoke = await drive('repush', 3, (round) => {
    const answer = `第${round}轮的答案。就这样。`
    return {
      ticks: [
        [thinkingBlock('bt', `想一想。`)],
        [thinkingBlock('bt', `想一想。`), textBlock('bx', `第${round}轮的答案。`)]
      ],
      finalBlocks: [thinkingBlock('bt', `想一想。`), textBlock('bx', answer)],
      finishWithText: false,
      // 下一轮开始时重推这条完结消息，且换了块 id（服务端换 id 重推场景）：不能重播
      repushWithNewIds: true
    }
  })
  console.log('repush 每轮合成次数:', spoke)
  assert.deepEqual(spoke.map((n) => n > 0), [true, true, true])
})

test('模板模型（只输出 </think>）：思考期被当 text 播、闭合后 thinking 拿走旧 id + text 新 id——验证是否双播', async () => {
  const spoke = await drive('r1style', 3, (round) => {
    // 服务端 ReasoningParser(text, false, final)：闭合前无任何标签 → 全部按 text
    return {
      ticks: [
        [textBlock('b1', `用户想要什么。需要查一下。`)],
        [textBlock('b1', `用户想要什么。需要查一下。也许很简单。`)]
      ],
      // </think> 到达 + 答案同帧（首见）
      finalBlocks: [thinkingBlock('b1', `用户想要什么。需要查一下。也许很简单。`), textBlock('bx2', `答案第${round}轮。就是这样。`)],
      finishWithText: false
    }
  })
  console.log('r1style 每轮合成次数:', spoke)
  // 预期：思考被当正文播了 + 答案也播了（双播/串台），说明 assumeThinking 没传
  assert.deepEqual(spoke.map((n) => n > 0), [true, true, true])
})
