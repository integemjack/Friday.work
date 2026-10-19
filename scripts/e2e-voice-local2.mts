// 完整验证：听写出了字幕吗（hearing 状态下 caption/pending 的内容）、说完 final 交助手、
// 助手回复的 voice.audio 推回来了吗。本机没麦克风 → 用正弦"假语音"，重点验证状态机和事件流。
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const target = parseTarget(link)
  const pairings = new PairingStore({
    async load() { return null },
    async store() {},
    async delete() {}
  })
  await pairings.save(target.url ?? '', { token: target.token, fingerprint: target.fingerprint })

  const machine = new MachineConnection('local-voice2', '本机', target, host())
  await machine.connect()
  await wait(4000)
  if (machine.state !== 'ready') throw new Error('没连上')
  console.log('连上', machine.serverInfo?.version)

  const start = (await machine.request('voice.start', {})) as { state?: string }
  console.log('voice.start:', start.state)

  // 喂两段"说话"（段间停顿），看听写的 caption → pending → final
  const rate = 16000
  const frame = 640
  const feedSeconds = async (seconds: number) => {
    const total = rate * seconds
    for (let i = 0; i < total; i += frame) {
      const samples = Math.min(frame, total - i)
      const pcm = Buffer.alloc(samples * 2)
      for (let j = 0; j < samples; j++) {
        const t = (i + j) / rate
        const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t)
        const v = Math.sin(2 * Math.PI * 300 * t) * 0.4 + Math.sin(2 * Math.PI * 900 * t) * 0.3
        pcm.writeInt16LE(Math.round(v * env * 22000), j * 2)
      }
      await machine.request('voice.feed', { pcm: pcm.toString('base64') }).catch(() => {})
      await wait(18)
    }
  }

  console.log('第 1 段"说话"2 秒…')
  await feedSeconds(2)
  console.log('停 1 秒…')
  await wait(1000)
  console.log('第 2 段 2 秒…')
  await feedSeconds(2)
  console.log('等听写出结果（8 秒）…')
  await wait(8000)

  const states = events.filter((e) => e.method === 'voice.state')
  const audios = events.filter((e) => e.method === 'voice.audio')
  console.log('\n=== 全部 state 变化 ===')
  for (const s of states) {
    const p = s.params as { state?: string; caption?: string; pending?: string }
    const extra = (p.caption ?? '') + (p.pending ?? '')
    console.log(`  ${p.state}${extra ? ` "${extra.slice(0, 60)}"` : ''}`)
  }
  console.log('voice.audio 帧:', audios.length)

  // 状态机覆盖检查
  const seenStates = new Set(states.map((s) => (s.params as { state?: string }).state))
  console.log('\n出现过的状态：', [...seenStates].join(' → '))

  await machine.request('voice.stop', {}).catch(() => {})
  machine.disconnect()

  const ok = ['listening', 'hearing'].every((s) => seenStates.has(s))
  console.log(ok ? '\n✓✓ 听写状态机完整（listening + hearing）' : '\n△ 状态机不全')
  if (!ok) process.exit(1)
}

main().catch((e) => {
  console.error('✗ 失败:', e.message)
  process.exit(1)
})
