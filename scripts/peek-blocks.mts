// 看一段真实会话里 blocks 的原始 JSON 形状（排查文本块渲染）

import { MachineConnection } from '../src/protocol/session/MachineManager.js'
import { PairingStore } from '../src/protocol/session/PairingStore.js'

const pairings = new PairingStore({
  async load() { return null },
  async store() {},
  async delete() {}
})

let ready = false
const machine = new MachineConnection(
  'test',
  '机器',
  { kind: 'ssh', host: 'root@192.168.20.239' },
  {
    appVersion: '0.1.0',
    pairings,
    onStateChange: (m) => {
      if (m.state === 'ready') ready = true
    },
    onEvent: () => {}
  }
)

machine.connect()
void main()

async function main() {
  for (let i = 0; i < 60 && !ready; i++) await sleep(500)
  if (!ready) throw new Error('连不上')

  const target = machine.summaries.find((s) => s.title.includes('删文件')) ?? machine.summaries.find((s) => s.title.includes('子 Agent')) ?? machine.summaries[0]
  if (!target) throw new Error('没找到目标会话')
  console.log('会话:', target.title)
  const result = (await machine.request('conversation.subscribe', { id: target.id })) as {
    conversation: { nodes: Array<{ blocks: unknown[] }> }
  }
  const nodes = result.conversation.nodes
  console.log('消息数:', nodes.length)
  for (const node of nodes) {
    for (const block of node.blocks) {
      const json = JSON.stringify(block)
      // 工具块、媒体块、带 _0 的都打出来
      if (json.includes('"tool"') || json.includes('media') || json.includes('_0')) {
        console.log('BLOCK:', json.slice(0, 500))
      }
    }
  }
  machine.disconnect()
  process.exit(0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
