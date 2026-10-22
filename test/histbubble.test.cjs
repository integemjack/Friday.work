// 投窗气泡的重放防护：已完结（收尾/出错/被打断）的消息只记下标、不再投泡。
// 背景：服务端随新一轮活动重推历史时块 id 会换新——结束的会话里一执行新内容，
// 已见过的消息会按新块 id 全部重弹成气泡（2026-10 用户报告）。这里用 store 实例
// 按真实事件时序（首帧 → 增量 → 收尾拍）复刻并验证，含边界负例。
// 打包：worktree 没有 node_modules，esbuild 优先从本仓库解、退回主工作树。

const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')
const { join, dirname } = require('node:path')
const { createRequire } = require('node:module')

const root = join(__dirname, '..')
const tmp = join(root, '.tmp')
mkdirSync(tmp, { recursive: true })

let esbuildRequire
try {
  esbuildRequire = createRequire(join(root, 'package.json'))
  esbuildRequire('esbuild/package.json')
} catch {
  esbuildRequire = createRequire('C:/Users/ultra/Desktop/works/friday-desktop-work/package.json')
}
const { build } = esbuildRequire('esbuild')

// pinia stub：options store 直接实例化（state 展开 + getters 访问器 + actions 绑 this）
writeFileSync(
  join(tmp, 'pinia-stub.mjs'),
  `export function defineStore(id, options) {
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
// host / vue stub：渲染进程桥和响应式在 node 里不可用，气泡链路不碰它们
writeFileSync(
  join(tmp, 'host-stub.mjs'),
  `export const host = { request: async () => ({}), on: () => () => {} }
export async function rpc() { return {} }
export function ref(value) { return { value } }
`
)

async function buildStore() {
  await build({
    entryPoints: [join(root, 'src/renderer/src/stores/app.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: join(tmp, 'app.mjs'),
    plugins: [
      {
        name: 'stub',
        setup({ onResolve }) {
          onResolve({ filter: /^pinia$/ }, () => ({ path: join(tmp, 'pinia-stub.mjs') }))
          onResolve({ filter: /^vue$/ }, () => ({ path: join(tmp, 'host-stub.mjs') }))
          onResolve({ filter: /lib\/host\.js$/ }, () => ({ path: join(tmp, 'host-stub.mjs') }))
        }
      }
    ]
  })
  // node 环境补渲染端全局
  globalThis.window = Object.assign(globalThis, {
    innerWidth: 1600,
    innerHeight: 900,
    addEventListener() {},
    fridayRequestPort() {}
  })
  const { useAppStore } = await import(pathToFileURL(join(tmp, 'app.mjs')).href)
  return useAppStore
}

let useStore = null
async function getStore() {
  if (!useStore) useStore = await buildStore()
  return useStore()
}

// 事件形状：{id, kind:{case:{_0}}}（Swift 带关联值枚举的 Codable）
const block = (id, kind, text) => ({ id, kind: { [kind]: { _0: text } } })
const message = (id, blocks, extra = {}) => ({ id, role: 'assistant', blocks, createdAt: '2026-01-01T00:00:00Z', ...extra })

/** 开一场「正常流完一轮」的会话：details 已订阅，m1 流式完成（首帧 → 增量 → 收尾拍） */
async function rig() {
  const store = await getStore()
  store.$reset()
  store.details['conv-a'] = {
    conversationID: 'conv-a',
    messages: [],
    nodes: [],
    selectedChildren: {},
    runtime: null,
    versions: {}
  }
  return store
}
const countBy = (store, kind) => store.bubbles.filter((b) => b.kind === kind).length

test('基线：正常流式照常投泡（增量投尾巴、新块整块投）', async () => {
  const store = await rig()
  const m1 = message('m1', [block('blk-1a', 'thinking', '历史思考')])
  store.noteAssistantStream('conv-a', m1) // 首见（首帧已带第一块）→ 只记不投
  assert.equal(store.bubbles.length, 0)
  m1.blocks[0].kind = { thinking: { _0: '历史思考乙' } }
  m1.blocks.push(block('blk-1b', 'text', '历史回复乙'))
  store.noteAssistantStream('conv-a', m1) // 未完结：增量照投
  assert.equal(countBy(store, 'thinking'), 1)
  assert.equal(countBy(store, 'text'), 1)
})

test('修复目标：结束的会话重推历史（新块 id）不再弹出历史气泡', async () => {
  const store = await rig()
  // 流完两条历史消息（m0 fresh 完结不投；m1 流式投出两条）
  const m0 = message('m0', [block('blk-0a', 'thinking', '更早的思考'), block('blk-0b', 'text', '更早的回复')], {
    finishedAt: '2026-01-01T00:00:30Z'
  })
  store.noteAssistantStream('conv-a', m0)
  const m1 = message('m1', [block('blk-1a', 'thinking', '思考')])
  store.noteAssistantStream('conv-a', m1)
  m1.blocks[0].kind = { thinking: { _0: '思考乙' } }
  m1.blocks.push(block('blk-1b', 'text', '回复乙'))
  store.noteAssistantStream('conv-a', m1)
  m1.finishedAt = '2026-01-01T00:01:00Z'
  store.noteAssistantStream('conv-a', m1) // 收尾拍
  assert.equal(store.bubbles.length, 2)

  // 会话结束。执行新内容：服务端随新一轮活动重推历史（同消息 id、新块 id、带 finishedAt）
  const replay1 = message('m1', [block('blk-r1a', 'thinking', '思考乙'), block('blk-r1b', 'text', '回复乙')], {
    finishedAt: '2026-01-01T00:01:00Z'
  })
  const replay0 = message('m0', [block('blk-r0a', 'thinking', '更早的思考'), block('blk-r0b', 'text', '更早的回复')], {
    finishedAt: '2026-01-01T00:00:30Z'
  })
  store.applyConversationSnapshot({ conversation: { id: 'conv-a', nodes: [replay0, replay1] }, partial: true })
  assert.equal(store.bubbles.length, 2) // 一个历史气泡都不多弹

  // 重复重放也不弹
  store.applyConversationSnapshot({ conversation: { id: 'conv-a', nodes: [replay0, replay1] }, partial: true })
  assert.equal(store.bubbles.length, 2)
})

test('边界：流式中追加新块（同消息第二段）整块当增量投（原意图保留）', async () => {
  const store = await rig()
  const m2 = message('m2', [])
  store.noteAssistantStream('conv-a', m2) // 首帧空
  m2.blocks.push(block('blk-2a', 'thinking', '新思考'))
  store.noteAssistantStream('conv-a', m2) // 未完结：新块整块投
  assert.equal(countBy(store, 'thinking'), 1)
  m2.blocks.push(block('blk-2c', 'thinking', '第二段思考'))
  store.noteAssistantStream('conv-a', m2)
  assert.equal(countBy(store, 'thinking'), 2)
})

test('边界：打断（stoppedByUser）后封口重推不重弹近全文', async () => {
  const store = await rig()
  const m3 = message('m3', [])
  store.noteAssistantStream('conv-a', m3) // 首帧空
  m3.blocks.push(block('blk-3a', 'text', '被'))
  store.noteAssistantStream('conv-a', m3) // 流式中投出第一截
  assert.equal(store.bubbles.length, 1)
  m3.blocks[0].kind = { text: { _0: '被打断的完整回复' } }
  m3.stoppedByUser = true
  store.noteAssistantStream('conv-a', m3) // 打断封口重推：只记不投
  assert.equal(store.bubbles.length, 1)
})

test('边界：fresh 完结消息整条到达不投（后台会话 / 打开旧会话）', async () => {
  const store = await rig()
  const m4 = message('m4', [block('blk-4a', 'text', '整条完成的消息')], { finishedAt: '2026-01-01T00:02:00Z' })
  store.noteAssistantStream('conv-a', m4)
  assert.equal(store.bubbles.length, 0)
  const m5 = message('m5', [block('blk-5a', 'text', '出错的消息')], { error: 'quota' })
  store.noteAssistantStream('conv-a', m5)
  assert.equal(store.bubbles.length, 0)
})
