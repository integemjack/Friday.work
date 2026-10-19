// 验证 M4 配对：server.pair 生成链接 → 用链接走 wss 连上（配对通道真机验证）
import { MachineConnection } from '../src/protocol/session/MachineManager.js'
import { PairingStore } from '../src/protocol/session/PairingStore.js'

class MemoryPairings extends PairingStore {
  private store = new Map<string, { token: string; fingerprint?: string; deviceID?: string }>()
  constructor() {
    super({
      async read(key) {
        return null
      },
      async write() {},
      async delete() {}
    })
  }
}

async function main(): Promise<void> {
  const pairings = new PairingStore({
    async load() {
      return null
    },
    async store() {},
    async delete() {}
  })
  const ssh = new MachineConnection(
    'pair-test-ssh',
    'ubuntu',
    { kind: 'ssh', host: 'root@192.168.20.239' },
    { pairings, onEvent: () => {}, onStateChange: () => {}, onBridgeError: () => {} }
  )
  await ssh.connect()
  await new Promise((r) => setTimeout(r, 1200))
  if (ssh.state !== 'ready') throw new Error(`SSH 没连上：${ssh.state} ${ssh.detail ?? ''}`)

  // 先确保 WS 入口开着（不开时 server.pair 回「先用 --websocket on 打开」）
  try {
    const ws = (await ssh.request('server.websocket', { enabled: true })) as {
      enabled?: boolean
      listening?: boolean
      secure?: boolean
      urls?: string[]
      fingerprint?: string
      error?: string
    }
    console.log('server.websocket:', JSON.stringify(ws).slice(0, 300))
  } catch (error) {
    console.log('server.websocket 失败（可能经 SSH 不允许）：', error instanceof Error ? error.message : error)
  }

  const paired = (await ssh.request('server.pair', { name: 'Friday 桌面测试' })) as {
    deviceID: string
    link: string
    fingerprint?: string
  }
  console.log('server.pair 设备:', paired.deviceID)
  console.log('链接:', paired.link.slice(0, 120) + (paired.link.length > 120 ? '…' : ''))
  console.log('指纹:', paired.fingerprint ?? '(无)')

  // 用配对链接连一次（验证 wss + 指纹校验路径）
  const url = new URL(paired.link.replace('friday://pair', 'http://pair'))
  const target = url.searchParams.get('u') ?? ''
  const token = url.searchParams.get('t') ?? ''
  const fingerprint = url.searchParams.get('f') ?? ''
  console.log('解析 u:', target, '有令牌:', !!token, '有指纹:', !!fingerprint)

  const wsMachine = new MachineConnection(
    'pair-test-ws',
    'ubuntu（配对）',
    { kind: 'ws', url: target, token, fingerprint } as never,
    { pairings, onEvent: () => {}, onStateChange: () => {}, onBridgeError: () => {} }
  )
  // 配对令牌放在 PairingStore（连接时从 host.pairings 取）
  await pairings.save(target, { token, fingerprint })
  await wsMachine.connect()
  await new Promise((r) => setTimeout(r, 3000))
  console.log('配对通道状态:', wsMachine.state, wsMachine.detail ?? '')
  console.log('配对通道看到的会话数:', wsMachine.summaries.length)
  console.log('这台机器上终端可用:', wsMachine.terminals.available, wsMachine.terminals.reason ?? '')

  wsMachine.disconnect()
  ssh.disconnect()
}

main().catch((error) => {
  console.error('✗ 失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
