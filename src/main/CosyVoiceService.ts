// 助手回复语音播报的第二套引擎：CosyVoice3 —— 把服务端（Friday 桌面版）本地语音 Power
// 的模型和加载方式原样搬过来：同一个 friday-voice 引擎、同一个 Fun-CosyVoice3-0.5B GGUF、
// 同一套 /v1/realtime/speak WebSocket 协议、同一批音色（voices/*.gguf 是参考录音的语音
// token + 说话人向量，不是编号）。
//
// 为什么值得多下一份模型（kokoro 的对比见 TtsService.ts 头注释）：
//   - 音质：kokoro 是 103 个固定说话人的单帧声码器，句子长了发平、带电子味；CosyVoice3 是
//     0.5B LLM 逐 token 生成，韵律像真人，且能带自然语言语气指令（「语气轻松一些。」）。
//   - 实测（本机 RTX 2060，同一句话 5 句连播，tmp-cv3-broadcast.mjs / tmp-cv3-voices.mjs）：
//       Vulkan 后端  default/lively-female RTF 0.52-0.74、首块 0.53-0.82s  → 边播边合成跟得上
//                   gentle-female RTF 1.04-1.08（临界）；男声 RTF 1.15-1.30（长句会断 0.3s）
//       CUDA  后端  RTF 1.42-1.56、首块 1.6-1.8s → 会断流，别用 CUDA
//     所以默认走 Vulkan target（也免掉 400MB 的 cuBLAS 运行库，包只有 16MB）。
//   - 打断：cancel 后 7ms 收到 cancelled（实测），比等整句合成完再停干净得多。
//
// 加载方式（和服务端 PowerManager 一致）：引擎包 + 模型按 sha256 校验后落到
// userData/voice-power/，spawn `friday-voice serve --port 0 --token <随机> --parent-stdin`，
// 从 stdout 读 {"event":"listening","url":...} 拿到本机地址，再连 WebSocket。
// 引擎闲置几分钟就停（下次懒启动，Vulkan 冷启动到可合成约 3-8s）。
//
// 体积：引擎 16MB + CosyVoice3 Q8 900MB + SenseVoice 242MB + FSMN-VAD 2MB ≈ 1.16GB；
// 听写（RealtimeDictation.ts）再加分 whisper 定稿 574MB ≈ 1.74GB。
// （serve 必须带 SenseVoice + VAD；--no-speaker 砍掉声纹 28MB——没接声纹功能）
// 所以不自动下载：设置里点「下载」才拉；没下载时选中该引擎会提示，播报回落到 kokoro。
// 听写和播报共用同一个 serve 进程：谁需要什么就下什么（要 TTS 下 CosyVoice3，要实时
// 听写下 Whisper turbo），已在跑的 serve 缺本次需要的能力时重启换参数。

import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import WebSocket from 'ws'

/** 引擎版本（Friday.Powers release tag voice-v0.4.1，和服务端装的同一份） */
const POWER_VERSION = '0.4.1'
/** GitHub release 附件；直连慢/不通时换公共镜像（同一批文件） */
const RELEASE_BASE = 'integemjack/Friday.Powers/releases/download'
const DOWNLOAD_HOSTS = ['https://github.com', 'https://ghproxy.net/https://github.com', 'https://ghfast.top/https://github.com']
const MODEL_BASE = 'https://modelscope.cn/models'

interface Asset {
  /** 相对 userData/voice-power 的落盘位置 */
  file: string
  /** 候选地址（按顺序试，第一个不通换下一个） */
  urls: string[]
  sha256: string
  /** 下载进度里显示的名字 */
  label: string
}

/** GitHub release 附件：直连慢/不通时换公共镜像（同一批文件） */
function releaseUrls(path: string): string[] {
  return DOWNLOAD_HOSTS.map((host) => `${host}/${path}`)
}

/** 各平台的引擎包：优先 Vulkan / Metal（免 CUDA 运行库、实测还更快） */
function engineTarget(): { asset: Asset; dir: string } | null {
  const { platform, arch } = process
  if (platform === 'win32' && arch === 'x64') {
    return {
      dir: 'friday-voice',
      asset: {
        file: 'engine.zip',
        label: '语音引擎（Vulkan）',
        urls: releaseUrls(`${RELEASE_BASE}/voice-v${POWER_VERSION}/voice-${POWER_VERSION}-windows-x64-vulkan.zip`),
        sha256: '69281bc9e8a17c7aa0ad7e77fe4f399ab7ed8736ae6a435aff410dd652859c70'
      }
    }
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      dir: 'friday-voice',
      asset: {
        file: 'engine.tar.gz',
        label: '语音引擎（Metal）',
        urls: releaseUrls(`${RELEASE_BASE}/voice-v${POWER_VERSION}/voice-${POWER_VERSION}-macos-arm64-metal.tar.gz`),
        sha256: '122c3d8f9bfa54b27e153b1408b65c75fda625ea9ada92cecc52dbcc351244f9'
      }
    }
  }
  if (platform === 'linux' && arch === 'x64') {
    return {
      dir: 'friday-voice',
      asset: {
        file: 'engine.tar.gz',
        label: '语音引擎（Vulkan）',
        urls: releaseUrls(`${RELEASE_BASE}/voice-v${POWER_VERSION}/voice-${POWER_VERSION}-linux-x64-vulkan.tar.gz`),
        sha256: 'd92062af22d6a37985732ee4e35c098e3b24d6584b44616a1415bb09d037c3ff'
      }
    }
  }
  return null
}

/** serve 必需的模型（SenseVoice + VAD 是 serve 的硬要求，砍不掉）；whisper 是听写定稿用 */
const DICTATION_MODEL_ASSETS: Asset[] = [
  {
    file: join('models', 'sensevoice-small-q8.gguf'),
    label: 'SenseVoice（serve 必需）',
    urls: [`${MODEL_BASE}/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/master/sensevoice-small-q8.gguf`],
    sha256: '4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5'
  },
  {
    file: join('models', 'fsmn-vad.gguf'),
    label: 'FSMN-VAD（serve 必需）',
    urls: [`${MODEL_BASE}/FunAudioLLM/fsmn-vad-GGUF/resolve/master/fsmn-vad.gguf`],
    sha256: '1270f2559c495f4e7b6e739541151027d360761a3fda43fc147034f5719f5479'
  },
  {
    // 听写每句定稿（中英混说时认英文词）；与 Friday.Powers power.json 同一份
    file: join('models', 'whisper', 'ggml-large-v3-turbo-q5_0.bin'),
    label: 'Whisper large-v3-turbo（听写定稿）',
    urls: [
      'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin'
    ],
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
  }
]

/** 播报需要的模型（听写路径不强制，下了就和听写共用同一个 serve） */
const TTS_MODEL_ASSETS: Asset[] = [
  {
    file: join('models', 'cosyvoice3', 'CosyVoice3-2512_Q8_0.gguf'),
    label: 'CosyVoice3 合成模型',
    urls: [`${MODEL_BASE}/Lourdle/Fun-CosyVoice3-0.5B-2512-GGUF/resolve/master/CosyVoice3-2512_Q8_0.gguf`],
    sha256: 'be133cb6154ca73cd1d213b1c9496def99ba9c1f7c14cd99f6b350af2eb7963d'
  }
]

const SAMPLE_RATE = 24000
/** 闲置多久停掉引擎进程（下次播报懒启动） */
const IDLE_STOP_MS = 4 * 60 * 1000
/** 一句最多等多久（长句 + 首次冷启动的兜底） */
const SPEAK_TIMEOUT_MS = 120_000

function rootDir(): string {
  return join(app.getPath('userData'), 'voice-power')
}
function engineDir(): string {
  return join(rootDir(), engineTarget()?.dir ?? 'friday-voice')
}
function modelsDir(): string {
  return join(rootDir(), 'models')
}
function executablePath(): string {
  return join(engineDir(), process.platform === 'win32' ? 'friday-voice.exe' : 'friday-voice')
}

type ProgressChannel = 'voice:tts-progress' | 'voice:model-progress'

function pushProgress(
  to: WebContents,
  phase: 'downloading' | 'extracting' | 'loading' | 'ready' | 'error',
  percent?: number,
  detail?: string,
  channel: ProgressChannel = 'voice:tts-progress'
): void {
  try {
    to.send(channel, { phase, percent, detail })
  } catch {
    // 窗口已关：忽略
  }
}

/** 落盘并校验 sha256（.part 写完再改名，中断不会留下半份文件冒充已装好） */
async function downloadAsset(to: WebContents, asset: Asset, channel: ProgressChannel = 'voice:tts-progress'): Promise<void> {
  const dest = join(rootDir(), asset.file)
  if (existsSync(dest)) return
  await mkdir(join(dest, '..'), { recursive: true })
  const part = `${dest}.part`
  let firstError: unknown = null
  for (const url of asset.urls) {
    try {
      pushProgress(to, 'downloading', 0, asset.label, channel)
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length') ?? 0)
      const hash = createHash('sha256')
      let received = 0
      let lastPush = 0
      const stream = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream)
      stream.on('data', (chunk: Uint8Array) => {
        hash.update(chunk)
        received += chunk.length
        const now = Date.now()
        if (now - lastPush > 400) {
          lastPush = now
          pushProgress(to, 'downloading', total ? Math.round((received / total) * 100) : undefined, asset.label, channel)
        }
      })
      await pipeline(stream, createWriteStream(part))
      const digest = hash.digest('hex')
      if (digest !== asset.sha256) throw new Error(`校验不过（sha256 ${digest.slice(0, 12)}…）`)
      await rename(part, dest)
      return
    } catch (error) {
      firstError ??= error
      await rm(part, { force: true })
    }
  }
  throw new Error(`${asset.label} 下载失败：${String((firstError as Error)?.message ?? firstError)}`)
}

/** 系统 tar 解压（Windows 10+ 的 bsdtar 认 zip 也认 tar.gz，macOS/Linux 用 tar） */
function extract(archive: string, intoDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', intoDir], { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar 退出码 ${code}${stderr ? `：${stderr.slice(0, 300)}` : ''}`))
    })
  })
}

/** 引擎可执行文件在不在（只查文件，不启动） */
function engineInstalled(): boolean {
  return existsSync(executablePath()) && existsSync(join(modelsDir(), 'cosyvoice3', 'CosyVoice3-2512_Q8_0.gguf'))
}

/** 已装引擎包里的音色名（voices/*.gguf，去掉后缀） */
async function installedVoices(): Promise<string[]> {
  try {
    const names = await readdir(join(engineDir(), 'voices'))
    return names.filter((n) => n.endsWith('.gguf')).map((n) => n.slice(0, -5)).sort()
  } catch {
    return []
  }
}

interface ServeNeed {
  /** 播报：要 CosyVoice3 模型 + serve 带 --tts-model */
  forTts?: boolean
  /** 实时听写：要 Whisper 定稿模型 + serve 带 --whisper-model */
  forDictation?: boolean
  /** 进度推到哪条事件（听写 UI 听 model-progress，播报 UI 听 tts-progress） */
  progress?: ProgressChannel
}

async function ensureFiles(to: WebContents, need: ServeNeed = {}): Promise<void> {
  const target = engineTarget()
  if (!target) throw new Error(`本机平台（${process.platform}-${process.arch}）没有对应的语音引擎包`)
  const channel = need.progress ?? 'voice:tts-progress'
  if (!existsSync(executablePath())) {
    await downloadAsset(to, target.asset, channel)
    pushProgress(to, 'extracting', undefined, target.asset.label, channel)
    const archive = join(rootDir(), target.asset.file)
    try {
      await extract(archive, rootDir())
    } catch (error) {
      await rm(archive, { force: true })
      await rm(engineDir(), { recursive: true, force: true })
      throw new Error(`语音引擎解压失败：${String((error as Error)?.message ?? error)}`)
    }
    await rm(archive, { force: true })
    if (!existsSync(executablePath())) throw new Error('语音引擎包内容不完整（缺 friday-voice）')
  }
  // serve 硬要求的两个先下；按需再下 whisper（听写）/ cosyvoice3（播报）
  const wanted = [...DICTATION_MODEL_ASSETS.slice(0, 2), ...(need.forTts ? TTS_MODEL_ASSETS : []), ...(need.forDictation ? [DICTATION_MODEL_ASSETS[2]] : [])]
  for (const asset of wanted) {
    await downloadAsset(to, asset, channel)
  }
}

// MARK: serve 进程

interface Running {
  child: import('node:child_process').ChildProcessWithoutNullStreams
  wsUrl: string
  token: string
  /** 本次启动加载了哪些能力（复用检查用：在跑但缺能力的要重启） */
  caps: { tts: boolean; whisper: boolean }
}

let running: Running | null = null
let starting: Promise<Running> | null = null
let idleTimer: NodeJS.Timeout | null = null

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => void stopServe(), IDLE_STOP_MS)
}

function stopServe(): Promise<void> {
  const current = running
  running = null
  starting = null
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (!current) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => resolve()
    current.child.once('close', done)
    current.child.once('error', done)
    current.child.stdin.end() // --parent-stdin：父端管道关掉，引擎自己退
    setTimeout(() => {
      if (!current.child.killed) current.child.kill()
      resolve()
    }, 4000)
  })
}

/** 起（或复用）本机引擎服务：spawn serve，等 stdout 的 listening 事件 */
async function ensureServe(to: WebContents, need: ServeNeed = {}): Promise<Running> {
  const channel = need.progress ?? 'voice:tts-progress'
  // 在跑的实例能力够就直接用（比如听写和播报共用）
  if (running) {
    const ok = (!need.forTts || running.caps.tts) && (!need.forDictation || running.caps.whisper)
    if (ok) {
      touchIdle()
      return running
    }
    await stopServe() // 缺本次需要的能力（模型是后来下的）：重启换参数
  }
  if (starting) return starting
  const task = (async () => {
    await ensureFiles(to, need)
    // 到这里模型都已落盘：按实际存在与否组 serve 参数（TTS 可选、Whisper 可选）
    const hasTts = existsSync(join(modelsDir(), 'cosyvoice3', 'CosyVoice3-2512_Q8_0.gguf'))
    const hasWhisper = existsSync(join(modelsDir(), 'whisper', 'ggml-large-v3-turbo-q5_0.bin'))
    if (need.forTts && !hasTts) throw new Error('CosyVoice3 模型缺失')
    if (need.forDictation && !hasWhisper) throw new Error('Whisper 定稿模型缺失')
    pushProgress(to, 'loading', undefined, '启动本地语音引擎', channel)
    const token = randomBytes(16).toString('hex')
    const args = [
      'serve',
      '--models',
      modelsDir(),
      // serve 的听写模型是硬要求（SenseVoice + VAD）；TTS / Whisper 定稿按下载情况带上；
      // 声纹（campplus 28MB）还没接功能，永远砍掉
      ...(hasTts
        ? ['--tts-model', join(modelsDir(), 'cosyvoice3', 'CosyVoice3-2512_Q8_0.gguf'), '--voices', join(engineDir(), 'voices')]
        : ['--no-tts']),
      ...(hasWhisper ? ['--whisper-model', join(modelsDir(), 'whisper', 'ggml-large-v3-turbo-q5_0.bin')] : ['--no-whisper']),
      '--no-speaker',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--token',
      token,
      '--parent-stdin'
    ]
    const child = spawn(executablePath(), args, { cwd: rootDir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const next: Running = { child, wsUrl: '', token, caps: { tts: hasTts, whisper: hasWhisper } }
    let stdoutBuf = ''
    let settled = false
    const info = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!settled) reject(new Error('语音引擎启动超时（没等到 listening）'))
      }, 180_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutBuf += chunk
        for (;;) {
          const at = stdoutBuf.indexOf('\n')
          if (at < 0) break
          const line = stdoutBuf.slice(0, at).trim()
          stdoutBuf = stdoutBuf.slice(at + 1)
          if (!line.startsWith('{')) continue
          try {
            const event = JSON.parse(line) as { event?: string; url?: string; version?: string }
            if (event.event === 'listening' && event.url) {
              settled = true
              clearTimeout(timer)
              resolve(event.url)
            }
          } catch {
            // 半行 JSON：等下一块
          }
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        // --verbose 没开，这里主要是 ggml 的设备探测和错误
        const text = chunk.toString('utf8')
        if (/error|失败|不支持|cannot/.test(text)) console.warn('[cosyvoice3]', text.trim().slice(0, 300))
      })
      child.once('error', (error) => {
        settled = true
        clearTimeout(timer)
        reject(new Error(`语音引擎启动失败：${error.message}`))
      })
      child.once('close', (code) => {
        if (!settled) {
          clearTimeout(timer)
          reject(new Error(`语音引擎启动后立刻退出（码 ${code}）——常见原因：显卡不支持 Vulkan / 驱动没有 Vulkan 运行库`))
        }
      })
    })
    next.wsUrl = info.replace(/^http:/, 'ws:')
    running = next
    touchIdle()
    pushProgress(to, 'ready', undefined, undefined, channel)
    return next
  })()
  starting = task
  // 启动失败要把占位的 Promise 清掉，下次触发才能重试；成功路径下 running 已置好，
  // 这里也不能再指回旧 task（stopServe 后拿到已死的地址会直接并报错）
  task.catch(() => {})
  void task.finally(() => {
    if (starting === task) starting = null
  })
  return task
}

// MARK: 合成

/** 当前这句的打断句柄（cancel 用） */
let activeCancel: (() => void) | null = null

/** 一次合成（start → text → flush → 收 PCM → done）。samples 与 kokoro 路径同格式，渲染层播放不用改。 */
async function speakOnce(
  server: Running,
  options: { text: string; voice?: string; speed?: number; instruction?: string }
): Promise<{ samples: Float32Array; sampleRate: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${server.wsUrl}/v1/realtime/speak?token=${server.token}`)
    const pieces: Buffer[] = []
    let settled = false
    let cancelRequested = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        // 已关
      }
      if (error) reject(error)
      else {
        const pcm = Buffer.concat(pieces)
        const samples = new Float32Array(pcm.length / 2)
        for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768
        resolve({ samples, sampleRate: SAMPLE_RATE })
      }
    }
    const timer = setTimeout(() => {
      cancelRequested = true
      try {
        ws.send(JSON.stringify({ type: 'cancel' }))
      } catch {
        // 连接已断
      }
      finish(new Error('语音引擎合成超时'))
    }, SPEAK_TIMEOUT_MS)
    activeCancel = () => {
      cancelRequested = true
      try {
        ws.send(JSON.stringify({ type: 'cancel' }))
      } catch {
        // 连接已断
      }
      clearTimeout(timer)
      finish(new Error('cancelled'))
    }
    ws.on('message', (data: Buffer | ArrayBuffer, isBinary: boolean) => {
      if (isBinary) {
        pieces.push(Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data as ArrayBuffer)))
        return
      }
      let message: { type?: string; message?: string }
      try {
        message = JSON.parse(String(data))
      } catch {
        return
      }
      if (message.type === 'ready') {
        ws.send(
          JSON.stringify({
            type: 'start',
            speed: options.speed ?? 1.0,
            sample_rate: SAMPLE_RATE,
            ...(options.voice ? { voice: options.voice } : {}),
            ...(options.instruction ? { instruction: options.instruction } : {})
          })
        )
        ws.send(JSON.stringify({ type: 'text', text: options.text }))
        ws.send(JSON.stringify({ type: 'flush' }))
      } else if (message.type === 'done') {
        clearTimeout(timer)
        activeCancel = null
        finish()
      } else if (message.type === 'cancelled') {
        clearTimeout(timer)
        activeCancel = null
        finish(cancelRequested ? new Error('cancelled') : undefined)
      } else if (message.type === 'error') {
        clearTimeout(timer)
        activeCancel = null
        finish(new Error(`语音引擎：${message.message ?? '合成失败'}`))
      }
    })
    ws.on('error', () => {
      clearTimeout(timer)
      finish(new Error('和语音引擎的连接断了'))
    })
    ws.on('close', () => {
      clearTimeout(timer)
      finish(new Error('语音引擎连接已关闭'))
    })
  })
}

/** 串行队列：引擎一次只跑一句（GPU 上并发只会互相拖慢） */
let queueTail: Promise<unknown> = Promise.resolve()

export function synthesizeCosyVoice(
  to: WebContents,
  text: string,
  options: { voice?: string; speed?: number; instruction?: string }
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const run = async (): Promise<{ samples: Float32Array; sampleRate: number }> => {
    const server = await ensureServe(to)
    return speakOnce(server, { text, ...options })
  }
  const next = queueTail.then(run, run)
  queueTail = next.catch(() => {})
  return next
}

/** 打断当前这句（后续队列由渲染层清空） */
export function cancelCosyVoice(): void {
  const cancel = activeCancel
  activeCancel = null
  if (cancel) cancel()
}

export function prefetchCosyVoice(to: WebContents): Promise<void> {
  return ensureServe(to, { forTts: true }).then(
    () => {},
    (error: unknown) => pushProgress(to, 'error', undefined, (error as Error).message)
  )
}

export function registerCosyVoiceIpc(): void {
  ipcMain.handle('voice:cv3-status', async () => ({
    supported: engineTarget() !== null,
    installed: engineInstalled(),
    serving: running !== null,
    voices: await installedVoices(),
    version: POWER_VERSION
  }))
  ipcMain.handle('voice:cv3-prefetch', (event: IpcMainInvokeEvent): void => {
    void prefetchCosyVoice(event.sender)
  })
  ipcMain.handle('voice:cv3-cancel', (): void => {
    cancelCosyVoice()
  })
  app.on('before-quit', () => {
    void stopServe()
  })
}

// MARK: 给实时听写（RealtimeDictation.ts）用的门面：同一个 serve 进程、同一套闲置策略

export { ensureServe as ensureVoiceServe, stopServe as stopVoiceServe, touchIdle as touchVoiceServe, type ServeNeed }

/** 听写就绪状态（设置页/菜单用）：引擎包 + SenseVoice + VAD + Whisper 定稿都在，
 *  不要求 CosyVoice3——只想要听写的用户不必下 900MB 合成模型 */
export async function dictationEngineState(): Promise<{
  supported: boolean
  ready: boolean
  serving: boolean
  whisperInstalled: boolean
}> {
  return {
    supported: engineTarget() !== null,
    ready:
      engineTarget() !== null &&
      existsSync(executablePath()) &&
      existsSync(join(modelsDir(), 'sensevoice-small-q8.gguf')) &&
      existsSync(join(modelsDir(), 'fsmn-vad.gguf')) &&
      existsSync(join(modelsDir(), 'whisper', 'ggml-large-v3-turbo-q5_0.bin')),
    serving: running !== null,
    whisperInstalled: existsSync(join(modelsDir(), 'whisper', 'ggml-large-v3-turbo-q5_0.bin'))
  }
}
