// e2e：runner.setEngine 真机验证（输入框模型选择的协议链路）。
// 用法：esbuild 打包后 node 运行：
//   node .tmp/e2e-set-engine.cjs <wss-url> <token> <fingerprint>
// 流程：WS 配对连接 → hello → 新建会话 → runner.setEngine 切到另一台引擎 →
//       等 summaries 事件断言 engineID 变了 → conversation.remove 清理。

import { randomUUID } from 'node:crypto'
import { MachineConnection } from '../src/protocol/session/MachineManager.js'
import { PairingStore } from '../src/protocol/session/PairingStore.js'

const [url = '', token = '', fingerprint = ''] = process.argv.slice(2)
if (!url || !token || !fingerprint) {
  console.error('用法：node e2e-set-engine.cjs <wss-url> <token> <fingerprint>')
  process.exit(1)
}

const backend = {
  async load() { return null },
  async store() {},
  async delete() {}
}
const pairings = new PairingStore(backend)

let sawReady = false
let summariesEvents = 0
let latestSummaries: Array<{ id: string; engineID?: string }> = []
let summariesNotify: (() => void) | null = null
/** 订阅后的 conversation / runtime 事件（完整快照，含 engineID / 生效大脑） */
let conversationSnapshots: Array<Record<string, unknown>> = []
let runtimeEvents: Array<Record<string, unknown>> = []
let stateNotify: (() => void) | null = null
/** 测试会话 id（事件打印用；协议约定 UUID 大写带连字符，比较才不会错） */
const pendingConversationID = randomUUID().toUpperCase()

const machine = new MachineConnection(
  'e2e-set-engine',
  '本机 Friday',
  { kind: 'ws', url, token, fingerprint, suggestedName: 'e2e-set-engine' },
  {
    appVersion: '0.2.0',
    pairings,
    onStateChange: (m) => {
      console.log(`[状态] ${m.state}${m.detail ? `（${m.detail}）` : ''}`)
      if (m.state === 'ready') sawReady = true
    },
    onEvent: (_m, method, params) => {
      if (method === 'summaries') {
        summariesEvents++
        const list = (params as { summaries?: Array<Record<string, unknown>> }).summaries ?? []
        const mine = list.find((s) => s.id === pendingConversationID)
        if (mine) {
          console.log(`[事件] summaries #${summariesEvents}，目标会话：${JSON.stringify(mine)}`)
        }
        latestSummaries = list as Array<{ id: string; engineID?: string }>
        summariesNotify?.()
      } else if (method === 'conversation') {
        const conversation = (params as { conversation?: Record<string, unknown> }).conversation
        if (conversation?.id === pendingConversationID) {
          conversationSnapshots.push(conversation)
          console.log(
            `[事件] conversation 快照：engineID=${String(conversation.engineID ?? '（空）')} thinking=${String(conversation.thinking ?? '（空）')}`
          )
        }
        stateNotify?.()
      } else if (method === 'runtime') {
        const rt = (params as { conversationID?: string; runtime?: Record<string, unknown> }).runtime
        if ((params as { conversationID?: string }).conversationID === pendingConversationID && rt) {
          runtimeEvents.push(rt)
          console.log(`[事件] runtime：${JSON.stringify(rt).slice(0, 300)}`)
        }
        stateNotify?.()
      }
    }
  }
)

const timeout = setTimeout(() => {
  console.error('✗ 60 秒没跑完，退出')
  process.exit(1)
}, 60_000)

machine.connect()

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  for (let i = 0; i < 60 && !sawReady; i++) await sleep(500)
  if (!sawReady) throw new Error('没连上（hello 没过）')
  const info = machine.serverInfo
  console.log(`服务端 ${info?.version} features=${info?.features?.join(',')}`)

  // 可用引擎：至少要两个才能「切换」
  const engines = machine.engines.filter((engine) => !engine.disabled)
  console.log(`引擎 ${engines.length} 个：${engines.map((e) => `${e.title}(${e.id.slice(0, 8)})`).join('、')}`)
  if (engines.length < 2) throw new Error(`可用引擎只有 ${engines.length} 个，没法验证切换`)

  const from = engines.find((e) => e.id === machine.defaultEngineID) ?? engines[0]!
  const to = engines.find((e) => e.id !== from.id)!
  console.log(`默认引擎：${from.title}；切到：${to.title}`)

  // 新建一段空白会话（客户端自己生成 id，REMOTE.md §6）
  const conversationID = pendingConversationID
  const created = await machine.request('conversation.create', { id: conversationID })
  console.log('新建会话:', conversationID, '回执:', JSON.stringify(created))
  const before = machine.summaries.find((s) => s.id === conversationID)
  console.log(`切换前 summary.engineID = ${before?.engineID ?? '（空）'}`)

  // 切引擎
  const setResult = await machine.request('runner.setEngine', { conversationID, engineID: to.id })
  console.log('runner.setEngine 回执:', JSON.stringify(setResult))

  // 服务端 AgentRunner.setEngine 就是写会话存储的 engineID（store.update，AgentRunner.swift:614）；
  // runtime.engine 只在有生成活动后才有，空会话查不到 —— 重连重新 hello 拿全量 summaries 验证写入。
  machine.disconnect()
  sawReady = false
  machine.connect()
  for (let i = 0; i < 60 && !sawReady; i++) await sleep(500)
  if (!sawReady) throw new Error('重连失败')
  const after = machine.summaries.find((s) => s.id === conversationID)
  console.log(`重连后 summary.engineID = ${after?.engineID ?? '（空）'}`)

  if (after?.engineID !== to.id) {
    throw new Error(`✗ 切换没写入：期望 ${to.id.slice(0, 8)}，实际 ${after?.engineID ?? '（空）'}`)
  }
  console.log(`✓ runner.setEngine 生效：${from.title} → ${to.title}（重连后 hello 快照的 summary.engineID）`)

  // 清理：删掉测试会话
  try {
    await machine.request('conversation.remove', { id: conversationID })
    console.log('已删除测试会话')
  } catch (error) {
    console.log('删除测试会话失败（不影响结论）:', error instanceof Error ? error.message : String(error))
  }

  clearTimeout(timeout)
  machine.disconnect()
  console.log('\nALL PASS')
  process.exit(0)
}

main().catch((error) => {
  clearTimeout(timeout)
  console.error('✗', error instanceof Error ? error.message : error)
  process.exit(1)
})
