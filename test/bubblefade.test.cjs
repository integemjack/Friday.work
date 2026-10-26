// 气泡收尾等 TTS 念完（store.fadeBubble）：跑产品代码本体。
// app.ts 单独 bundle 一份，把 lib/speechOutput 重定向到 .tmp/speechoutput.cjs——
// 这样 store 里的 isSpeechTagPending / onSpeechTagDrained 和测试用的 speakText 是同一个模块实例，
// 能真的把 tag 计数撑起来（histbubble.test.cjs 那份把 speechOutput 内联了，外部够不着）。
const test = require('node:test')
const assert = require('node:assert')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { createRequire } = require('node:module')

const root = join(__dirname, '..')
const tmp = join(root, '.tmp')
mkdirSync(tmp, { recursive: true })

const esbuildRequire = createRequire(join(root, 'package.json'))
const { build } = esbuildRequire('esbuild')

// pinia stub：options store 直接实例化（state 展开 + getters 访问器 + actions 绑 this）
// 用 cjs：store bundle 也出 cjs，这样它和测试 require 的 .tmp/speechoutput.cjs 是同一份实例
// （esm bundle import cjs 会走两套 loader 缓存，tagPending 会变成两个 Map，永远对不上）
writeFileSync(
  join(tmp, 'pinia-stub-bubblefade.cjs'),
  `exports.defineStore = function (id, options) {
  return function useStore() {
    const store = { $id: id }
    Object.assign(store, options.state ? options.state() : {})
    store.$reset = function () { Object.assign(this, options.state()) }
    for (const [name, getter] of Object.entries(options.getters ?? {})) {
      Object.defineProperty(store, name, { get() { return getter.call(store) }, configurable: true })
    }
    for (const [name, action] of Object.entries(options.actions ?? {})) store[name] = action.bind(store)
    return store
  }
}
`
)
writeFileSync(
  join(tmp, 'host-stub-bubblefade.cjs'),
  `exports.host = { request: async () => ({}), on: () => () => {} }
exports.rpc = async function () { return {} }
`
)

let useStore = null
async function getStore() {
  if (useStore) return useStore()
  await build({
    entryPoints: [join(root, 'src/renderer/src/stores/app.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(tmp, 'app-bubblefade.cjs'),
    external: ['electron'],
    plugins: [
      {
        name: 'stub',
        setup({ onResolve }) {
          onResolve({ filter: /^pinia$/ }, () => ({ path: join(tmp, 'pinia-stub-bubblefade.cjs') }))
          onResolve({ filter: /lib\/host\.js$/ }, () => ({ path: join(tmp, 'host-stub-bubblefade.cjs') }))
          // 关键：speechOutput 不内联，指回测试共用的那份 cjs。
          // 必须带 external: true——只给 path 的话 esbuild 会照样把它打进 bundle，
          // store 和测试就各持一份 tagPending，计数永远对不上
          onResolve({ filter: /lib\/speechOutput\.js$/ }, () => ({
            path: join(tmp, 'speechoutput.cjs'),
            external: true
          }))
        }
      }
    ]
  })
  globalThis.window = Object.assign(globalThis, {
    innerWidth: 1600,
    innerHeight: 900,
    addEventListener() {},
    fridayRequestPort() {}
  })
  useStore = require(join(tmp, 'app-bubblefade.cjs')).useAppStore
  return useStore()
}

// 和 store 共用同一个 speechOutput 实例
const speech = require('../.tmp/speechoutput.cjs')
const { speakText, stopSpeaking, setSpeechForeground, isSpeechTagPending } = speech

// ---- mock 桥：合成请求排队，测试手动放行（空 samples 跳过播放，不碰 AudioContext） ----
function mockBridge() {
  const pending = []
  globalThis.window.fridayBridge = {
    speakReply: ({ text }) => new Promise((resolve) => pending.push({ resolve, text })),
    cancelCosyVoice: () => Promise.resolve()
  }
  const flushMicro = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  /** 放行 n 句合成（空音频 → 泵直接算播完 → retire → tag 计数减） */
  const play = async (count = 1) => {
    for (let i = 0; i < count; i++) {
      const item = pending.shift()
      if (!item) throw new Error('没有待放行的合成请求')
      item.resolve({ samples: new Float32Array(0), sampleRate: 24000 })
      await flushMicro()
    }
  }
  const restore = () => {
    stopSpeaking()
    for (const item of pending.splice(0)) item.resolve({ samples: new Float32Array(0), sampleRate: 24000 })
    delete globalThis.window.fridayBridge
  }
  return { pending, flushMicro, play, restore }
}

/** 投一条 text 气泡，返回它的 id（形状 = replySpeech 打的 tag） */
function pushTextBubble(store, conv, blockID, text) {
  store.pushBubble(conv, 'text', text, blockID)
  return `${conv}:text:${blockID}`
}

test('气泡 id 的形状就是 replySpeech 打的 tag（两边必须对得上，否则永远等不到通知）', async () => {
  const store = await getStore()
  const bridge = mockBridge()
  setSpeechForeground('conv-x')
  try {
    store.$reset()
    const id = pushTextBubble(store, 'conv-x', 'blk-1', '气泡里的句子。')
    assert.equal(id, 'conv-x:text:blk-1')
    assert.equal(store.bubbles[0].id, id, 'pushBubble 用的就是这个 id')

    // replySpeech 那边打的 tag：`${conv}:text:${block.id}`（见 lib/replySpeech.ts）
    speakText('气泡里的句子。', { append: true, source: 'conv-x', tag: id })
    await bridge.flushMicro()
    assert.equal(isSpeechTagPending(id), true, 'tag 对得上：计数撑起来了')
  } finally {
    bridge.restore()
  }
})

test('到点时 TTS 还在念：气泡不渐隐，念完了才收', async () => {
  const store = await getStore()
  const bridge = mockBridge()
  setSpeechForeground('conv-a')
  try {
    store.$reset()
    const id = pushTextBubble(store, 'conv-a', 'blk-1', '第一句。第二句。')
    speakText('第一句。第二句。', { append: true, source: 'conv-a', tag: id })
    await bridge.flushMicro()

    store.fadeBubble(id) // 5 秒计时到点
    const bubble = store.bubbles.find((item) => item.id === id)
    assert.equal(bubble.fading, false, '还在念：不渐隐')
    assert.equal(bubble.waitingSpeech, true, '记下「在等念完」')
    assert.equal(store.bubbles.length, 1, '气泡还在桌面上')

    await bridge.play(1) // 第一句念完
    assert.equal(bubble.fading, false, '还剩一句：继续等')

    await bridge.play(1) // 第二句念完 → drained 通知
    assert.equal(bubble.fading, true, '念完了：开始渐隐')
    assert.equal(bubble.waitingSpeech, false, '等待标记清掉')
  } finally {
    bridge.restore()
  }
})

test('用户点气泡关闭：不等 TTS，立即渐隐', async () => {
  const store = await getStore()
  const bridge = mockBridge()
  setSpeechForeground('conv-b')
  try {
    store.$reset()
    const id = pushTextBubble(store, 'conv-b', 'blk-1', '正在念的句子。')
    speakText('正在念的句子。', { append: true, source: 'conv-b', tag: id })
    await bridge.flushMicro()

    store.fadeBubble(id, { user: true }) // DesktopBubbles.vue 的 @click
    const bubble = store.bubbles.find((item) => item.id === id)
    assert.equal(bubble.fading, true, '用户点的立即收')
    assert.equal(bubble.waitingSpeech, undefined, '不进入等待')
  } finally {
    bridge.restore()
  }
})

test('等待期间又来了新内容：作废这次等待，按新内容重新计时（不被旧通知硬收）', async () => {
  const store = await getStore()
  const bridge = mockBridge()
  setSpeechForeground('conv-c')
  try {
    store.$reset()
    const id = pushTextBubble(store, 'conv-c', 'blk-1', '第一句。')
    speakText('第一句。', { append: true, source: 'conv-c', tag: id })
    await bridge.flushMicro()

    store.fadeBubble(id)
    const bubble = store.bubbles.find((item) => item.id === id)
    assert.equal(bubble.waitingSpeech, true)

    // 流式又来了增量：pushBubble 续在同一条气泡上
    store.pushBubble('conv-c', 'text', '第二句。', 'blk-1')
    assert.equal(bubble.waitingSpeech, false, '等待作废，重新计时')
    assert.equal(bubble.fading, false)

    // 第一句念完 → drained 通知到了，但 waitingSpeech 已清：不硬收
    await bridge.play(1)
    assert.equal(bubble.fading, false, '旧通知不能把正在续写的气泡收掉')
    assert.equal(store.bubbles.length, 1)
  } finally {
    bridge.restore()
  }
})

test('thinking 气泡不等（思考块根本不送播报，等也等不到通知）', async () => {
  const store = await getStore()
  const bridge = mockBridge()
  setSpeechForeground('conv-d')
  try {
    store.$reset()
    store.pushBubble('conv-d', 'thinking', '思考内容', 'blk-t')
    const id = 'conv-d:thinking:blk-t'
    // 就算同 id 有句子在念（实际不会发生），thinking 气泡也不等
    speakText('思考内容。', { append: true, source: 'conv-d', tag: id })
    await bridge.flushMicro()

    store.fadeBubble(id)
    const bubble = store.bubbles.find((item) => item.id === id)
    assert.equal(bubble.fading, true, 'thinking 气泡照常立即渐隐')
  } finally {
    bridge.restore()
  }
})

test('没有句子在念时到点：照常立即渐隐（不能因为这套机制把普通气泡卡住）', async () => {
  const store = await getStore()
  const bridge = mockBridge()
  setSpeechForeground('conv-e')
  try {
    store.$reset()
    const id = pushTextBubble(store, 'conv-e', 'blk-1', '播报关着时投的气泡。')
    store.fadeBubble(id)
    const bubble = store.bubbles.find((item) => item.id === id)
    assert.equal(bubble.fading, true, '不 pending 就不等')
    assert.equal(bubble.waitingSpeech, undefined)
  } finally {
    bridge.restore()
  }
})

test('关播报 / 停播：被丢的句子退干净，等着的气泡照样能收', async () => {
  const store = await getStore()
  const bridge = mockBridge()
  setSpeechForeground('conv-f')
  try {
    store.$reset()
    const id = pushTextBubble(store, 'conv-f', 'blk-1', '念到一半被停掉。')
    speakText('念到一半被停掉。后面还有。', { append: true, source: 'conv-f', tag: id })
    await bridge.flushMicro()

    store.fadeBubble(id)
    const bubble = store.bubbles.find((item) => item.id === id)
    assert.equal(bubble.waitingSpeech, true, '在等')

    stopSpeaking() // 用户关了播报总开关
    await bridge.flushMicro()
    assert.equal(bubble.fading, true, '句子被丢也算了结：气泡收掉，不会永远留在桌面上')
  } finally {
    bridge.restore()
  }
})
