// 连本机 Friday（2.36.0 正式版，桌面端 DesktopService + WS 入口）验证 voice.*
// 用法：node .tmp/e2e-local.cjs <配对链接>
import { MachineConnection } from '../src/protocol/session/MachineManager.js'
import { PairingStore } from '../src/protocol/session/PairingStore.js'
import { parseTarget } from '../src/protocol/session/TargetParse.js'

const link = process.argv[2] ?? ''
const events: Array<{ method: string; params: unknown }> = []

function host() {
  return {
    appVersion: '0.1.0',
    pairings: new PairingStore({
      async load() { return null },
      async store() {},
      async delete() {}
    }),
    onStateChange: () => {},
    onEvent: (_c: unknown, method: string, params: unknown) => {
      events.push({ method, params })
    },
    onBridgeError: () => {},
    ensureServer: async () => ({ action: 'none', message: '' })
  } as never
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  if (!link.startsWith('friday://pair?')) throw new Error('要传配对链接')
  const target = parseTarget(link)
  if (!target?.token) throw new Error('链接里没有令牌')

  const pairings = new PairingStore({
    async load() { return null },
    async store() {},
    async delete() {}
  })
  await pairings.save(target.url ?? '', {
    token: target.token,
    fingerprint: target.fingerprint
  })

  const machine = new MachineConnection('local-voice-test', '本机', target, host())
  await machine.connect()
  await wait(4000)
  console.log('state:', machine.state, machine.detail ?? '')
  if (machine.state !== 'ready') throw new Error('没连上')
  console.log('version:', machine.serverInfo?.version, 'features 含 voice:', machine.serverInfo?.features?.includes('voice'))

  // voice.start
  const start = (await machine.request('voice.start', { inputSampleRate: 16000, outputSampleRate: 16000 })) as {
    state?: string
    error?: string
    available?: boolean
  }
  console.log('voice.start:', JSON.stringify(start))
  if (start.state === 'off') {
    console.log('（本机 Friday 的实时语音没起来：', start.error, '）')
    machine.disconnect()
    return
  }

  // 本机有麦克风吗？没有就只验证协议层（starting 状态 + feed 不报错 + stop 干净）
  const media = await navigator2()
  console.log('本机麦克风：', media ? '有（但脚本里没法授权 getUserMedia，用生成音频喂）' : '没有')

  // 生成 3 秒 440Hz 正弦（模拟说话的波形），按实时节奏喂
  const rate = 16000
  const seconds = 3
  const total = rate * seconds
  const frame = 640 // 20ms
  for (let i = 0; i < total; i += frame) {
    const samples = Math.min(frame, total - i)
    const pcm = Buffer.alloc(samples * 2)
    for (let j = 0; j < samples; j++) {
      const t = (i + j) / rate
      // 包络调制的多频正弦（像人声）
      const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 2.5 * t)
      const v = Math.sin(2 * Math.PI * 220 * t) * 0.5 + Math.sin(2 * Math.PI * 660 * t) * 0.3
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * env * 20000))), j * 2)
    }
    await machine.request('voice.feed', { pcm: pcm.toString('base64') }).catch(() => {})
    await wait(18)
  }
  console.log('喂完 3 秒音频，等 12 秒收事件…')
  await wait(12000)

  const states = events.filter((e) => e.method === 'voice.state')
  const audios = events.filter((e) => e.method === 'voice.audio')
  console.log('\n=== 事件统计 ===')
  console.log('voice.state:', states.length, ' voice.audio:', audios.length)
  for (const s of states.slice(-6)) {
    const p = s.params as { state?: string; caption?: string; pending?: string }
    console.log(`  state=${p.state} caption="${(p.caption ?? '').slice(0, 50)}" pending="${(p.pending ?? '').slice(0, 50)}"`)
  }

  await machine.request('voice.stop', {}).catch(() => {})
  machine.disconnect()

  if (states.length > 2) {
    console.log('\n✓ voice.* 在本机 Friday 2.36.0 上端到端工作')
  } else {
    console.log('\n△ 事件太少')
    process.exit(1)
  }
}

/** 本机有没有输入设备（Node 里没有 navigator；用 PowerShell 查） */
function navigator2(): Promise<boolean> {
  return new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn('powershell', ['-NoProfile', '-Command', 'Get-PnpDevice -Class AudioEndpoint -Status OK | Select-Object -First 3 FriendlyName | Format-Table | Out-String'])
      let out = ''
      child.stdout?.on('data', (d: Buffer) => (out += d))
      child.on('close', () => resolve(/microphone|麦克风|mic/i.test(out)))
      child.on('error', () => resolve(false))
    })
  })
}

main().catch((e) => {
  console.error('✗ 失败:', e.message)
  process.exit(1)
})
