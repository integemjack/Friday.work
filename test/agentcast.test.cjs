// 子 Agent 的运行记录（delegate_task 工具事件的 transcript）投桌面 + agentFocus 生命周期：
// 1) 活的流式：首见事件存量只记不投（等审批的例外），之后新块整块投、已有块投增量；
//    内层工具调用成操作卡（带 agentName），孙层（子 Agent 再往下派）递归；
//    宿主派发卡（delegate_task / run_parallel_tasks）不投（2026-10-26 用户：主智能体
//    派发时显示的派发气泡不要）；
// 2) 历史豁免：宿主消息已完结但事件还 running（后台 run）时不被历史过滤拦住；
// 3) openConversation(conv, runID) 设 agentFocus，普通打开 / 关会话时清掉。
// 基建同 histbubble.test.cjs：esbuild 打包 store + pinia stub（worktree 没有 node_modules，
// esbuild 优先从本仓库解、退回主工作树）。

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

writeFileSync(
  join(tmp, 'pinia-stub-cast.mjs'),
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
writeFileSync(
  join(tmp, 'host-stub-cast.mjs'),
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
    outfile: join(tmp, 'app-cast.mjs'),
    plugins: [
      {
        name: 'stub',
        setup({ onResolve }) {
          onResolve({ filter: /^pinia$/ }, () => ({ path: join(tmp, 'pinia-stub-cast.mjs') }))
          onResolve({ filter: /^vue$/ }, () => ({ path: join(tmp, 'host-stub-cast.mjs') }))
          onResolve({ filter: /lib\/host\.js$/ }, () => ({ path: join(tmp, 'host-stub-cast.mjs') }))
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
  const { useAppStore } = await import(pathToFileURL(join(tmp, 'app-cast.mjs')).href)
  return useAppStore
}

let useStore = null
async function getStore() {
  if (!useStore) useStore = await buildStore()
  return useStore()
}

const block = (id, kind, text) => ({ id, kind: { [kind]: { _0: text } } })
const message = (id, blocks, extra = {}) => ({ id, role: 'assistant', blocks, createdAt: '2026-01-01T00:00:00Z', ...extra })
/** 工具块：kind.tool 的 _0 是 ToolEvent（无参关联值） */
const toolBlock = (event) => ({ id: `blk-${event.id}`, kind: { tool: event } })
const delegate = (over) => ({ id: 'run-1', name: 'delegate_task', status: 'running', agentName: '研究员', ...over })

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
const bubbleText = (store, id) => store.bubbles.find((b) => b.id.endsWith(`:${id}`))?.text ?? ''
const opCard = (store, id) => store.opCards.find((c) => c.id === id)

test('活的流式：首见 transcript 存量只记不投；之后新块整块投、已有块投增量（带 agentName）', async () => {
  const store = await rig()
  const event = delegate({
    transcript: [block('t1', 'thinking', '先查资料'), toolBlock({ id: 'inner-1', name: 'web_search', status: 'running' })]
  })
  const m1 = message('m1', [toolBlock(event)])
  store.noteAssistantStream('conv-a', m1) // 首见：存量只记（宿主派发卡不投，内层全部只记）
  assert.equal(store.bubbles.length, 0)
  assert.equal(store.opCards.length, 0) // 宿主 delegate_task 派发卡不投
  assert.equal(opCard(store, 'inner-1'), undefined)

  // transcript 增长：已有块续写 + 新文本块 + 内层工具有了结果
  event.transcript[0] = block('t1', 'thinking', '先查资料，再整理')
  event.transcript.push(block('t2', 'text', '初步结论'))
  event.transcript[1] = toolBlock({ id: 'inner-1', name: 'web_search', status: 'succeeded', result: '10 条' })
  store.noteAssistantStream('conv-a', m1)
  assert.equal(store.bubbles.length, 2)
  assert.equal(bubbleText(store, 't1'), '，再整理') // 存量只记，只投增量尾巴（同主会话首见规则）
  assert.equal(bubbleText(store, 't2'), '初步结论') // 新块整块投
  assert.ok(store.bubbles.every((b) => b.agentName === '研究员'))
  assert.equal(store.opCards.length, 1) // 只有内层工具卡
  const card = opCard(store, 'inner-1')
  assert.ok(card)
  assert.equal(card.agentName, '研究员')
  assert.equal(card.status, 'succeeded')
  assert.equal(card.result, '10 条')
})

test('孙层递归：组工具（并行派发）的子 Agent 各自投卡/气泡，名字用各自的 agentName', async () => {
  const store = await rig()
  // 首帧：孙层刚派出还没输出，子乙已完成（存量只记）
  const grand = delegate({ id: 'grand-1', agentName: '孙甲', transcript: [] })
  const childB = delegate({ id: 'child-2', agentName: '子乙', status: 'succeeded', result: '乙完成' })
  const group = {
    id: 'group-1',
    name: 'run_parallel_tasks',
    status: 'running',
    agentName: '并行 ×2',
    transcript: [toolBlock(grand), toolBlock(childB)]
  }
  const m1 = message('m1', [toolBlock(group)])
  store.noteAssistantStream('conv-a', m1) // 首见：只记（宿主组派发卡不投）
  assert.equal(store.opCards.length, 0)
  assert.equal(store.bubbles.length, 0)
  // 第二帧：孙层开始输出（新块），子乙的卡照投（续写终态）
  grand.transcript = [block('g1', 'text', '孙层输出')]
  store.noteAssistantStream('conv-a', m1)
  assert.ok(opCard(store, 'child-2'))
  assert.equal(opCard(store, 'child-2').agentName, '子乙')
  assert.equal(opCard(store, 'grand-1').agentName, '孙甲')
  assert.equal(bubbleText(store, 'g1'), '孙层输出')
  assert.ok(store.bubbles.every((b) => b.agentName === '孙甲'))
})

test('首见的存量里等审批的调用例外：卡照弹（要处理的事不能藏）', async () => {
  const store = await rig()
  const event = delegate({
    transcript: [
      toolBlock({ id: 'wait-ok', name: 'run_shell', status: 'awaitingApproval', title: '删除文件' }),
      toolBlock({ id: 'done-ok', name: 'read_file', status: 'succeeded', result: '内容' })
    ]
  })
  store.noteAssistantStream('conv-a', message('m1', [toolBlock(event)]))
  assert.equal(opCard(store, 'run-1'), undefined) // 宿主派发卡不投
  assert.ok(opCard(store, 'wait-ok'))
  assert.equal(opCard(store, 'wait-ok').status, 'awaitingApproval')
  assert.equal(opCard(store, 'wait-ok').agentName, '研究员')
  assert.equal(opCard(store, 'done-ok'), undefined) // 已完结的存量不补弹
})

test('历史豁免：宿主消息已完结但 run 还在跑（后台子 Agent）不被历史过滤拦住；run 结束后恢复拦截', async () => {
  const store = await rig()
  const event = delegate({ transcript: [block('t1', 'text', '后台进度一')] })
  // 首见即完结的消息（打开会话时它在跑后台 run）：历史登记 + done
  const m1 = message('m1', [toolBlock(event)], { finishedAt: '2026-01-01T00:00:30Z' })
  store.historyMessages['m1'] = true
  store.noteAssistantStream('conv-a', m1)
  assert.equal(store.bubbles.length, 0) // 首见存量不投
  assert.equal(store.opCards.length, 0) // 宿主派发卡不投
  assert.ok(store.agentMarks['t1'] === '后台进度一'.length) // 但标记已记：后续增量照投

  // 后台 run 继续：transcript 增长 → 消息补丁重推 → 增量上桌面（同主会话首见规则：存量只记、只投增量尾巴）
  event.transcript[0] = block('t1', 'text', '后台进度一半')
  store.noteAssistantStream('conv-a', m1)
  assert.equal(store.bubbles.length, 1)
  assert.equal(bubbleText(store, 't1'), '半')

  // 服务端重推历史换了全套块 id（重放，旧块全消失）：只记不投，不重弹
  event.transcript = [block('t1-r', 'text', '后台进度一半')]
  store.noteAssistantStream('conv-a', m1)
  assert.equal(store.bubbles.length, 1)
  // 重放之后真正的增量（新块追加）照常投
  event.transcript.push(block('t2-r', 'text', '跑完了'))
  store.noteAssistantStream('conv-a', m1)
  assert.equal(store.bubbles.length, 2)
  assert.equal(bubbleText(store, 't2-r'), '跑完了')

  // run 结束（事件终态）：历史过滤恢复，不再重弹
  event.status = 'succeeded'
  store.noteAssistantStream('conv-a', m1)
  assert.equal(store.bubbles.length, 2)
  assert.equal(store.opCards.length, 0)
})

test('agentFocus：openConversation(conv, runID) 设上；普通打开 / 关会话时清掉', async () => {
  const store = await rig()
  globalThis.__hostReply = () => ({}) // 订阅回执（details 已在 rig 里，不会再发请求）
  await store.openConversation('conv-a', 'run-1')
  assert.deepEqual(store.agentFocus, { conversationID: 'conv-a', runID: 'run-1' })
  await store.openConversation('conv-a')
  assert.equal(store.agentFocus, null)
  await store.openConversation('conv-a', 'run-1')
  await store.closeConversation('conv-a')
  assert.equal(store.agentFocus, null)
  assert.equal(store.agentEvents.size, 0) // 投桌标记也按会话清干净
  delete globalThis.__hostReply
})
