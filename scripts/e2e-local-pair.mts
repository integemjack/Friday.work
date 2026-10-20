// 验证本机配对链接（联调脚本，不进 CI）：解析 friday://pair?… → MachineConnection 走 wss → 等 ready。
// 用法：esbuild 打包后 node .tmp/e2e-local-pair.cjs "<friday://pair?u=…&t=…&f=…>"
import { MachineConnection } from '../src/protocol/session/MachineManager.js'
import { PairingStore } from '../src/protocol/session/PairingStore.js'
import { parseTarget } from '../src/protocol/session/TargetParse.js'

async function main(): Promise<void> {
  const link = process.argv[2]
  if (!link) throw new Error('用法：node .tmp/e2e-local-pair.cjs "<friday://pair?…>"（链接当参数传，别写进文件）')
  const target = parseTarget(link)
  if (!target || target.kind !== 'ws' || !target.url || !target.token) {
    throw new Error('配对链接解析失败：要 friday://pair?u=<wss地址>&t=<令牌>&f=<指纹> 格式')
  }

  const pairings = new PairingStore({
    async load() {
      return null
    },
    async store() {},
    async delete() {}
  })
  await pairings.save(target.url, { token: target.token, fingerprint: target.fingerprint })

  const machine = new MachineConnection('local-pair-test', '本机', target, {
    pairings,
    onEvent: () => {},
    onStateChange: () => {},
    onBridgeError: () => {}
  })
  machine.connect()

  const deadline = Date.now() + 10_000
  while (machine.state !== 'ready' && machine.state !== 'failed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  console.log('状态:', machine.state, machine.detail ?? '')
  if (machine.state === 'ready') {
    console.log('server:', machine.serverInfo ? JSON.stringify(machine.serverInfo).slice(0, 240) : '(无)')
    console.log('会话数:', machine.summaries.length)
    console.log('终端可用:', machine.terminals.available, machine.terminals.reason ?? '')
    console.log('引擎数:', machine.engines.length)
  }
  machine.disconnect()
  process.exit(machine.state === 'ready' ? 0 : 1)
}

main().catch((error) => {
  console.error('✗ 失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
