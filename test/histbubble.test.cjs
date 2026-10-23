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
// host / vue stub：渲染进程桥和响应式在 node 里不可用；host.request 可由用例经 globalThis.__hostReply 给回执（订阅）
writeFileSync(
  join(tmp, 'host-stub.mjs'),
  `export const host = { request: async (req) => (globalThis.__hostReply ? globalThis.__hostReply(req) : {}), on: () => () => {} }
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

// ---- 打开历史会话后发消息：订阅那一刻已有的消息是历史（不靠 finishedAt） ----
const tool = (id, toolID, status = 'succeeded') => ({
  id,
  kind: { tool: { _0: { id: toolID, name: 'run_shell', title: '执行命令', arguments: 'ls', result: 'ok', status } } }
})
const user = (id) => ({ id, role: 'user', blocks: [block(`${id}-b`, 'text', '问题')], createdAt: '2026-01-01T00:00:00Z' })

/** 消息树按顺序串成一条路径（rebuildPath 按 parentID 展开，末尾那条才找得对） */
const chain = (nodes) => nodes.map((node, i) => (i ? { ...node, parentID: nodes[i - 1].id } : node))

/** 一段历史会话：两轮问答，回复里各带一个已结束的工具调用；suffix 换块 id（模拟服务端重推） */
function history(suffix, extra = {}) {
  return chain([
    user('u0'),
    message('a0', [block(`t0${suffix}`, 'thinking', '旧思考'), block(`x0${suffix}`, 'text', '旧回复'), tool(`k0${suffix}`, 'tool-0')], extra),
    user('u1'),
    message('a1', [block(`x1${suffix}`, 'text', '旧回复二'), tool(`k1${suffix}`, 'tool-1')], extra)
  ])
}
const tail = (...nodes) => chain([history('').at(-1), ...nodes]).slice(1)

/** 走真实 subscribeConversation 打开会话（订阅回执 = 整段会话 + runtime） */
async function openConversation(nodes, runtime = { generating: false, pendingApproval: false }) {
  const store = await getStore()
  store.$reset()
  store.currentMachine = 'm'
  globalThis.__hostReply = () => ({ conversation: { id: 'h', nodes, selectedChildren: {} }, runtime, versions: {} })
  try {
    await store.subscribeConversation('h')
  } finally {
    delete globalThis.__hostReply
  }
  assert.ok(store.details['h'], '订阅落地')
  return store
}

for (const finished of [true, false]) {
  test(`修复目标：打开历史会话发消息，重推历史（${finished ? '带' : '不带'} finishedAt）不弹气泡、不弹操作卡`, async () => {
    const extra = finished ? { finishedAt: '2026-01-01T00:01:00Z' } : {}
    const store = await openConversation(history('', extra))
    // 发消息：服务端重推历史（新块 id）+ 新的 user，再重推一次
    store.applyConversationSnapshot({ conversation: { id: 'h', nodes: [...history('-r1', extra), ...tail(user('u2'))] }, partial: true })
    store.applyConversationSnapshot({ conversation: { id: 'h', nodes: history('-r2', extra) }, partial: true })
    assert.deepEqual(store.bubbles.map((b) => b.text), [], '历史不弹气泡')
    assert.equal(store.opCards.length, 0, '历史里的工具调用不弹操作卡')

    // 新一轮回复照常流式投泡
    const reply = { ...message('a2', []), parentID: 'u2' }
    store.applyWholeMessage({ conversationID: 'h', message: reply, version: 1 })
    reply.blocks.push(block('x2', 'text', '新回复'), tool('k2', 'tool-2', 'running'))
    store.applyWholeMessage({ conversationID: 'h', message: reply, version: 2 })
    assert.deepEqual(store.bubbles.map((b) => b.text), ['新回复'])
    assert.deepEqual(store.opCards.map((c) => c.id), ['tool-2'])
  })
}

test('边界：历史里还在等审批的工具照常弹卡（要处理的事不藏）', async () => {
  const store = await openConversation(history(''))
  assert.ok(store.historyMessages['a0'], 'a0 登记为历史')
  // 重推时 a0 里多了一个等审批的工具：历史也照弹（结束态的那个仍不弹）
  const a0 = history('-r1').find((node) => node.id === 'a0')
  a0.blocks.push(tool('k0-ask', 'tool-ask', 'awaitingApproval'))
  store.applyConversationSnapshot({ conversation: { id: 'h', nodes: [a0] }, partial: true })
  assert.deepEqual(store.opCards.map((c) => c.id), ['tool-ask'])
})

test('边界：打开正在生成的会话，末尾那条从订阅时的长度起续投增量', async () => {
  const store = await openConversation(chain([user('u0'), message('a0', [block('x0', 'text', '已经流出来的')])]), {
    generating: true,
    pendingApproval: false
  })
  const live = { ...message('a0', [block('x0', 'text', '已经流出来的后续')]), parentID: 'u0' }
  store.applyWholeMessage({ conversationID: 'h', message: live, version: 1 })
  assert.deepEqual(store.bubbles.map((b) => b.text), ['后续'], '只投订阅之后长出来的')
})

test('边界：整段快照里没跟踪过的旧消息按历史登记，末尾没完结的新消息照常流', async () => {
  const store = await rig()
  store.applyConversationSnapshot({ conversation: { id: 'conv-a', nodes: [...history(''), ...tail(user('u2'), message('a2', []))] } })
  store.applyConversationSnapshot({ conversation: { id: 'conv-a', nodes: history('-r1') }, partial: true })
  store.applyConversationSnapshot({ conversation: { id: 'conv-a', nodes: history('-r2') }, partial: true })
  assert.equal(store.bubbles.length, 0)
  assert.equal(store.opCards.length, 0)
  const reply = { ...message('a2', []), parentID: 'u2' }
  store.applyWholeMessage({ conversationID: 'conv-a', message: reply, version: 1 })
  reply.blocks.push(block('x2', 'text', '新回复'))
  store.applyWholeMessage({ conversationID: 'conv-a', message: reply, version: 2 })
  assert.deepEqual(store.bubbles.map((b) => b.text), ['新回复'])
})

test('边界：关掉会话清掉历史登记', async () => {
  const store = await openConversation(history(''))
  assert.ok(store.historyMessages['a0'])
  await store.closeConversation('h')
  assert.equal(store.historyMessages['a0'], undefined)
})
