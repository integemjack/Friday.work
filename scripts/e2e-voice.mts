// M3-A 语音链路真机验证：造一段 wav → file.upload → assistant.say(source=voice) → 看 assistant.entry 回复。
// 跑法：esbuild 打包后 node 运行

import { MachineConnection } from '../src/protocol/session/MachineManager.js'
import { PairingStore } from '../src/protocol/session/PairingStore.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Uploads } from '../src/protocol/media/Uploads.js'

/** 生成一段 1 秒 16kHz 单声道 wav（440Hz 正弦） */
function makeWav(path: string): void {
  const sampleRate = 16000
  const seconds = 1
  const samples = sampleRate * seconds
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000)
    buffer.writeInt16LE(value, 44 + i * 2)
  }
  writeFileSync(path, buffer)
}

async function main(): Promise<void> {
  const pairings = new PairingStore({
    async read() {
      return null
    },
    async write() {},
    async delete() {}
  })
  const machine = new MachineConnection(
    'e2e-voice',
    'ubuntu 测试机',
    { kind: 'ssh', host: 'root@192.168.20.239' },
    {
      pairings,
      onEvent: () => {},
      onStateChange: () => {},
      onBridgeError: () => {}
    }
  )

  let assistantResolve: ((value: unknown) => void) | null = null
  const events: Array<{ method: string; params: unknown }> = []
  ;(machine as unknown as { host: { onEvent: (c: unknown, m: string, p: unknown) => void } }).host.onEvent = (
    _connection: unknown,
    method: string,
    params: unknown
  ) => {
    events.push({ method, params })
    if (method === 'assistant.entry' && assistantResolve) {
      const entry = (params as { entry?: { kind?: string; text?: string; streaming?: boolean } }).entry
      if (entry?.kind === 'assistant' && !entry.streaming) assistantResolve(entry)
    }
  }

  await machine.connect()
  await new Promise((r) => setTimeout(r, 1500))
  if (machine.state !== 'ready') throw new Error(`没连上：${machine.state} ${machine.detail ?? ''}`)
  console.log('✓ 连上', machine.serverInfo?.version)

  const features = machine.serverInfo?.features ?? []
  console.log('features 有 assistant：', features.includes('assistant'))

  // 订阅助手
  const subscribed = (await machine.request('assistant.subscribe', { count: 10 })) as {
    state?: { enabled?: boolean; brainEngineTitle?: string }
    entries?: Array<{ kind?: string; text?: string }>
  }
  console.log(
    '✓ assistant.subscribe；enabled=',
    subscribed.state?.enabled,
    'brain=',
    subscribed.state?.brainEngineTitle,
    '历史条数=',
    subscribed.entries?.length ?? 0
  )

  // 助手关着时只记日志不回复；为了验证完整语音链路，先打开（可用 assistant.settings.update 改回）
  if (!subscribed.state?.enabled) {
    try {
      await machine.request('assistant.settings.update', { enabled: true })
      console.log('✓ 已打开这台机器的助手（原为关闭）')
    } catch (error) {
      console.log('！打开助手失败：', error instanceof Error ? error.message : error)
    }
  }

  // 造一段声音，上传
  const dir = join(tmpdir(), 'friday-voice-test')
  mkdirSync(dir, { recursive: true })
  const localPath = join(dir, 'voice-test.wav')
  makeWav(localPath)
  // 句柄后端：直接把测试文件当成已背书的文件
  const uploads = new Uploads({
    async resolveHandle() {
      return localPath
    }
  })
  const remotePath = await uploads.sendFile(
    (method, params) => machine.request(method, params),
    'test-handle'
  ).then((result) => result.path)
  console.log('✓ 上传到远端：', remotePath)

  // 作为语音消息发出
  const said = await machine.request('assistant.say', {
    text: '',
    source: 'voice',
    attachments: [remotePath]
  })
  console.log('✓ assistant.say 回执：', JSON.stringify(said).slice(0, 200))

  // 等助手回复（30 秒）
  const reply = await Promise.race([
    new Promise((resolve) => {
      assistantResolve = resolve
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), 30_000))
  ])
  console.log('助手回复：', reply ? JSON.stringify(reply).slice(0, 400) : '（30 秒内没有新回复）')

  const assistantEntries = events.filter((event) => event.method === 'assistant.entry')
  console.log('收到 assistant.entry 条数：', assistantEntries.length)
  for (const event of assistantEntries.slice(-5)) {
    const entry = (event.params as { entry?: { kind?: string; text?: string; data?: unknown } }).entry
    console.log(' -', entry?.kind, JSON.stringify(entry?.text ?? '').slice(0, 120), JSON.stringify(entry?.data ?? {}).slice(0, 200))
  }
  console.log('其它事件：', [...new Set(events.map((event) => event.method))].join(', '))

  machine.disconnect()
}

main().catch((error) => {
  console.error('✗ 失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
