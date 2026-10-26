// 「哪些回复会被送去 TTS」的判据测试。跑的是产品代码本体（lib/replySpeech + lib/speechOutput），
// 不是复刻件——AssistantChat.vue 挂的就是这两个函数。
//
// 锁住的不变式：**skip 是不可逆的**（推进游标 + 永久丢文本），所以「播不播」只能由单调不可逆的
// 信号决定。服务端（qt AgentRunner）的真实行为里，error 会被重试 reset（AgentRunner.cpp:2652）、
// notice 会被看图描述 reset（:2082）、还会被交付检查/验证检查/额度等待**累加**（:1748、:4135、
// QuotaWaiting.cpp:83），而挂上之后服务端 renderPass(true) + startNewPass() 照样继续往同一条
// 消息里写真正做完的正文。拿它们当静音判据，就是把一轮的最终结论整段丢掉——这正是
// 「有的回复播、有的不播」看着没规律的根因（规律在气泡 meta 行那行小字上）。
//
// 收尾同理：flush 幂等，完结期间每帧都调，不去捕捉「finishedAt 刚出现」那一次的边沿。
const test = require('node:test')
const assert = require('node:assert')
const { reactive, computed, watch, nextTick } = require('vue')

const speech = require('../.tmp/speechoutput.cjs')
const { setSpeechForeground, isSentenceEnd, splitForSpeech } = speech
const {
  conversationSpeechSnapshot,
  createConversationSpeechState,
  speakConversationSnapshot,
  createAssistantSpeechState,
  speakAssistantEntries
} = require('../.tmp/replyspeech.cjs')

// ---- mock 桥：记录每次送合成的文本，手动放行（空 samples 让泵跳过播放，不碰 AudioContext） ----
function mockBridge() {
  const calls = []
  const pending = []
  globalThis.window = {
    fridayBridge: {
      speakReply: ({ text }) => {
        calls.push(text)
        return new Promise((resolve) => pending.push({ resolve }))
      },
      cancelCosyVoice: () => Promise.resolve()
    }
  }
  const flushMicro = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
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
  return { calls, drain, flushMicro, restore }
}

// ---- 挂上产品代码那份 watch（与 AssistantChat.vue 完全同一实现） ----
function setupWatch(store) {
  const conversationID = computed(() => store.activeConversationID)
  const stopForeground = watch(conversationID, (conv) => setSpeechForeground(conv ?? ''), { immediate: true })
  const state = createConversationSpeechState()
  const stop = watch(
    () => conversationSpeechSnapshot(store, conversationID.value),
    (list, prev) => speakConversationSnapshot(list, store, state, prev === undefined),
    { immediate: true }
  )
  return {
    stop: () => {
      stop()
      stopForeground()
    },
    state
  }
}

const T = (id, text) => ({ id, kind: { text } })
const K = (id, text) => ({ id, kind: { thinking: text } })
const FIN = '2026-12-01T00:00:00Z'

function freshStore() {
  return reactive({ details: {}, historyMessages: {}, activeConversationID: 'A' })
}

/** 会话级用例：建 store + watch，跑 body，收走这一轮送合成的文本 */
async function conversationCase(body) {
  const store = freshStore()
  const bridge = mockBridge()
  const w = setupWatch(store)
  // 当前会话先存在（首帧登记进 seenConversations，之后来的消息才算新回复而不是历史）
  store.details.A = { messages: [], nodes: [] }
  await nextTick()
  const push = (message) => {
    const detail = store.details.A
    const at = detail.nodes.findIndex((node) => node.id === message.id)
    if (at >= 0) detail.nodes[at] = message
    else detail.nodes.push(message)
    detail.messages = detail.nodes.map((node) => ({ message: node, version: 0 }))
  }
  /** 原地改（applyMessagePatch 的行为：保留对象引用，只改字段） */
  const patch = (id, fields) => {
    Object.assign(store.details.A.messages.find((entry) => entry.message.id === id).message, fields)
  }
  push({ id: 'u0', role: 'user', blocks: [T('ub0', '问题')] })
  await nextTick()
  bridge.calls.length = 0
  try {
    await body({ store, push, patch, bridge })
    await nextTick()
    await bridge.drain()
    await nextTick()
    return [...bridge.calls]
  } finally {
    w.stop()
    bridge.restore()
  }
}

/** 一轮普通流式回复：空消息 → 若干文本帧 → 收尾。中途可以插 extra 帧（挂 notice / error 等） */
async function streamReply(ctx, id, frames, extra) {
  const { push, patch } = ctx
  push({ id, role: 'assistant', blocks: [] })
  await nextTick()
  for (const frame of frames) {
    if (typeof frame === 'function') await frame()
    else patch(id, { blocks: [T('b', frame)] })
    await nextTick()
  }
  if (extra) await extra()
  patch(id, { finishedAt: FIN })
  await nextTick()
}

// ================= 主根因：notice / error 中途挂上，后续正文照播 =================

test('对照：正常回复逐句送合成', async () => {
  const calls = await conversationCase(async (ctx) => {
    await streamReply(ctx, 'a1', ['我查了一下，问题出在这里。', '我查了一下，问题出在这里。已经改好了'])
  })
  assert.deepEqual(calls, ['我查了一下，问题出在这里。', '已经改好了。'])
})

test('交付检查中途挂 notice（回复像方案/「要不要我…」）：后续真正做完的正文照播', async () => {
  // 服务端 AgentRunner.cpp:4120 → 4135 累加 notice，然后 renderPass(true) + startNewPass()
  // 继续往同一条消息写正文
  const calls = await conversationCase(async (ctx) => {
    await streamReply(
      ctx,
      'a2',
      ['我看了一下，大概是这样的问题。', '我看了一下，大概是这样的问题。要不要我直接改？'],
      async () => {
        ctx.patch('a2', { notice: '交给你的像是方案而不是结果，已要求智能体先分析、直接做完' })
        await nextTick()
        ctx.patch('a2', {
          blocks: [T('b', '我看了一下，大概是这样的问题。要不要我直接改？'), T('b2', '好，我直接改完了。问题在 watch 里。')]
        })
        await nextTick()
      }
    )
  })
  assert.ok(calls.includes('要不要我直接改？'), `挂 notice 之前的照播（calls=${JSON.stringify(calls)}）`)
  assert.ok(calls.includes('好，我直接改完了。'), `挂 notice 之后真正做完的正文照播（calls=${JSON.stringify(calls)}）`)
  assert.ok(calls.includes('问题在 watch 里。'), '最终结论不能丢')
})

test('验证检查点中途挂 notice（写完没运行/读回确认）：后续正文照播', async () => {
  const calls = await conversationCase(async (ctx) => {
    await streamReply(ctx, 'a3', ['我把这个函数改好了。'], async () => {
      ctx.patch('a3', { notice: '写了 a.ts 之后没有运行或读回确认，已提醒智能体先验证' })
      await nextTick()
      ctx.patch('a3', { blocks: [T('b', '我把这个函数改好了。'), T('b2', '跑了一遍测试，232 个全过。')] })
      await nextTick()
    })
  })
  assert.ok(calls.includes('跑了一遍测试，232 个全过。'), `验证结果照播（calls=${JSON.stringify(calls)}）`)
})

test('notice 先于正文挂上（钩子让智能体接着做）：整条照播，不再全哑', async () => {
  const calls = await conversationCase(async (ctx) => {
    const { push, patch } = ctx
    push({ id: 'a4', role: 'assistant', blocks: [] })
    await nextTick()
    patch('a4', { notice: '一轮结束的钩子让智能体接着做：把测试跑完' })
    await nextTick()
    patch('a4', { blocks: [T('b', '测试跑完了，全部通过。')] })
    await nextTick()
    patch('a4', { finishedAt: FIN })
    await nextTick()
  })
  assert.deepEqual(calls, ['测试跑完了，全部通过。'])
})

test('瞬时 notice（看图描述，随后 reset）：挂着期间长出来的文本不丢', async () => {
  // AgentRunner.cpp:2053 挂上、:2082 清掉。旧实现里这期间长出来的文本被 skip 掉、游标已推进，
  // notice 清掉之后也拿不回来
  const calls = await conversationCase(async (ctx) => {
    await streamReply(ctx, 'a5', [], async () => {
      ctx.patch('a5', { notice: '当前大脑不能直接看图，正在用看图模型描述附件…' })
      await nextTick()
      ctx.patch('a5', { blocks: [T('b', '这段在 notice 挂着的时候长出来。')] })
      await nextTick()
      ctx.patch('a5', { notice: undefined })
      await nextTick()
      ctx.patch('a5', { blocks: [T('b', '这段在 notice 挂着的时候长出来。这段是清掉之后长出来的。')] })
      await nextTick()
    })
  })
  assert.ok(calls.includes('这段在 notice 挂着的时候长出来。'), `notice 期间的正文不丢（calls=${JSON.stringify(calls)}）`)
  assert.ok(calls.includes('这段是清掉之后长出来的。'), 'notice 清掉后的正文照播')
})

test('error 中途挂上：之后长出来的正文照播（error 只是 meta 行上一个标签）', async () => {
  const calls = await conversationCase(async (ctx) => {
    await streamReply(ctx, 'a6', ['前半段说完了。'], async () => {
      ctx.patch('a6', { error: '连接中断' })
      await nextTick()
      // 出错之后服务端还会往同一条消息补内容（重建上下文继续 / 补渲染）
      ctx.patch('a6', { blocks: [T('b', '前半段说完了。'), T('b2', '重建上下文后补上的结论没有标点')] })
      await nextTick()
    })
  })
  assert.ok(calls.includes('前半段说完了。'), 'error 挂上之前的照播')
  assert.ok(
    calls.some((c) => c.includes('重建上下文后补上的结论')),
    `error 挂上之后长出来的正文照播（calls=${JSON.stringify(calls)}）`
  )
})

test('出错后重试：服务端清掉 error / finishedAt 接着写，新一轮正文照播', async () => {
  // AgentRunner.cpp:2651-2655：error.reset() + quotaWait.reset() + finishedAt.reset()
  const calls = await conversationCase(async (ctx) => {
    const { push, patch } = ctx
    push({ id: 'a7', role: 'assistant', blocks: [T('b', '开头就失败了')] })
    await nextTick()
    patch('a7', { error: '额度不足', finishedAt: FIN })
    await nextTick()
    patch('a7', { error: undefined, quotaWait: undefined, finishedAt: undefined })
    await nextTick()
    patch('a7', { blocks: [T('b', '开头就失败了'), T('b2', '重试后的答案没有句号结尾')] })
    await nextTick()
    patch('a7', { finishedAt: FIN })
    await nextTick()
  })
  assert.ok(calls.some((c) => c.includes('重试后的答案')), `重试后的正文照播（calls=${JSON.stringify(calls)}）`)
})

// ================= 收尾不依赖「只有一次的边沿」 =================

test('finishedAt 先到、之后又补来文本：尾巴照播', async () => {
  // 旧实现 justFinished 要求 !before，收尾帧之后 before 就有值了，边沿永不再来 → 尾巴永久静音
  const calls = await conversationCase(async (ctx) => {
    const { push, patch } = ctx
    push({ id: 'a8', role: 'assistant', blocks: [] })
    await nextTick()
    patch('a8', { blocks: [T('b', '主体说完了。')], finishedAt: FIN })
    await nextTick()
    patch('a8', { blocks: [T('b', '主体说完了。补一句尾巴没有标点')] })
    await nextTick()
  })
  assert.ok(calls.includes('主体说完了。'), '主体照播')
  assert.ok(calls.some((c) => c.includes('补一句尾巴')), `收尾后补来的尾巴照播（calls=${JSON.stringify(calls)}）`)
})

test('服务端始终不给 finishedAt：有句末标点的正文照样逐句播', async () => {
  const calls = await conversationCase(async (ctx) => {
    const { push, patch } = ctx
    push({ id: 'a9', role: 'assistant', blocks: [] })
    await nextTick()
    patch('a9', { blocks: [T('b', '第一句。第二句。')] })
    await nextTick()
  })
  // 不依赖收尾帧：句末标点一到就送合成（一帧里两句由 splitForSpeech 分成两次）
  assert.deepEqual(calls, ['第一句。', '第二句。'])
})

test('flush 幂等：完结后每帧都调，不会把同一句重复送合成', async () => {
  const calls = await conversationCase(async (ctx) => {
    await streamReply(ctx, 'a10', ['只有一句没有标点'])
    // 完结之后再来几帧无关变化（别的消息在动），flush 会被反复调
    for (let i = 0; i < 3; i++) {
      ctx.push({ id: `n${i}`, role: 'assistant', blocks: [T('b', `第${i}条。`)], finishedAt: FIN })
      await nextTick()
    }
  })
  assert.equal(calls.filter((c) => c.includes('只有一句没有标点')).length, 1, `不重复播（calls=${JSON.stringify(calls)}）`)
})

// ================= 单调信号仍然拦得住（回归保护） =================

test('回归：stoppedByUser 的回复不播（用户明确不要了，服务端只设不清）', async () => {
  const calls = await conversationCase(async (ctx) => {
    const { push, patch } = ctx
    push({ id: 'a11', role: 'assistant', blocks: [] })
    await nextTick()
    patch('a11', { stoppedByUser: true })
    await nextTick()
    patch('a11', { blocks: [T('b', '被停掉的那条。')] })
    await nextTick()
    patch('a11', { finishedAt: FIN })
    await nextTick()
  })
  assert.deepEqual(calls, [])
})

test('回归：store.historyMessages 里的旧消息不播（切会话/重连不念旧账）', async () => {
  const calls = await conversationCase(async (ctx) => {
    const { push, patch } = ctx
    push({ id: 'a12', role: 'assistant', blocks: [T('b', '打开会话时就在的旧回复。')], finishedAt: FIN })
    ctx.store.historyMessages['a12'] = true
    await nextTick()
    patch('a12', { blocks: [T('b', '打开会话时就在的旧回复。后来长出来的。')] })
    await nextTick()
  })
  assert.deepEqual(calls, [])
})

test('回归：完结消息被重推且换了块 id，不重播', async () => {
  const calls = await conversationCase(async (ctx) => {
    const { patch } = ctx
    await streamReply(ctx, 'a13', ['旧 id 的句子。'])
    patch('a13', { blocks: [{ id: 'brand-new-block', kind: { text: '旧 id 的句子。' } }] })
    await nextTick()
  })
  assert.equal(calls.filter((c) => c === '旧 id 的句子。').length, 1, `不重播（calls=${JSON.stringify(calls)}）`)
})

test('回归：会话被淘汰后重订阅，已有内容当历史不重播，游标一并收走', async () => {
  const store = freshStore()
  const bridge = mockBridge()
  const w = setupWatch(store)
  try {
    store.details.A = { messages: [], nodes: [] }
    await nextTick()
    const m = { id: 'a14', role: 'assistant', blocks: [T('b', '淘汰前的句子。')], finishedAt: FIN }
    store.details.A.nodes.push(m)
    store.details.A.messages = store.details.A.nodes.map((node) => ({ message: node, version: 0 }))
    await nextTick()
    await bridge.drain()
    assert.ok(bridge.calls.includes('淘汰前的句子。'), '淘汰前正常播过')
    const streamsBefore = w.state.blockStreams.size
    assert.ok(streamsBefore > 0, '留下了游标')
    // closeConversation：delete details[A]
    delete store.details.A
    await nextTick()
    assert.equal(w.state.blockStreams.size, 0, '会话消失后游标被收走（不然只增不减，长跑一直涨）')
    assert.equal(w.state.seenConversations.has('A'), false, '会话从已见清单里摘掉，重订阅才算新会话')
    bridge.calls.length = 0
    // 重订阅：同 message id / block id，内容已是完成态
    store.details.A = { messages: [], nodes: [] }
    store.details.A.nodes.push({ id: 'a14', role: 'assistant', blocks: [T('b', '淘汰前的句子。')], finishedAt: FIN })
    store.details.A.messages = store.details.A.nodes.map((node) => ({ message: node, version: 0 }))
    await nextTick()
    await bridge.drain()
    assert.deepEqual(bridge.calls, [], `重订阅不重播旧账（calls=${JSON.stringify(bridge.calls)}）`)
  } finally {
    w.stop()
    bridge.restore()
  }
})

// ================= 英文：ASCII 句点也算句末，流式期间就开口 =================

test('句末判定：ASCII 句点只在后面已跟空白时算句末', () => {
  assert.equal(isSentenceEnd('好的。', 2), true, '中文句号')
  assert.equal(isSentenceEnd('a\nb', 1), true, '换行')
  assert.equal(isSentenceEnd('步骤：下一步', 2), true, '中文冒号')
  assert.equal(isSentenceEnd('Done. Next', 4), true, 'ASCII 句点后跟空白')
  assert.equal(isSentenceEnd('Done.', 4), false, '片尾的句点还没后文：不判定，留给下一片或 flush')
  assert.equal(isSentenceEnd('版本 0.5.110 发布', 4), false, '版本号里的点')
  assert.equal(isSentenceEnd('版本 0.5.110 发布', 6), false, '版本号里的第二个点')
  assert.equal(isSentenceEnd('改 a.ts 文件', 3), false, '文件扩展名')
  assert.equal(isSentenceEnd('no dot here', 2), false, '空格不是句末')
})

test('分句：小数点 / 文件名 / 版本号不被剁碎', () => {
  assert.deepEqual(splitForSpeech('升到 0.5.110 了。'), ['升到 0.5.110 了。'])
  assert.deepEqual(splitForSpeech('改的是 a.ts 文件。'), ['改的是 a.ts 文件。'])
  assert.deepEqual(splitForSpeech('Done. Next one.'), ['Done.', 'Next one.'])
})

test('英文回复流式期间就逐句送合成，不用等收尾', async () => {
  const seen = []
  const calls = await conversationCase(async (ctx) => {
    const { push, patch } = ctx
    push({ id: 'a15', role: 'assistant', blocks: [] })
    await nextTick()
    let text = ''
    for (let i = 1; i <= 4; i++) {
      text += `This is sentence number ${i} with a few extra words. `
      patch('a15', { blocks: [T('b', text)] })
      await nextTick()
      await ctx.bridge.flushMicro()
      seen.push(ctx.bridge.calls.length)
    }
    patch('a15', { finishedAt: FIN })
    await nextTick()
  })
  assert.ok(seen[0] > 0, `第一句在流式期间就送出去了（各帧累计=${JSON.stringify(seen)}）`)
  assert.ok(calls.some((c) => c.includes('sentence number 1')), '英文句子进了合成')
})

test('英文版本号在流式中途不被切断', async () => {
  const calls = await conversationCase(async (ctx) => {
    const { push, patch } = ctx
    push({ id: 'a16', role: 'assistant', blocks: [] })
    await nextTick()
    patch('a16', { blocks: [T('b', 'Bumped to 0.5.')] })
    await nextTick()
    patch('a16', { blocks: [T('b', 'Bumped to 0.5.110 today. ')] })
    await nextTick()
    patch('a16', { finishedAt: FIN })
    await nextTick()
  })
  assert.ok(calls.some((c) => c.includes('0.5.110')), `版本号完整（calls=${JSON.stringify(calls)}）`)
  assert.ok(!calls.some((c) => /0\.5\.$/.test(c.trim())), `没有被切成半截版本号（calls=${JSON.stringify(calls)}）`)
})

// ================= 助手模式（「和助手说」面板）同一口径 =================

/** 助手日志条用例：直接调产品代码的 speakAssistantEntries */
async function assistantCase(body) {
  const bridge = mockBridge()
  setSpeechForeground('__assistant__')
  const state = createAssistantSpeechState()
  const entries = reactive([])
  try {
    await body({ entries, state, bridge })
    await bridge.drain()
    return [...bridge.calls]
  } finally {
    speech.stopSpeaking()
    bridge.restore()
  }
}

const entry = (id, text, extra) => ({ id, at: '2026-12-01T00:00:00Z', kind: 'assistant', text, ...extra })

test('助手模式：data.error 只是「出错了」标签，正文照播', async () => {
  const calls = await assistantCase(async ({ entries, state }) => {
    speakAssistantEntries([], state, true) // 首帧
    entries.push(entry('e1', '出事前说了一句。', { streaming: true }))
    speakAssistantEntries(entries, state, false)
    entries[0].text = '出事前说了一句。出错后补的结论。'
    entries[0].data = { error: true }
    speakAssistantEntries(entries, state, false)
    entries[0].streaming = false
    speakAssistantEntries(entries, state, false)
  })
  assert.ok(calls.includes('出事前说了一句。'), 'error 挂上之前的照播')
  assert.ok(calls.includes('出错后补的结论。'), `error 挂上之后的正文照播（calls=${JSON.stringify(calls)}）`)
})

test('助手模式：收尾后同一条目又被合并更新、长出文本，接着播', async () => {
  const calls = await assistantCase(async ({ entries, state }) => {
    speakAssistantEntries([], state, true)
    entries.push(entry('e2', '先说一句没有标点', { streaming: true }))
    speakAssistantEntries(entries, state, false)
    entries[0].streaming = false
    speakAssistantEntries(entries, state, false)
    // mergeAssistantEntry 同 id 更新：收尾之后文本又长了
    entries[0].text = '先说一句没有标点，后面又补了一段'
    speakAssistantEntries(entries, state, false)
  })
  assert.ok(calls.some((c) => c.includes('先说一句没有标点')), '收尾时把尾巴播出去')
  assert.ok(calls.some((c) => c.includes('后面又补了一段')), `收尾后补的照播（calls=${JSON.stringify(calls)}）`)
})

test('助手模式回归：interrupted（被中止）不播', async () => {
  const calls = await assistantCase(async ({ entries, state }) => {
    speakAssistantEntries([], state, true)
    entries.push(entry('e3', '', { streaming: true, interrupted: true }))
    speakAssistantEntries(entries, state, false)
    entries[0].text = '被打断的那条。'
    speakAssistantEntries(entries, state, false)
    entries[0].streaming = false
    speakAssistantEntries(entries, state, false)
  })
  assert.deepEqual(calls, [])
})

test('助手模式回归：silent 的条目不播（它根本不渲染）', async () => {
  const calls = await assistantCase(async ({ entries, state }) => {
    speakAssistantEntries([], state, true)
    entries.push(entry('e4', '', { streaming: true, data: { silent: true } }))
    speakAssistantEntries(entries, state, false)
    entries[0].text = '静默条目。'
    speakAssistantEntries(entries, state, false)
    entries[0].streaming = false
    speakAssistantEntries(entries, state, false)
  })
  assert.deepEqual(calls, [])
})

test('助手模式回归：首帧已有的文本当历史不补播', async () => {
  const calls = await assistantCase(async ({ entries, state }) => {
    entries.push(entry('e5', '打开面板时就在的旧日志。', { streaming: false }))
    speakAssistantEntries(entries, state, true)
    entries[0].text = '打开面板时就在的旧日志。之后新长出来的。'
    speakAssistantEntries(entries, state, false)
  })
  assert.deepEqual(calls, ['之后新长出来的。'], `只播新长出来的（calls=${JSON.stringify(calls)}）`)
})
