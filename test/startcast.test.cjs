// 启动时的历史投层防护：客户端一启动（或重连）就会重新订阅正在跑的会话，服务端随之把整段消息
// 和子 Agent 运行记录再下发一遍。这些「存量」里的工具调用不该补投成操作卡、文本不该重弹成气泡——
// 2026-10 用户报告：启动时桌面上一次冒出几十张历史操作卡（旧防护只按「首见 / 完结」判断，
// 而重下第二次就不再是首见，整片子 Agent 工具卡被弹回来）。这里用 store 实例按真实时序复刻。
// 基建同 histbubble.test.cjs / agentcast.test.cjs：esbuild 打包 store + pinia stub。

const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')
const { join } = require('node:path')
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
  join(tmp, 'pinia-stub-start.mjs'),
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
  join(tmp, 'host-stub-start.mjs'),
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
    outfile: join(tmp, 'app-start.mjs'),
    plugins: [
      {
        name: 'stub',
        setup({ onResolve }) {
          onResolve({ filter: /^pinia$/ }, () => ({ path: join(tmp, 'pinia-stub-start.mjs') }))
          onResolve({ filter: /^vue$/ }, () => ({ path: join(tmp, 'host-stub-start.mjs') }))
          onResolve({ filter: /lib\/host\.js$/ }, () => ({ path: join(tmp, 'host-stub-start.mjs') }))
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
  const { useAppStore } = await import(pathToFileURL(join(tmp, 'app-start.mjs')).href)
  return useAppStore
}

let useStore = null
async function rig() {
  if (!useStore) useStore = await buildStore()
  const store = useStore()
  store.$reset()
  return store
}

const block = (id, kind, text) => ({ id, kind: { [kind]: { _0: text } } })
const message = (id, blocks, extra = {}) => ({ id, role: 'assistant', blocks, createdAt: '2026-01-01T00:00:00Z', ...extra })
/** 工具块：kind.tool 的 _0 是 ToolEvent（无参关联值） */
const toolBlock = (event) => ({ id: `blk-${event.id}`, kind: { tool: event } })
const tool = (over) => ({ name: 'read_file', status: 'succeeded', result: '内容', arguments: 'a.txt', ...over })
const delegate = (over) => ({ id: 'host-1', name: 'delegate_task', status: 'running', agentName: '研究员', ...over })

/** 把一段消息装进 detail（订阅回执的样子），再按「会话正在跑」登记历史 */
function subscribe(store, messages) {
  store.details['conv-a'] = {
    conversationID: 'conv-a',
    messages: messages.map((message) => ({ message, version: 0 })),
    nodes: [...messages],
    selectedChildren: {},
    runtime: { generating: true, pendingApproval: false },
    versions: {}
  }
  store.noteHistory(store.details['conv-a'], true)
  return store.details['conv-a']
}

const cardIDs = (store) => store.opCards.map((card) => card.id).sort()

test('启动订阅正在生成的会话：tail 里已有的工具调用不补投成卡', async () => {
  const store = await rig()
  const user = message('u1', [block('ub1', 'text', '帮我改一下')], { role: 'user' })
  const tail = message('m1', [
    block('tb1', 'thinking', '先看看文件'),
    toolBlock(tool({ id: 'old-1' })),
    toolBlock(tool({ id: 'old-2', name: 'run_shell' })),
    block('tx1', 'text', '上半段结论')
  ])
  subscribe(store, [user, tail])
  assert.deepEqual(cardIDs(store), [], '订阅当刻不投卡')

  // 服务端随后把这条消息原样又下发一次
  store.applyWholeMessage({ conversationID: 'conv-a', message: tail, version: 1 })
  assert.deepEqual(cardIDs(store), [], '原样重下不该补投历史卡')

  // partial 快照（服务端随新活动推局部树）再来一次
  store.applyConversationSnapshot({ conversation: { id: 'conv-a', nodes: [tail] }, partial: true })
  assert.deepEqual(cardIDs(store), [], 'partial 快照不该补投历史卡')

  // 换全套块 id 重推（histbubble 同源场景）
  const replay = { ...tail, blocks: tail.blocks.map((item, index) => ({ ...item, id: `re-${index}` })) }
  store.applyWholeMessage({ conversationID: 'conv-a', message: replay, version: 2 })
  assert.deepEqual(cardIDs(store), [], '换块 id 重推也不补投')
  assert.equal(store.bubbles.length, 0, '没完结的消息换了块 id 也不把历史文本重弹成气泡')
})

test('启动时子 Agent 运行记录里的历史卡不在重下时补弹', async () => {
  const store = await rig()
  const host = delegate({
    transcript: [
      block('t1', 'thinking', '先查资料'),
      toolBlock(tool({ id: 'inner-1', name: 'web_search', result: '十条' })),
      block('t2', 'text', '初步结论')
    ]
  })
  const tail = message('m1', [toolBlock(host)])
  subscribe(store, [message('u1', [block('ub1', 'text', '派个活')], { role: 'user' }), tail])
  assert.deepEqual(cardIDs(store), [], '订阅当刻不投子 Agent 卡')

  store.applyWholeMessage({ conversationID: 'conv-a', message: tail, version: 1 })
  assert.deepEqual(cardIDs(store), [], '第一次重下不投')
  store.applyWholeMessage({ conversationID: 'conv-a', message: tail, version: 2 })
  assert.deepEqual(cardIDs(store), [], '同一份 transcript 再重下也不补弹')
  store.applyConversationSnapshot({ conversation: { id: 'conv-a', nodes: [tail] }, partial: true })
  assert.deepEqual(cardIDs(store), [], 'partial 快照同理')
  assert.equal(store.bubbles.length, 0, '子 Agent 的历史思考/文本也不重弹')
})

test('真新活动照投：新工具、流式增量不被历史防护吞掉', async () => {
  const store = await rig()
  const user = message('u1', [block('ub1', 'text', '继续')], { role: 'user' })
  const tail = message('m1', [block('tb1', 'thinking', '先看看'), toolBlock(tool({ id: 'old-1' })), block('tx1', 'text', '上半段')])
  subscribe(store, [user, tail])

  const live = { ...tail, blocks: [...tail.blocks, toolBlock(tool({ id: 'new-1', name: 'run_shell', status: 'running' }))] }
  store.applyWholeMessage({ conversationID: 'conv-a', message: live, version: 1 })
  assert.deepEqual(cardIDs(store), ['new-1'], '新出现的工具照投')

  const grown = {
    ...live,
    blocks: live.blocks.map((item) => (item.id === 'tx1' ? block('tx1', 'text', '上半段，接着往下写') : item))
  }
  store.applyWholeMessage({ conversationID: 'conv-a', message: grown, version: 2 })
  assert.ok(
    store.bubbles.some((bubble) => bubble.text.includes('接着往下写')),
    '流式新增的文本照投'
  )
})

test('启动时历史里等审批的工具调用照弹：要处理的事不能藏', async () => {
  const store = await rig()
  const tail = message('m1', [
    toolBlock(tool({ id: 'wait-1', name: 'run_shell', title: '删除文件', status: 'awaitingApproval', result: '' }))
  ])
  subscribe(store, [message('u1', [block('ub1', 'text', '清一下')], { role: 'user' }), tail])
  store.applyWholeMessage({ conversationID: 'conv-a', message: tail, version: 1 })
  const card = store.opCards.find((item) => item.id === 'wait-1')
  assert.ok(card, '等审批的卡要弹出来')
  assert.equal(card.status, 'awaitingApproval')
})

test('子 Agent 继续推进时新工具卡照投', async () => {
  const store = await rig()
  const host = delegate({ transcript: [toolBlock(tool({ id: 'inner-1' }))] })
  const tail = message('m1', [toolBlock(host)])
  subscribe(store, [message('u1', [block('ub1', 'text', '派个活')], { role: 'user' }), tail])
  store.applyWholeMessage({ conversationID: 'conv-a', message: tail, version: 1 })
  assert.deepEqual(cardIDs(store), [], '重下的存量卡不弹')

  const advanced = {
    ...host,
    transcript: [...host.transcript, toolBlock(tool({ id: 'inner-2', name: 'write_file', status: 'running', result: '' }))]
  }
  const tail2 = { ...tail, blocks: [toolBlock(advanced)] }
  store.applyWholeMessage({ conversationID: 'conv-a', message: tail2, version: 2 })
  assert.deepEqual(cardIDs(store), ['inner-2'], '新推进的子 Agent 工具照投')
})