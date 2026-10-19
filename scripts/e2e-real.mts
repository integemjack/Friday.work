// 真机联调（无头）：用项目的协议层直连 friday-server，验证 M1 链路。
// 跑法：esbuild 打包后 node 运行；参数：node .tmp/e2e.cjs

import { randomUUID } from 'node:crypto'
import { MachineConnection } from '../src/protocol/session/MachineManager.js'
import { PairingStore } from '../src/protocol/session/PairingStore.js'

const backend = {
  async load() { return null },
  async store() {},
  async delete() {}
}
const pairings = new PairingStore(backend)

const events = []
let sawHello = false
let subscribed = false

const machine = new MachineConnection(
  'test',
  '192.168.20.239',
  { kind: 'ssh', host: 'root@192.168.20.239' },
  {
    appVersion: '0.1.0',
    pairings,
    onStateChange: (m) => {
      console.log(`[状态] ${m.state}${m.detail ? `（${m.detail}）` : ''}`)
      if (m.state === 'ready') sawHello = true
    },
    onEvent: (m, method, params) => {
      events.push({ method, params })
      if (events.length <= 12) {
        const brief = JSON.stringify(params).slice(0, 160)
        console.log(`[事件] ${method}: ${brief}`)
      }
    }
  }
)

const timeout = setTimeout(() => {
  console.error('✗ 60 秒没跑完，退出')
  process.exit(1)
}, 60_000)

machine.connect()

async function main() {
  // 等 hello
  for (let i = 0; i < 60 && !sawHello; i++) await sleep(500)
  if (!sawHello) throw new Error('没连上（hello 没过）')

  const info = machine.serverInfo
  console.log('\n=== 服务端信息 ===')
  console.log(JSON.stringify({ version: info.version, platform: info.platform, arch: info.arch, hostname: info.hostname, host: info.host, features: info.features }))

  // 快照内容
  const runner = machine.summaries
  console.log(`\n=== hello 快照：${runner.length} 段会话 ===`)
  for (const summary of runner.slice(0, 8)) {
    console.log(`  · ${summary.id} 「${summary.title}」 ${summary.updatedAt}${summary.isEmpty ? '（空）' : ''}`)
  }

  // 新建一段会话并订阅（M1 链路的核心）
  console.log('\n=== conversation.create ===')
  // REMOTE.md §6：客户端自己生成 id，服务端用它建空白会话（已存在就不动）
  const conversationID = randomUUID()
  const created = await machine.request('conversation.create', { id: conversationID })
  console.log('新建会话:', conversationID, '回执:', JSON.stringify(created))

  console.log('\n=== conversation.subscribe ===')
  const subscribeResult = (await machine.subscribeConversation(conversationID))
  subscribed = true
  console.log('订阅回执:', JSON.stringify(subscribeResult).slice(0, 300))

  // 发一句话（这台机器的 hello features 决定了它接没接模型引擎；没接口时 submit 会回错误，也是有效验证）
  console.log('\n=== runner.submit ===')
  try {
    const submitResult = await machine.request('runner.submit', {
      conversationID,
      text: 'M1 联调测试：请回复「收到」两个字。',
      attachments: []
    })
    console.log('submit 回执:', JSON.stringify(submitResult).slice(0, 300))
  } catch (error) {
    console.log('submit 被拒（这台机器如果没有接模型引擎，这是预期内的）:', error.message)
  }

  // 收 8 秒事件
  await sleep(8000)

  console.log(`\n=== 8 秒内共收到 ${events.length} 个事件 ===`)
  const methods = {}
  for (const event of events) methods[event.method] = (methods[event.method] ?? 0) + 1
  console.log(JSON.stringify(methods))

  // 会话列表应包含新会话（summaries 事件或订阅回执）
  console.log('\n=== 清理：删除测试会话 ===')
  await machine.request('conversation.remove', { id: conversationID })
  console.log('已删除', conversationID)

  machine.disconnect()
  clearTimeout(timeout)
  console.log('\n✓ 端到端联调完成')
  process.exit(0)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((error) => {
  console.error('✗ 联调失败:', error.message)
  machine.disconnect()
  process.exit(1)
})

// subscribe 成功后标记（避免 lint 未用变量）
void subscribed