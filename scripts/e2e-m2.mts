// M2 真机联调（无头）：终端 / 文件 / 浏览器 三条链路。
// 跑法：esbuild 打包后 node 运行

import { randomUUID } from 'node:crypto'
import { MachineConnection } from '../src/protocol/session/MachineManager.js'
import { PairingStore } from '../src/protocol/session/PairingStore.js'

const pairings = new PairingStore({
  async load() { return null },
  async store() {},
  async delete() {}
})

const termOutput: string[] = []
let ready = false

const machine = new MachineConnection(
  'test',
  '192.168.20.239',
  { kind: 'ssh', host: 'root@192.168.20.239' },
  {
    appVersion: '0.1.0',
    pairings,
    onStateChange: (m) => {
      if (m.state === 'ready') ready = true
      if (m.state === 'failed') console.log(`[状态] failed: ${m.detail}`)
    },
    onEvent: (_m, method, params) => {
      if (method === 'term.output') {
        const p = params as { id: string; data: string }
        termOutput.push(Buffer.from(p.data, 'base64').toString('utf8'))
      }
      if (method === 'terminals') {
        const p = params as { terminals: Array<{ id: string; title: string; running: boolean }>; available: boolean }
        console.log(`[terminals] available=${p.available} 共 ${p.terminals.length} 个：${p.terminals.map((t) => t.title).join(' / ')}`)
      }
      if (method === 'browser') {
        const p = params as { available: boolean; reason?: string; tabs: unknown[] }
        console.log(`[browser] available=${p.available}${p.reason ? `（${p.reason}）` : ''} 标签 ${p.tabs.length}`)
      }
    }
  }
)

const timeout = setTimeout(() => {
  console.error('✗ 90 秒没跑完')
  process.exit(1)
}, 90_000)

machine.connect()
void main()

async function main() {
  for (let i = 0; i < 60 && !ready; i++) await sleep(500)
  if (!ready) throw new Error('连不上')

  console.log(`\n=== 服务端 ${machine.serverInfo?.version} ===`)
  console.log('features:', (machine.serverInfo?.features ?? []).filter((f) => ['activity', 'messagePatch', 'assistant'].includes(f)).join(', '))
  console.log('terminals 状态:', JSON.stringify(machine.terminals).slice(0, 200))
  console.log('browser 状态:', JSON.stringify(machine.browser).slice(0, 200))
  console.log('team:', JSON.stringify(machine.team).slice(0, 200))

  // 建一段会话（终端要挂在会话上）
  const conversationID = randomUUID()
  await machine.request('conversation.create', { id: conversationID })

  // ---- 终端 ----
  console.log('\n=== 终端：term.open + command ===')
  const termID = randomUUID()
  await machine.request('term.open', {
    id: termID,
    conversationID,
    cols: 100,
    rows: 30,
    command: 'echo M2-TERM-OK; uname -s; pwd'
  })
  await sleep(2500)
  console.log('term.output 收到', termOutput.length, '段；内容：')
  console.log(termOutput.join('').slice(0, 600))

  console.log('\n=== 终端：term.write（模拟用户打字） ===')
  await machine.request('term.write', { id: termID, data: Buffer.from('echo M2-WRITE-OK\r').toString('base64') })
  await sleep(1500)
  console.log('累计内容末尾：', termOutput.join('').slice(-300))

  console.log('\n=== 终端：term.attach（接上已有终端，拿最近输出） ===')
  const attach = (await machine.request('term.attach', { id: termID })) as { data: string; cols: number; rows: number }
  console.log(`attach: ${attach.cols}x${attach.rows}，最近输出 ${Buffer.from(attach.data, 'base64').length} 字节`)
  console.log(Buffer.from(attach.data, 'base64').toString('utf8').slice(-300))

  // ---- 文件 ----
  console.log('\n=== 文件：fs.list /root（带 files:true） ===')
  const list = (await machine.request('fs.list', { path: '/root', files: true })) as {
    path: string
    entries: Array<{ name: string; path: string; dir?: boolean; size?: number }>
    roots?: Array<{ name: string; path: string }>
    truncated?: boolean
  }
  console.log('path:', list.path, ' roots:', JSON.stringify(list.roots), ' truncated:', list.truncated)
  for (const entry of list.entries.slice(0, 12)) {
    console.log(`  ${entry.dir ? '[目录]' : '[文件]'} ${entry.name}${entry.size ? ` (${entry.size} B)` : ''}`)
  }

  console.log('\n=== 文件：fs.read 一个文件 ===')
  const target = list.entries.find((entry) => !entry.dir && entry.size && entry.size < 200_000)
  if (target) {
    const read = (await machine.request('fs.read', { path: target.path, offset: 0, length: 4096 })) as {
      data: string
      size: number
      eof: boolean
    }
    console.log(`读 ${target.path}：size=${read.size} eof=${read.eof}`)
    console.log(Buffer.from(read.data, 'base64').toString('utf8').slice(0, 200))
  } else {
    console.log('（/root 下没有合适的小文件）')
  }

  console.log('\n=== 文件：fs.changes（本次会话改动） ===')
  try {
    const changes = (await machine.request('fs.changes', { conversationID })) as { files: unknown[] }
    console.log('改动文件数:', changes.files?.length ?? 0)
  } catch (error) {
    console.log('fs.changes 出错：', (error as Error).message)
  }

  // ---- 浏览器 ----
  console.log('\n=== 浏览器 ===')
  console.log('available:', machine.browser.available, machine.browser.reason ?? '')
  if (machine.browser.available) {
    try {
      const opened = (await machine.request('browser.open', { conversationID, url: 'https://example.com' })) as { tab: string }
      console.log('开了标签:', opened.tab)
      await machine.request('browser.watch', { tab: opened.tab, width: 800, height: 600 })
      await sleep(4000)
      console.log('（画面帧走 browser.frame 事件，这里不断言）')
      await machine.request('browser.close', { tab: opened.tab })
    } catch (error) {
      console.log('浏览器操作出错：', (error as Error).message)
    }
  }

  // ---- 清理 ----
  console.log('\n=== 清理 ===')
  await machine.request('term.close', { id: termID }).catch(() => {})
  await machine.request('conversation.remove', { id: conversationID }).catch(() => {})
  machine.disconnect()
  clearTimeout(timeout)
  console.log('\n✓ M2 链路联调完成')
  process.exit(0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
