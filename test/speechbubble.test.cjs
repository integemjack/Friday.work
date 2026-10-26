// 气泡 ↔ 播报的收尾联动 + 同会话新回复压低老回复。
// 跑的是产品代码本体（lib/speechOutput + lib/replySpeech）。
//
// 两件事共用一套机制：送合成的每句话都带
//   tag  = 桌面气泡 id（`${会话}:text:${块}`）——这条气泡的句子全部了结时通知它可以渐隐；
//   turn = 一轮回复（`${会话}:${消息}`）——同会话来了新轮次，老轮次还在念的按 STALE_TURN_GAIN 压低。
//
// 和现有 speechoutput/replyspeech 测试的差别：那些用空 samples 让泵跳过播放（不碰 AudioContext），
// 而这两个需求的行为全在播放路径上（播完才 retire、正在播的那句才决定增益），
// 所以这里挂一个可控的假 AudioContext：句子真进 ready、真「出声」，由测试决定哪句什么时候播完。
const test = require('node:test')
const assert = require('node:assert')

const speech = require('../.tmp/speechoutput.cjs')
const { speakText, stopSpeaking, setSpeechForeground, isSpeechTagPending, onSpeechTagDrained } = speech

// ---- 假 AudioContext：节点都建得出来，「播完」由测试手动触发 ----
class FakeParam {
  constructor(value = 0) {
    this.value = value
  }
  setTargetAtTime(value) {
    this.value = value
  }
  setValueAtTime(value) {
    this.value = value
  }
}

class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx
    this.kind = kind
    this.connected = []
  }
  connect(target) {
    this.connected.push(target)
    return target
  }
  disconnect() {
    this.connected = []
  }
}

class FakeSource extends FakeNode {
  constructor(ctx) {
    super(ctx, 'source')
    this.onended = null
    this.buffer = null
    this.started = false
    this.stopped = false
  }
  start() {
    this.started = true
    this.ctx.live.push(this) // 正在出声的那句
  }
  stop() {
    this.stopped = true
    const at = this.ctx.live.indexOf(this)
    if (at >= 0) this.ctx.live.splice(at, 1)
    if (this.onended) this.onended()
  }
}

class FakeContext {
  constructor() {
    this.currentTime = 0
    this.state = 'running'
    this.destination = new FakeNode(this, 'destination')
    this.gains = []
    this.live = []
    FakeContext.instances.push(this)
  }
  createGain() {
    const node = new FakeNode(this, 'gain')
    node.gain = new FakeParam(1)
    this.gains.push(node)
    return node
  }
  createBufferSource() {
    return new FakeSource(this)
  }
  createBuffer(_channels, length, sampleRate) {
    return { length, sampleRate, getChannelData: () => new Float32Array(length) }
  }
  createStereoPanner() {
    const node = new FakeNode(this, 'stereo')
    node.pan = new FakeParam(0)
    return node
  }
  createPanner() {
    const node = new FakeNode(this, 'hrtf')
    node.positionX = new FakeParam()
    node.positionY = new FakeParam()
    node.positionZ = new FakeParam()
    return node
  }
  createAnalyser() {
    const node = new FakeNode(this, 'analyser')
    node.fftSize = 0
    node.smoothingTimeConstant = 0
    return node
  }
  resume() {
    return Promise.resolve()
  }
  /** 当前正在出声的那句播完了（触发 onended，泵接着走） */
  endCurrent() {
    const source = this.live.shift()
    if (!source) throw new Error('没有正在播的句子')
    if (source.onended) source.onended()
  }
}
FakeContext.instances = []
// speechOutput 里是 `new AudioContext()`：挂到全局它才用得上假的。
// 模块级的 audioContext 只建一次、跨用例复用，所以 instances 不清（gains 会累积，
// 靠「最后建的那个」定位本用例的通道）
globalThis.AudioContext = FakeContext

// ---- mock 桥：合成请求排队，测试手动放行（给非空 samples，句子才会真进播放） ----
function mockBridge() {
  const calls = []
  const pending = []
  globalThis.window = {
    fridayBridge: {
      speakReply: ({ text }) => {
        calls.push(text)
        return new Promise((resolve) => pending.push({ resolve, text }))
      },
      cancelCosyVoice: () => Promise.resolve()
    }
  }
  const ctx = () => FakeContext.instances[0]
  const flushMicro = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  /** 放行一句合成（拿到音频）→ 泵把它送进播放 */
  const synthOne = async () => {
    const item = pending.shift()
    if (!item) throw new Error('没有待放行的合成请求')
    item.resolve({ samples: new Float32Array(2400), sampleRate: 24000 })
    await flushMicro()
    return item.text
  }
  /** 放行一句 + 播完它 */
  const playOne = async () => {
    const text = await synthOne()
    ctx().endCurrent()
    await flushMicro()
    return text
  }
  const restore = () => {
    stopSpeaking()
    for (const item of pending.splice(0)) item.resolve({ samples: new Float32Array(0), sampleRate: 24000 })
    delete globalThis.window
  }
  return { calls, pending, ctx, flushMicro, synthOne, playOne, restore }
}

/** 当前用例那个通道的 gain 节点。
 *  不能按下标取：ensureChannelNodes 先建通道 gain、再建公共主增益（masterGain 接 analyser），
 *  所以第一个用例的 gains 是 [通道, 主增益]、之后每个用例只多一个通道 gain，下标会错位。
 *  按接线区分：通道 gain 接在声像节点（stereo / hrtf）上，主增益接在 analyser 上。 */
function channelGain(bridge) {
  const channelGains = bridge
    .ctx()
    .gains.filter((node) => node.connected.some((target) => target.kind === 'stereo' || target.kind === 'hrtf'))
  assert.ok(channelGains.length > 0, '通道 gain 已建（得先出声一次）')
  return channelGains[channelGains.length - 1]
}

/** 每个用例一个唯一来源：通道是模块级缓存的，复用会让 gain / 轮次记忆串到下个用例 */
let sourceSeq = 0
function newSource() {
  return `S${++sourceSeq}`
}

// ================= tag：气泡念完才允许收 =================

test('tag 生命周期：入队即 pending，全部播完才 drained', async () => {
  const bridge = mockBridge()
  const src = newSource()
  const tag = `${src}:text:b1`
  setSpeechForeground(src)
  try {
    assert.equal(isSpeechTagPending(tag), false, '还没入队：不 pending')
    speakText('第一句。第二句。', { append: true, source: src, tag })
    await bridge.flushMicro()
    assert.equal(isSpeechTagPending(tag), true, '入队后 pending')

    let drained = 0
    onSpeechTagDrained(tag, () => (drained += 1))

    await bridge.playOne() // 第一句播完
    assert.equal(drained, 0, '还剩一句：不通知')
    assert.equal(isSpeechTagPending(tag), true)

    await bridge.playOne() // 第二句播完
    assert.equal(drained, 1, '全部念完：通知一次')
    assert.equal(isSpeechTagPending(tag), false, '计数清空')
  } finally {
    bridge.restore()
  }
})

test('tag 已念完时才注册监听：立即回调（气泡到点那一刻刚好播完，不能错过）', async () => {
  const bridge = mockBridge()
  const src = newSource()
  const tag = `${src}:text:b2`
  setSpeechForeground(src)
  try {
    speakText('就一句。', { append: true, source: src, tag })
    await bridge.playOne()
    let drained = 0
    onSpeechTagDrained(tag, () => (drained += 1))
    assert.equal(drained, 1, '已经不 pending：注册即回调')
  } finally {
    bridge.restore()
  }
})

test('多条气泡各自计数：一条念完不影响另一条', async () => {
  const bridge = mockBridge()
  const src = newSource()
  const tagJia = `${src}:text:bJia`
  const tagYi = `${src}:text:bYi`
  setSpeechForeground(src)
  try {
    speakText('甲的句子。', { append: true, source: src, tag: tagJia })
    speakText('乙的句子。', { append: true, source: src, tag: tagYi })
    await bridge.flushMicro()
    const drained = []
    onSpeechTagDrained(tagJia, () => drained.push('jia'))
    onSpeechTagDrained(tagYi, () => drained.push('yi'))

    await bridge.playOne() // 甲
    assert.deepEqual(drained, ['jia'], '甲念完只通知甲')
    assert.equal(isSpeechTagPending(tagYi), true, '乙还在等')

    await bridge.playOne() // 乙
    assert.deepEqual(drained, ['jia', 'yi'])
  } finally {
    bridge.restore()
  }
})

test('停播（关开关 / 试听 / 手动停）：被丢的句子退干净，气泡不会干等', async () => {
  const bridge = mockBridge()
  const src = newSource()
  const tag = `${src}:text:b3`
  setSpeechForeground(src)
  try {
    speakText('一句。两句。三句。', { append: true, source: src, tag })
    await bridge.flushMicro()
    let drained = 0
    onSpeechTagDrained(tag, () => (drained += 1))
    assert.equal(isSpeechTagPending(tag), true)

    stopSpeaking() // 用户关了播报 / 点了停止
    await bridge.flushMicro()
    assert.equal(drained, 1, '被丢的句子也算了结：通知照发')
    assert.equal(isSpeechTagPending(tag), false)
  } finally {
    bridge.restore()
  }
})

test('正在播的那句被停：也算了结，且不重复计数', async () => {
  const bridge = mockBridge()
  const src = newSource()
  const tag = `${src}:text:b4`
  setSpeechForeground(src)
  try {
    speakText('播到一半。还有后半。', { append: true, source: src, tag })
    await bridge.synthOne() // 第一句合成好、开始播
    assert.equal(bridge.ctx().live.length, 1, '正在出声')
    let drained = 0
    onSpeechTagDrained(tag, () => (drained += 1))

    stopSpeaking(src)
    await bridge.flushMicro()
    assert.equal(drained, 1, `两句都了结、只通知一次（drained=${drained}）`)
    assert.equal(isSpeechTagPending(tag), false)
  } finally {
    bridge.restore()
  }
})

test('合成失败：这一路的句子作废，气泡照样收到通知', async () => {
  const bridge = mockBridge()
  const src = newSource()
  const tag = `${src}:text:b5`
  setSpeechForeground(src)
  try {
    speakText('会失败的一句。后面还有一句。', { append: true, source: src, tag })
    await bridge.flushMicro()
    let drained = 0
    onSpeechTagDrained(tag, () => (drained += 1))

    // 引擎报错：schedule 的 done(error) 分支清掉这一路没播到的句子
    bridge.pending.shift().resolve(undefined)
    globalThis.window.fridayBridge.speakReply = () => Promise.reject(new Error('serve 挂了'))
    for (let i = 0; i < 6 && isSpeechTagPending(tag); i++) await bridge.flushMicro()
    assert.equal(isSpeechTagPending(tag), false, '失败路径也把计数退干净')
    assert.equal(drained, 1, '通知照发，气泡不会永远留在桌面上')
  } finally {
    bridge.restore()
  }
})

test('没带 tag 的句子（试听 / 整条播报）不参与计数', async () => {
  const bridge = mockBridge()
  const src = newSource()
  setSpeechForeground(src)
  try {
    speakText('试听一句。', { force: true, source: src })
    await bridge.flushMicro()
    assert.equal(isSpeechTagPending(src), false)
    assert.equal(isSpeechTagPending(`${src}:text:anything`), false)
    await bridge.playOne()
  } finally {
    bridge.restore()
  }
})

// ================= turn：同会话新回复压低老回复 =================

test('同会话来了新回复：正在念的老回复音量压低', async () => {
  const bridge = mockBridge()
  const src = newSource()
  setSpeechForeground(src)
  try {
    speakText('老回复的第一句。老回复的第二句。', {
      append: true,
      source: src,
      tag: `${src}:text:old`,
      turn: `${src}:m1`
    })
    await bridge.synthOne() // 老回复第一句开始出声
    const gain = channelGain(bridge)
    assert.equal(gain.gain.value, 1, '只有老回复时原声')

    // 新回复入队（同会话、新一轮）
    speakText('新回复来了。', { append: true, source: src, tag: `${src}:text:new`, turn: `${src}:m2` })
    await bridge.flushMicro()
    assert.ok(gain.gain.value < 0.5, `老回复被压低（gain=${gain.gain.value}）`)
  } finally {
    bridge.restore()
  }
})

test('老回复念完、新回复开口：音量恢复原声', async () => {
  const bridge = mockBridge()
  const src = newSource()
  setSpeechForeground(src)
  try {
    speakText('老回复只有一句。', { append: true, source: src, tag: `${src}:text:old`, turn: `${src}:m1` })
    await bridge.synthOne()
    const gain = channelGain(bridge)
    speakText('新回复的第一句。', { append: true, source: src, tag: `${src}:text:new`, turn: `${src}:m2` })
    await bridge.flushMicro()
    assert.ok(gain.gain.value < 0.5, '老回复在念时被压低')

    bridge.ctx().endCurrent() // 老回复那句播完
    await bridge.flushMicro()
    await bridge.synthOne() // 新回复开口
    assert.equal(gain.gain.value, 1, `新回复原声（gain=${gain.gain.value}）`)
  } finally {
    bridge.restore()
  }
})

test('同一轮的多段（一条消息多个 text 块）不互相压低', async () => {
  const bridge = mockBridge()
  const src = newSource()
  setSpeechForeground(src)
  try {
    speakText('第一段的句子。', { append: true, source: src, tag: `${src}:text:b1`, turn: `${src}:m1` })
    await bridge.synthOne()
    speakText('第二段的句子。', { append: true, source: src, tag: `${src}:text:b2`, turn: `${src}:m1` })
    await bridge.flushMicro()
    assert.equal(channelGain(bridge).gain.value, 1, '同轮次不衰减')
  } finally {
    bridge.restore()
  }
})

test('别的会话来了新回复：不影响这一路（turn 按会话隔离）', async () => {
  const bridge = mockBridge()
  const src = newSource()
  const other = newSource()
  setSpeechForeground(src)
  try {
    speakText('这一路在念的句子。', { append: true, source: src, tag: `${src}:text:b1`, turn: `${src}:m1` })
    await bridge.synthOne()
    const gain = channelGain(bridge)
    // 另一个会话的新回复（不同 source = 不同通道，各算各的轮次）
    speakText('别的会话的句子。', { append: true, source: other, tag: `${other}:text:b1`, turn: `${other}:m1` })
    await bridge.flushMicro()
    assert.equal(gain.gain.value, 1, '本通道不被别的会话的轮次影响')
  } finally {
    bridge.restore()
  }
})

test('停播后轮次记忆清掉：下一条不被当成「老回复」压低', async () => {
  const bridge = mockBridge()
  const src = newSource()
  setSpeechForeground(src)
  try {
    speakText('老回复。', { append: true, source: src, tag: `${src}:text:o`, turn: `${src}:m1` })
    await bridge.synthOne()
    speakText('新回复。', { append: true, source: src, tag: `${src}:text:n`, turn: `${src}:m2` })
    await bridge.flushMicro()
    stopSpeaking(src)
    await bridge.flushMicro()

    speakText('停过之后的又一条。', { append: true, source: src, tag: `${src}:text:p`, turn: `${src}:m3` })
    await bridge.synthOne()
    assert.equal(channelGain(bridge).gain.value, 1, '清干净了，不会一上来就压低')
  } finally {
    bridge.restore()
  }
})

// ================= 端到端：流式回复 → tag 就是气泡 id =================

test('流式回复的 tag 由 replySpeech 按气泡 id 打上：整条念完才 drained', async () => {
  const { reactive, computed, watch, nextTick } = require('vue')
  const {
    conversationSpeechSnapshot,
    createConversationSpeechState,
    speakConversationSnapshot
  } = require('../.tmp/replyspeech.cjs')
  const bridge = mockBridge()
  const src = newSource()
  const store = reactive({ details: {}, historyMessages: {}, activeConversationID: src })
  const conversationID = computed(() => store.activeConversationID)
  setSpeechForeground(src)
  const stopForeground = watch(conversationID, (conv) => setSpeechForeground(conv ?? ''), { immediate: true })
  const state = createConversationSpeechState()
  const stop = watch(
    () => conversationSpeechSnapshot(store, conversationID.value),
    (list, prev) => speakConversationSnapshot(list, store, state, prev === undefined),
    { immediate: true }
  )
  try {
    store.details[src] = { messages: [], nodes: [] }
    await nextTick()
    store.details[src].nodes.push({ id: 'm1', role: 'assistant', blocks: [] })
    store.details[src].messages = store.details[src].nodes.map((node) => ({ message: node, version: 0 }))
    await nextTick()
    // 必须通过 reactive 代理改（nodes.push 之后原始对象和代理已经分家）：
    // 改原始对象不触发 watch，流式增量就永远送不到播报
    const live = () => store.details[src].messages.find((entry) => entry.message.id === 'm1').message

    // 气泡 id 的形状：store.pushBubble 用 `${会话}:${kind}:${块ID}`，text 块的 kind 恒为 'text'
    const bubbleID = `${src}:text:blk1`
    live().blocks = [{ id: 'blk1', kind: { text: '第一句。' } }]
    await nextTick()
    assert.equal(isSpeechTagPending(bubbleID), true, 'replySpeech 打的 tag 就是气泡 id')

    // 先有句子入队、再挂监听（和 store.fadeBubble 的顺序一致：它先查 isSpeechTagPending 再注册）。
    // 反过来挂的话计数还是 0，「不 pending」会被当成已念完而立即回调
    let drained = 0
    onSpeechTagDrained(bubbleID, () => (drained += 1))

    live().blocks = [{ id: 'blk1', kind: { text: '第一句。第二句。' } }]
    await nextTick()
    await bridge.playOne()
    assert.equal(drained, 0, '还剩一句：气泡不能收')
    await bridge.playOne()
    assert.equal(drained, 1, '整条气泡念完：通知到了')
  } finally {
    stop()
    stopForeground()
    bridge.restore()
  }
})

test('同会话新一轮回复：replySpeech 打的 turn 让老回复自动压低', async () => {
  const { reactive, computed, watch, nextTick } = require('vue')
  const {
    conversationSpeechSnapshot,
    createConversationSpeechState,
    speakConversationSnapshot
  } = require('../.tmp/replyspeech.cjs')
  const bridge = mockBridge()
  const src = newSource()
  const store = reactive({ details: {}, historyMessages: {}, activeConversationID: src })
  const conversationID = computed(() => store.activeConversationID)
  setSpeechForeground(src)
  const stopForeground = watch(conversationID, (conv) => setSpeechForeground(conv ?? ''), { immediate: true })
  const state = createConversationSpeechState()
  const stop = watch(
    () => conversationSpeechSnapshot(store, conversationID.value),
    (list, prev) => speakConversationSnapshot(list, store, state, prev === undefined),
    { immediate: true }
  )
  const detail = () => store.details[src]
  const upsert = (message) => {
    const at = detail().nodes.findIndex((node) => node.id === message.id)
    if (at >= 0) detail().nodes[at] = message
    else detail().nodes.push(message)
    detail().messages = detail().nodes.map((node) => ({ message: node, version: 0 }))
  }
  try {
    store.details[src] = { messages: [], nodes: [] }
    await nextTick()
    // 第一轮：还在念（长回复）
    upsert({ id: 'm1', role: 'assistant', blocks: [{ id: 'b1', kind: { text: '老回复的第一句。老回复的第二句。' } }] })
    await nextTick()
    await bridge.synthOne() // 老回复第一句出声
    const gain = channelGain(bridge)
    assert.equal(gain.gain.value, 1, '老回复单独在念时原声')

    // 第二轮来了（同会话新消息）
    upsert({ id: 'm2', role: 'assistant', blocks: [{ id: 'b2', kind: { text: '新回复的第一句。' } }] })
    await nextTick()
    assert.ok(gain.gain.value < 0.5, `老回复被压低成背景音（gain=${gain.gain.value}）`)
  } finally {
    stop()
    stopForeground()
    bridge.restore()
  }
})
