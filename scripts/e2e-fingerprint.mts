// M1 验收：wss 指纹校验（方案 §4.3）
//  - 错误指纹：必须断开，且**不能**发出任何帧（比对通过前不发 hello）
//  - 正确指纹：能握手成功
import { MachineConnection } from '../src/protocol/session/MachineManager.js'
import { PairingStore } from '../src/protocol/session/PairingStore.js'
import type { MachineConnectionHost } from '../src/protocol/session/MachineManager.js'
import { WsTransport } from '../src/protocol/transport/WsTransport.js'

const HOST = process.env.FRIDAY_HOST ?? '192.168.20.239'
/** ssh 目标要带用户名（和客户端里存的 user@host 同形） */
const SSH_TARGET = process.env.FRIDAY_SSH ?? `root@${HOST}`
const PORT = Number(process.env.FRIDAY_WS_PORT ?? 7443)

function host(): MachineConnectionHost {
  return {
    appVersion: '0.1.0',
    pairings: new PairingStore({
      async load() {
        return null
      },
      async store() {},
      async delete() {}
    }),
    onStateChange() {},
    onEvent() {},
    ensureServer: async () => ({ action: 'none', message: '' })
  }
}

/** 用给定指纹连一次：返回是否握手成功、错误、以及期间调用过几次 send */
function tryConnect(fingerprint: string): Promise<{ ok: boolean; error: string; sendCalls: number }> {
  return new Promise((resolve) => {
    let sendCalls = 0
    let settled = false
    const transport = new WsTransport({
      onMessage: () => {},
      onOpen: () => finish({ ok: true, error: '' }),
      onClose: () => finish({ ok: false, error: '连接被关闭' }),
      onError: (error) => finish({ ok: false, error: error.message })
    })
    const originalSend = transport.send.bind(transport)
    transport.send = (text: string) => {
      sendCalls += 1
      originalSend(text)
    }
    const timer = setTimeout(() => finish({ ok: false, error: '超时' }), 8000)

    function finish(result: { ok: boolean; error: string }): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      transport.close()
      resolve({ ...result, sendCalls })
    }

    transport.start(`wss://${HOST}:${PORT}`, fingerprint)
  })
}

async function main(): Promise<void> {
  // 先从服务端拿它自己的指纹（server.websocket 回执里有）
  const ssh = new MachineConnection('fp-probe', 'fp probe', { kind: 'ssh', host: SSH_TARGET }, host())
  await ssh.connect()
  await new Promise((r) => setTimeout(r, 1500))
  const info = (await ssh.request('server.websocket', {})) as {
    fingerprint?: string
    enabled?: boolean
    secure?: boolean
    port?: number
  }
  console.log('服务端 WS:', JSON.stringify(info))
  const real = (info.fingerprint ?? '').toLowerCase()
  ssh.disconnect()
  if (!real) throw new Error('服务端没开 WS 入口，测不了指纹')

  // 1) 错误指纹：必须失败，且一帧都不发
  const bad = await tryConnect('00'.repeat(32))
  console.log('错误指纹 →', JSON.stringify(bad))
  if (bad.ok) throw new Error('错误指纹居然握手成功了（严重安全问题）')
  if (bad.sendCalls > 0) throw new Error(`错误指纹仍调用了 ${bad.sendCalls} 次 send（比对通过前不该发 hello）`)

  // 2) 正确指纹：应当握手成功
  const good = await tryConnect(real)
  console.log('正确指纹 →', JSON.stringify(good))
  if (!good.ok) throw new Error(`正确指纹连不上：${good.error}`)

  console.log('\n✓ 指纹校验符合预期：错误指纹被拒且未发帧，正确指纹可握手')
}

main().catch((error) => {
  console.error('✗ 失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
