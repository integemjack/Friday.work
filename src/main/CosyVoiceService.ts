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

import { app, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, open as openFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import WebSocket from 'ws'
import iconv from 'iconv-lite'

/** 引擎版本（本仓库 release tag voice-v0.5.0：CI 从 vendor/friday-voice 编出来的，含音色克隆） */
const POWER_VERSION = '0.5.0'
/** 引擎 zip 从本仓库（Friday.work）的 voice tag Release 拉；挂了换公共镜像（同一批文件） */
const RELEASE_BASE = 'integemjack/Friday.work/releases/download'
const DOWNLOAD_HOSTS = ['https://github.com', 'https://ghproxy.net/https://github.com', 'https://ghfast.top/https://github.com']
const MODEL_BASE = 'https://modelscope.cn/models'

interface Asset {
  /** 相对 userData/voice-power 的落盘位置 */
  file: string
  /** 候选地址（按顺序试，第一个不通换下一个） */
  urls: string[]
  /** 固定内容的模型写死校验值；引擎 zip 是 CI 现打的（哈希随构建变），不写——从同
   *  Release 的 sidecar（voice-*.json，打包时生成）拉真实 sha256 再校验 */
  sha256?: string
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
        urls: releaseUrls(`${RELEASE_BASE}/voice-v${POWER_VERSION}/voice-${POWER_VERSION}-windows-x64-vulkan.zip`)
      }
    }
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      dir: 'friday-voice',
      asset: {
        file: 'engine.tar.gz',
        label: '语音引擎（Metal）',
        urls: releaseUrls(`${RELEASE_BASE}/voice-v${POWER_VERSION}/voice-${POWER_VERSION}-macos-arm64-metal.tar.gz`)
      }
    }
  }
  if (platform === 'linux' && arch === 'x64') {
    return {
      dir: 'friday-voice',
      asset: {
        file: 'engine.tar.gz',
        label: '语音引擎（Vulkan）',
        urls: releaseUrls(`${RELEASE_BASE}/voice-v${POWER_VERSION}/voice-${POWER_VERSION}-linux-x64-vulkan.tar.gz`)
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

/** 音色克隆需要的前端模型（speech tokenizer 认语音 token、campplus 认说话人向量；第一次克隆才下载） */
const CLONE_MODEL_ASSETS: Asset[] = [
  {
    file: join('models', 'frontend-onnx', 'speech_tokenizer_v3.int8.onnx'),
    label: '语音分词器（克隆用）',
    urls: [`${MODEL_BASE}/Lourdle/Fun-CosyVoice3-0.5B-2512-GGUF/resolve/master/frontend-onnx/speech_tokenizer_v3.int8.onnx`],
    sha256: 'd7caa04fbc2f54af196906469471b607ce2594b7e92ac07dddfb315103a74c72'
  },
  {
    file: join('models', 'frontend-onnx', 'campplus.onnx'),
    label: '说话人向量（克隆用）',
    urls: [`${MODEL_BASE}/Lourdle/Fun-CosyVoice3-0.5B-2512-GGUF/resolve/master/frontend-onnx/campplus.onnx`],
    sha256: 'a6ac6a63997761ae2997373e2ee1c47040854b4b759ea41ec48e4e42df0f4d73'
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
/** 引擎目录带版本（v0.5 起升级 = 下新目录，不再原地覆盖）；zip 解出来是固定名，落地后改名 */
function engineDir(): string {
  return join(rootDir(), `friday-voice-${POWER_VERSION}`)
}
/** 0.4.x 时代的旧目录（无版本后缀）：新版没就绪时的回落，升级成功后顺手清掉 */
function legacyEngineDir(): string {
  return join(rootDir(), 'friday-voice')
}
function modelsDir(): string {
  return join(rootDir(), 'models')
}
function exeIn(dir: string): string {
  return join(dir, process.platform === 'win32' ? 'friday-voice.exe' : 'friday-voice')
}
function executablePath(): string {
  return exeIn(engineDir())
}
function legacyExecutablePath(): string {
  return exeIn(legacyEngineDir())
}

/** 路径 → 引擎版本（spawn --version 一次，缓存）；失败/解析不出给 ''。
 *  v0.5 客户端会传旧引擎不认识的参数（--no-clone 等）：旧引擎要么升级要么降参，不探版本会直接退出码 2 */
const engineVersions = new Map<string, string>()
function detectEngineVersion(path: string): string {
  const cached = engineVersions.get(path)
  if (cached !== undefined) return cached
  let version = ''
  try {
    const out = spawnSync(path, ['--version'], { timeout: 5000, windowsHide: true, encoding: 'utf8' })
    const match = /friday-voice\s+([0-9]+\.[0-9]+\.[0-9]+)/.exec(`${out.stdout ?? ''}\n${out.stderr ?? ''}`)
    if (match) version = match[1] ?? ''
  } catch {
    // 起不来（缺 DLL 等）：当未知版本处理
  }
  engineVersions.set(path, version)
  return version
}

/** a >= b（点分数字比较；空串视为最小） */
function versionAtLeast(a: string, b: string): boolean {
  if (!a) return false
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return true
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
      // 没写死 sha 的（引擎 zip）：从同 Release 的 sidecar json（打包时生成）取真实值，
      // 顺带校验版本号——防止镜像缓存了旧版本的包
      let expected = asset.sha256
      if (!expected) {
        // 刚发布的资产在 GitHub CDN 上可能短暂 404（实测传播要几分钟）：重试 3 次。
        // sidecar 命名是压缩包去掉扩展名再加 .json（…-vulkan.zip → …-vulkan.json，CI 打包
        // 脚本同款）——不是简单往后拼 .json（那样拼出来 …vulkan.zip.json，Release 上没有，
        // 引擎升级永远拉不到校验清单、只能停在旧引擎）
        let info: { sha256?: string; version?: string } | null = null
        let lastCode = 0
        for (let attempt = 0; attempt < 3 && !info; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 3000))
          const sidecar = await fetch(url.replace(/\.(zip|tar\.gz)$/i, '.json'), {
            redirect: 'follow',
            signal: AbortSignal.timeout(30_000)
          })
          if (sidecar.ok) info = (await sidecar.json()) as { sha256?: string; version?: string }
          else lastCode = sidecar.status
        }
        if (!info) throw new Error(`校验清单拉取失败（HTTP ${lastCode}）`)
        if (info.version && info.version !== POWER_VERSION) throw new Error(`引擎包版本不符（Release 里是 ${info.version}）`)
        expected = info.sha256
        if (!expected) throw new Error('校验清单里没有 sha256')
      }
      // 连接停摆（服务器收下请求不回数据）时这个下载会永久挂起，starting 永不落定、
      // 语音功能从此卡死到重启：挂一个「60 秒没新数据就捨断」的看门狗
      const abort = new AbortController()
      let watchdog: NodeJS.Timeout | null = null
      const kick = (): void => {
        if (watchdog) watchdog.refresh()
        else {
          watchdog = setTimeout(() => abort.abort(new Error('下载停摆（60 秒没有新数据）')), 60_000)
          watchdog.unref?.()
        }
      }
      try {
        const res = await fetch(url, { redirect: 'follow', signal: abort.signal })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        const total = Number(res.headers.get('content-length') ?? 0)
        const hash = createHash('sha256')
        let received = 0
        let lastPush = 0
        const stream = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream)
        stream.on('data', (chunk: Uint8Array) => {
          kick()
          hash.update(chunk)
          received += chunk.length
          const now = Date.now()
          if (now - lastPush > 400) {
            lastPush = now
            pushProgress(to, 'downloading', total ? Math.round((received / total) * 100) : undefined, asset.label, channel)
          }
        })
        await pipeline(stream, createWriteStream(part), { signal: abort.signal })
        const digest = hash.digest('hex')
        if (digest !== expected) throw new Error(`校验不过（sha256 ${digest.slice(0, 12)}…）`)
      } finally {
        if (watchdog) clearTimeout(watchdog)
      }
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

/** 在用的引擎目录（本版本优先，回落旧版 0.4.x）；两个都没有 = '' */
function activeEngineDir(): string {
  return existsSync(executablePath()) ? engineDir() : existsSync(legacyExecutablePath()) ? legacyEngineDir() : ''
}

/** 引擎可执行文件在不在（只查文件，不启动；含旧版回落） */
function engineInstalled(): boolean {
  return (
    (existsSync(executablePath()) || existsSync(legacyExecutablePath())) &&
    existsSync(join(modelsDir(), 'cosyvoice3', 'CosyVoice3-2512_Q8_0.gguf'))
  )
}

/** 已装引擎包里的音色名（voices/*.gguf，去掉后缀） */
async function installedVoices(): Promise<string[]> {
  const dir = activeEngineDir()
  if (!dir) return []
  try {
    const names = await readdir(join(dir, 'voices'))
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
  /** 音色克隆：要前端两个 ONNX + CosyVoice3（引擎的 clone 端点要合成模型在）；forClone ⇒ forTts */
  forClone?: boolean
  /** 进度推到哪条事件（听写 UI 听 model-progress，播报 UI 听 tts-progress） */
  progress?: ProgressChannel
}

async function ensureFiles(to: WebContents, need: ServeNeed = {}): Promise<void> {
  const target = engineTarget()
  if (!target) throw new Error(`本机平台（${process.platform}-${process.arch}）没有对应的语音引擎包`)
  const channel = need.progress ?? 'voice:tts-progress'
  if (!existsSync(executablePath())) {
    // 版本目录没有：下本版引擎。旧版（0.4.x 无版本目录）还在时，下载失败（发布资产未就绪等）
    // 不拖死语音——回落旧引擎继续听写/播报（只是克隆等新能力暂缺），下次再试升级。
    const hasLegacy = existsSync(legacyExecutablePath())
    try {
      await downloadAsset(to, target.asset, channel)
      pushProgress(to, 'extracting', undefined, target.asset.label, channel)
      const archive = join(rootDir(), target.asset.file)
      try {
        await extract(archive, rootDir())
      } catch (error) {
        await rm(archive, { force: true })
        await rm(join(rootDir(), target.dir), { recursive: true, force: true })
        throw new Error(`语音引擎解压失败：${String((error as Error)?.message ?? error)}`)
      }
      await rm(archive, { force: true })
      // zip/tar 解出来是固定名目录：改成本版本目录，升级不覆盖、可多版本共存
      await rm(engineDir(), { recursive: true, force: true })
      await rename(join(rootDir(), target.dir), engineDir())
      if (!existsSync(executablePath())) throw new Error('语音引擎包内容不完整（缺 friday-voice）')
      // 新版确认可用：旧版目录没用了，清掉（几十 MB，留着只会误导回落）
      if (hasLegacy) await rm(legacyEngineDir(), { recursive: true, force: true }).catch(() => {})
    } catch (error) {
      if (!hasLegacy) throw error
      console.warn('[voice] 新版引擎下载/安装失败，先用旧版引擎（克隆暂不可用）：', error)
    }
  }
  // serve 硬要求的两个先下；按需再下 whisper（听写）/ cosyvoice3（播报）/ 克隆前端
  const needTts = need.forTts || need.forClone
  const wanted = [
    ...DICTATION_MODEL_ASSETS.slice(0, 2),
    ...(needTts ? TTS_MODEL_ASSETS : []),
    ...(need.forDictation ? [DICTATION_MODEL_ASSETS[2]] : []),
    ...(need.forClone ? CLONE_MODEL_ASSETS : [])
  ]
  for (const asset of wanted) {
    await downloadAsset(to, asset, channel)
  }
  // 新版就绪后旧目录就没用了（首次清理失败＝当时旧引擎进程还在跑，Windows 锁着 exe）：再试一次，失败就算了
  if (existsSync(executablePath()) && existsSync(legacyExecutablePath())) {
    await rm(legacyEngineDir(), { recursive: true, force: true }).catch(() => {})
  }
}

// MARK: serve 进程

interface Running {
  child: import('node:child_process').ChildProcessWithoutNullStreams
  wsUrl: string
  token: string
  /** 本次启动加载了哪些能力（复用检查用：在跑但缺能力的要重启） */
  caps: { tts: boolean; whisper: boolean; clone: boolean }
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
    const ok =
      (!need.forTts || running.caps.tts) &&
      (!need.forDictation || running.caps.whisper) &&
      (!need.forClone || running.caps.clone)
    if (ok) {
      touchIdle()
      return running
    }
    await stopServe() // 缺本次需要的能力（模型是后来下的）：重启换参数
  }
  if (starting) {
    const current = await starting
    const ok =
      (!need.forTts || current.caps.tts) &&
      (!need.forDictation || current.caps.whisper) &&
      (!need.forClone || current.caps.clone)
    if (ok) return current
    // 在跑的这轮启动不满足本次要的能力（比如 TTS 先触发启动、期间听写请求进来，
    // 拿到无 whisper 的 serve 听写必失败，要等闲置重启才自愈）：按缺的能力重启再给
    await stopServe()
  }
  const task = (async () => {
    await ensureFiles(to, need)
    // 用哪个引擎：本版本目录优先，没有（下载失败/未发布）回落旧目录（0.4.x），参数按版本兼容
    const enginePath = existsSync(executablePath())
      ? executablePath()
      : existsSync(legacyExecutablePath())
        ? legacyExecutablePath()
        : null
    if (!enginePath) throw new Error('语音引擎不在（下载失败）')
    const legacy = enginePath === legacyExecutablePath()
    const modern = !legacy || versionAtLeast(detectEngineVersion(enginePath), POWER_VERSION)
    // 到这里模型都已落盘：按实际存在与否组 serve 参数（TTS 可选、Whisper 可选）
    const voicesDir = join(legacy ? legacyEngineDir() : engineDir(), 'voices')
    const hasTts = existsSync(join(modelsDir(), 'cosyvoice3', 'CosyVoice3-2512_Q8_0.gguf'))
    const hasWhisper = existsSync(join(modelsDir(), 'whisper', 'ggml-large-v3-turbo-q5_0.bin'))
    const hasClone =
      modern &&
      hasTts &&
      existsSync(join(modelsDir(), 'frontend-onnx', 'speech_tokenizer_v3.int8.onnx')) &&
      existsSync(join(modelsDir(), 'frontend-onnx', 'campplus.onnx'))
    if (need.forTts && !hasTts) throw new Error('CosyVoice3 模型缺失')
    if (need.forDictation && !hasWhisper) throw new Error('Whisper 定稿模型缺失')
    if (need.forClone && !hasClone) {
      throw new Error(legacy ? '新版语音引擎还没下好（克隆需要 v0.5），稍后重试' : '音色克隆的前端模型缺失')
    }
    pushProgress(to, 'loading', undefined, legacy ? '启动本地语音引擎（旧版，克隆暂不可用）' : '启动本地语音引擎', channel)
    const token = randomBytes(16).toString('hex')
    const args = [
      'serve',
      '--models',
      modelsDir(),
      // serve 的听写模型是硬要求（SenseVoice + VAD）；TTS / Whisper 定稿按下载情况带上；
      // 声纹（campplus 28MB）还没接功能，永远砍掉
      ...(hasTts
        ? ['--tts-model', join(modelsDir(), 'cosyvoice3', 'CosyVoice3-2512_Q8_0.gguf'), '--voices', voicesDir]
        : ['--no-tts']),
      ...(hasWhisper ? ['--whisper-model', join(modelsDir(), 'whisper', 'ggml-large-v3-turbo-q5_0.bin')] : ['--no-whisper']),
      // v0.5 克隆：用户音色落 rootDir()/user-voices（升级客户端不丢）；前端模型在才开。
      // --user-voices/--no-clone 是 0.5 才有的参数：旧引擎传了会「不认识的参数」直接退出（码 2）
      ...(modern ? (hasClone ? ['--user-voices', join(rootDir(), 'user-voices')] : ['--no-clone']) : []),
      '--no-speaker',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--token',
      token,
      '--parent-stdin'
    ]
    const child = spawn(enginePath, args, { cwd: rootDir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const next: Running = { child, wsUrl: '', token, caps: { tts: hasTts, whisper: hasWhisper, clone: hasClone } }
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
      let stderrTail = ''
      child.stderr.on('data', (chunk: Buffer) => {
        // --verbose 没开，这里主要是 ggml 的设备探测和错误；留尾部几百字给启动失败的报错
        const text = chunk.toString('utf8')
        stderrTail = (stderrTail + text).slice(-400)
        if (/error|失败|不支持|不认识|cannot/.test(text)) console.warn('[cosyvoice3]', text.trim().slice(0, 300))
      })
      child.once('error', (error) => {
        settled = true
        clearTimeout(timer)
        reject(new Error(`语音引擎启动失败：${error.message}`))
      })
      child.once('close', (code) => {
        if (!settled) {
          clearTimeout(timer)
          // 引擎自己打的错因（「不认识的参数：xxx」「找不到 Vulkan 设备」…）就在 stderr 里，别只猜显卡
          const why = stderrTail.trim().replace(/\s+/g, ' ').slice(-220)
          reject(
            new Error(
              `语音引擎启动后立刻退出（码 ${code}）${why ? `：${why}` : '——常见原因：显卡不支持 Vulkan / 驱动没有 Vulkan 运行库'}`
            )
          )
        }
      })
    })
    next.wsUrl = info.replace(/^http:/, 'ws:')
    running = next
    // 运行期死亡（GPU 驱动重置 / 引擎崩溃 / 被杀）：清掉句柄，下次播报重新拉起。
    // 不清的话 ensureServe 会一直复用死实例——每次 speakReply 都「和语音引擎的连接断了」，
    // 而每次复用的 touchIdle 还在给 4 分钟闲置自愈续命（重试越勤越不自愈），一个会话
    // 从此不再出声（2026-10 修，实测杀掉 serve 后所有 TTS 全灭）。启动期的 close 由上面
    // Promise 里的 once 处理（那时 running 还没置，这里不会重复抢）；stopServe 主动停时
    // running 已先置 null，同样不会误触发。
    child.once('close', () => {
      if (running === next) {
        running = null
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
      }
    })
    touchIdle()
    pushProgress(to, 'ready', undefined, undefined, channel)
    return next
  })()
  starting = task
  // 启动失败要把占位的 Promise 清掉，下次触发才能重试；成功路径下 running 已置好，
  // 这里也不能再指回旧 task（stopServe 后拿到已死的地址会直接并报错）。
  // 注意链序：finally 跟在 catch 后面——单独 void task.finally() 会派生一个无人接的
  // rejected promise（启动失败时刷 unhandledRejection）
  task
    .catch(() => {})
    .finally(() => {
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
    const server = await ensureServe(to, { forTts: true })
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

// MARK: 一次性转写（输入框 hold 模式）：serve 的 /v1/audio/transcriptions，
//  SenseVoice 出字 + Whisper 定稿都在引擎里（语言 auto；不再有本地多模型路由）

/** Float32（16 kHz）→ PCM16 WAV Blob（multipart 用） */
function pcm16Wav(samples: Float32Array): Blob {
  const pcm = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return new Blob([header, pcm], { type: 'audio/wav' })
}

export async function transcribeViaServe(
  to: WebContents,
  audio: Float32Array,
  lang?: string
): Promise<string> {
  const server = await ensureServe(to, { forDictation: true, progress: 'voice:model-progress' })
  const form = new FormData()
  form.append('file', pcm16Wav(audio), 'clip.wav')
  if (lang && lang !== 'auto') form.append('language', lang)
  const response = await fetch(`${server.wsUrl.replace(/^ws:/, 'http:')}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}` },
    body: form
  })
  if (!response.ok) throw new Error(`转写失败（${response.status}）：${await response.text()}`)
  const result = (await response.json()) as { text?: string }
  return (result.text ?? '').trim()
}

// MARK: 音色克隆（v0.5）：serve 的 /v1/voice/clone + 音色管理

async function cloneVoiceRequest(
  server: Running,
  name: string,
  audio: Float32Array,
  text?: string
): Promise<{ voice: string; transcript: string; seconds: number; took: number }> {
  const form = new FormData()
  form.append('file', pcm16Wav(audio), 'reference.wav')
  form.append('name', name)
  if (text) form.append('text', text)
  const response = await fetch(`${server.wsUrl.replace(/^ws:/, 'http:')}/v1/voice/clone`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}` },
    body: form
  })
  const body = (await response.json().catch(() => ({}))) as {
    voice?: string
    transcript?: string
    seconds?: number
    took?: number
    error?: { message?: string }
  }
  if (!response.ok) throw new Error(body.error?.message ?? `克隆失败（${response.status}）`)
  return { voice: body.voice ?? name, transcript: body.transcript ?? '', seconds: body.seconds ?? 0, took: body.took ?? 0 }
}

// MARK: 导入现成音色 gguf（v0.5）：拖拽/选文件 → user-voices/ 持久化 → 重启 serve 验证

/** 音色名规则（引擎 Server.cpp validVoiceName 同款）：字母数字下划线连字符中文，最长 60 */
function validVoiceName(name: string): boolean {
  return name.length > 0 && name.length <= 60 && /^[\p{L}\p{N}_-]+$/u.test(name)
}

// MARK: 引擎音色名的编码问题（Windows 实测）：引擎（C++）把收到的 UTF-8 名字按系统代码页
// （GBK）转宽字符写盘/列目录，中文名落盘即乱码（「验证克隆」→「楠岃瘉鍏嬮殕」），
// /v1/voices 里回的也是乱码名，和选中的名字永远对不上 → 选中不持久。引擎改不了，
// 客户端侧的修法：送引擎的名字一律 ASCII 安全名（u+随机），用户起的名字（显示名）
// 存 rootDir()/voice-names.json（和 user-voices 同目录，升级不丢），列表/选中/删除都走映射。

/** 显示名映射（安全名 → 用户起的名字）落盘位置 */
function displayNamesPath(): string {
  return join(rootDir(), 'voice-names.json')
}
function loadDisplayNames(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(displayNamesPath(), 'utf8')) as Record<string, string>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
function saveDisplayNames(map: Record<string, string>): void {
  try {
    writeFileSync(displayNamesPath(), JSON.stringify(map, null, 2), 'utf8')
  } catch {
    // 写不进（权限/磁盘）：本次会话内内存映射仍有效
  }
}

/** 生成不与现有名字冲突的 ASCII 安全名：引擎名/文件名全链路 ASCII，不再有编码问题 */
function newSafeName(taken: Iterable<string>): string {
  const used = new Set(taken)
  for (;;) {
    const name = `u${randomBytes(8).toString('hex').slice(0, 12)}`
    if (!used.has(name)) return name
  }
}

/** 乱码名反解：名字若是「UTF-8 字节被按 GBK 解码」的产物（引擎旧 bug 留下的存量文件），
 *  还原出用户起的原名；反解不合法或名字纯 ASCII 则不是这种乱码，返回 null */
function mojibakeOrigin(name: string): string | null {
  if (!/[^\x00-\x7f]/.test(name)) return null
  try {
    const origin = iconv.decode(iconv.encode(name, 'gbk'), 'utf8')
    if (origin !== name && validVoiceName(origin)) return origin
  } catch {
    // 名字里有 GBK 编不出的字符：不是这种乱码
  }
  return null
}

/** 一次性修复存量乱码音色文件（旧版克隆/导入的中文名落盘成了 GBK 乱码）：重命名成安全名 +
 *  记显示名映射（显示名从乱码里反解回来）。改过文件返回 true（serve 在跑的话要重启才能看到新名） */
async function repairMojibakeUserVoices(): Promise<boolean> {
  const userDir = join(rootDir(), 'user-voices')
  let files: string[]
  try {
    files = await readdir(userDir)
  } catch {
    return false
  }
  const ggufs = files.filter((f) => /\.gguf$/i.test(f))
  const map = loadDisplayNames()
  const taken = new Set(ggufs.map((f) => f.replace(/\.gguf$/i, '')))
  let changed = false
  for (const file of ggufs) {
    const name = file.replace(/\.gguf$/i, '')
    const origin = mojibakeOrigin(name)
    if (!origin) continue
    const safe = newSafeName(taken)
    try {
      await rename(join(userDir, file), join(userDir, `${safe}.gguf`))
      map[safe] = origin
      taken.add(safe)
      changed = true
    } catch {
      // 改不动（被占用等）：留着下次再试
    }
  }
  if (changed) saveDisplayNames(map)
  return changed
}

/** 拉引擎当前用户音色列表（安全名）；失败给空（调用方自行决定要不要当错误） */
async function fetchUserVoices(server: Running): Promise<string[]> {
  const response = await fetch(`${server.wsUrl.replace(/^ws:/, 'http:')}/v1/voices`, {
    headers: { Authorization: `Bearer ${server.token}` }
  })
  if (!response.ok) return []
  return (((await response.json()) as { user_voices?: unknown[] }).user_voices ?? []).map(String)
}

/** 扫 user-voices 目录列用户音色——引擎没跑时的列表来源。目录就是持久化清单：
 *  导入的文件都验证过「引擎列表看得到才算成功」、克隆也落这里，扫目录不会多出不存在的音色。 */
async function listUserVoiceFiles(): Promise<string[]> {
  try {
    const files = await readdir(join(rootDir(), 'user-voices'))
    return files.filter((f) => /\.gguf$/i.test(f)).map((f) => f.replace(/\.gguf$/i, ''))
  } catch {
    return []
  }
}

/** 导入接口的结果：成功的给音色名，失败的给原文件名 + 人话原因 */
interface VoiceImportResult {
  imported: string[]
  failed: { file: string; error: string }[]
}

/** 导入一批音色 gguf（克隆导出的 / 从别的机器拷来的，和内置 voices/*.gguf 同格式）：
 *  校验 → 先落 import-staging（引擎不扫）→ 移进 user-voices（持久化，升级客户端不丢）
 *  → 重启 serve 扫描 → /v1/voices 列表确认。必须「列表里看得到」才算成功：引擎对加载
 *  不了的 gguf 只是静默跳过，不确认的话用户以为导入成功、列表里却永远不出现。
 *
 *  更要命的是实测发现：header 坏掉的 gguf 会让 serve 启动即退（不是跳过）——直接复制进去
 *  验证的话，一个坏文件就把整个语音（播报+听写）毒死到手动删文件为止。所以验证分两级：
 *  快路径一批全验；serve 起不来就撤回 staging 逐个验（单个起不来 → 移走再起一次对照，
 *  起来了才归罪于文件，起不来是环境问题 → 回滚本次导入、不碰 user-voices）。 */
async function importVoiceFiles(to: WebContents, paths: string[]): Promise<VoiceImportResult> {
  // 注意：这里不预判引擎新旧/有无——ensureServe → ensureFiles 会自动下载新版引擎（点导入
  // 就是更新入口，进度走 voice:model-progress）；预判拦在前面的话旧引擎用户永远等不到升级
  const builtin = new Set(await installedVoices())
  const userDir = join(rootDir(), 'user-voices')
  const staging = join(rootDir(), 'import-staging') // 暂存区：serve 不扫，坏文件在这里毒不到引擎
  const failed: { file: string; error: string }[] = []
  const staged: { display: string; safe: string; from: string }[] = []
  const stagedFile = (voice: string): string => join(staging, `${voice}.gguf`)
  const userFile = (voice: string): string => join(userDir, `${voice}.gguf`)
  const backupFile = (voice: string): string => join(staging, `backup-${voice}.gguf`)
  const invalidVoice = '引擎加载不了（不是有效的 CosyVoice 音色 gguf）'

  // ① 逐个校验 + 复制到 staging；同名重复导入 = 更新那个音色（先备份旧版，失败可恢复）
  for (const raw of paths) {
    const file = String(raw ?? '')
    try {
      const info = await stat(file)
      if (!info.isFile()) throw new Error('不是文件')
      if (!/\.gguf$/i.test(file)) throw new Error('不是 .gguf 文件')
      if (info.size < 1024) throw new Error('文件太小（音色 gguf 一般几十到几百 KB）')
      if (info.size > 64 * 1024 * 1024) throw new Error('文件太大（音色 gguf 只有几百 KB，拖的是不是合成模型？）')
      // GGUF 头：magic + version==3（引擎 gguf_parser 硬编码只认 v3）；能不能真用交给引擎验证
      const fd = await openFile(file, 'r')
      try {
        const head = Buffer.alloc(8)
        await fd.read(head, 0, 8, 0)
        if (head.subarray(0, 4).toString('latin1') !== 'GGUF') throw new Error('文件头不是 GGUF（不是 gguf 格式）')
        if (head.readUInt32LE(4) !== 3) throw new Error(`GGUF 版本号不对（${head.readUInt32LE(4)}，要 3）`)
      } finally {
        await fd.close()
      }
      // 文件名 → 显示名：和克隆向导同款清洗（空格、路径分隔符等换 -）
      const display = basename(file)
        .replace(/\.gguf$/i, '')
        .replace(/[\\/:*?"<>|\s.]/g, '-')
        .slice(0, 60)
      if (!validVoiceName(display)) throw new Error('文件名清洗后不是合法音色名（字母、数字、下划线、连字符或中文）')
      if (builtin.has(display)) throw new Error(`和内置音色「${display}」同名，改个文件名再导入`)
      // 引擎侧一律 ASCII 安全名（Windows 下中文名落盘会成 GBK 乱码）；
      // 同名重复导入 = 更新那个音色：复用它已有的安全名，否则生成新的
      const map = loadDisplayNames()
      const existingSafe = Object.entries(map).find(([, d]) => d === display)?.[0]
      const safe = existingSafe ?? newSafeName([display, ...Object.keys(map)])
      await mkdir(staging, { recursive: true })
      if (existsSync(userFile(safe))) await copyFile(userFile(safe), backupFile(safe)).catch(() => {})
      await copyFile(file, stagedFile(safe))
      staged.push({ display, safe, from: file })
    } catch (error) {
      failed.push({ file: basename(file) || file, error: (error as Error)?.message ?? String(error) })
    }
  }

  // ② 验证：重启 serve（音色表是启动时扫的，addVoiceFile 没有对外端点），拉列表确认
  const imported: string[] = []
  const loadUserVoices = async (): Promise<Set<string>> => {
    if (running) await stopServe()
    // 引擎 crash 后马上重启偶发 Vulkan 驱动资源未释放（实测 RTX 2060 连环重启第 4 次会挂）：
    // 每次验证重启前留一小段缓冲，多文件验证时也压低节奏
    await new Promise((r) => setTimeout(r, 1200))
    // 要 forClone 不要只 forTts：/v1/voices 和 --user-voices 都挂在克隆能力下，
    // 没下过克隆前端模型的机器 serve 是 --no-clone 起的，/v1/voices 直接 404。
    // forClone 会让 ensureFiles 先把前端模型（约 31MB）下齐，serve 改带 --user-voices
    const server = await ensureServe(to, { forClone: true, progress: 'voice:model-progress' })
    const response = await fetch(`${server.wsUrl.replace(/^ws:/, 'http:')}/v1/voices`, {
      headers: { Authorization: `Bearer ${server.token}` }
    })
    if (!response.ok) throw new Error(`音色列表拉取失败（${response.status}）`)
    return new Set((((await response.json()) as { user_voices?: unknown[] }).user_voices ?? []).map(String))
  }
  /** 一个文件验完的善后：成了记账（成功提示用显示名、映射落盘），没成恢复备份的旧音色 */
  const settle = (item: { display: string; safe: string; from: string }, ok: boolean, error?: string): void => {
    if (ok) {
      imported.push(item.display)
      const map = loadDisplayNames()
      map[item.safe] = item.display
      saveDisplayNames(map)
      return
    }
    rm(userFile(item.safe), { force: true }).catch(() => {})
    // 恢复被覆盖的旧音色（同名更新失败 = 旧版还在）
    if (existsSync(backupFile(item.safe))) rename(backupFile(item.safe), userFile(item.safe)).catch(() => {})
    failed.push({ file: basename(item.from), error: error ?? invalidVoice })
  }

  if (staged.length) {
    await mkdir(userDir, { recursive: true })
    try {
      // 快路径：一批全部移进 user-voices，一轮 serve 验完（绝大多数情况：文件都是好的）
      for (const item of staged) await rename(stagedFile(item.safe), userFile(item.safe))
      let loaded = await loadUserVoices()
      // loadUserVoices → ensureServe → ensureFiles：引擎目录里没有新版时会自动下载升级。
      // 还停在旧目录（0.4 无 --user-voices，用户音色列表必然为空）就整体回滚明说，
      // 不然每个文件都会被误判成「gguf 无效」。按目录判而不是按版本号：serve 加不加
      // --user-voices 看的就是目录，两者不一致的边缘状态（新 exe 在旧目录）也归到这里
      if (activeEngineDir() !== engineDir()) {
        for (const item of staged) {
          await rm(userFile(item.safe), { force: true }).catch(() => {})
          if (existsSync(backupFile(item.safe)))
            await rename(backupFile(item.safe), userFile(item.safe)).catch(() => {})
        }
        await rm(staging, { recursive: true, force: true }).catch(() => {})
        throw new Error(
          '新版语音引擎没升级成功（已先自动尝试下载）：导入音色需要 v0.5 引擎。' +
            '网络恢复后再点一次导入，或用一次语音播报/听写，都会自动重试升级'
        )
      }
      for (const item of staged) settle(item, loaded.has(item.safe))
      // settle 里失败的（结构不对、引擎跳过的那种不致命坏文件）已删掉复制的文件：
      // user-voices 干净、引擎内存里也没加载它，不用再重启
    } catch (error) {
      // 「引擎没升级成功」是我们主动抛的分类结果，不是 serve 起不来：直接上抛给用户，
      // 别掉进下面的逐文件验证，最后把锅甩给环境/坏文件
      if (error instanceof Error && error.message.startsWith('新版语音引擎没升级成功')) throw error
      // serve 起不来：这批里有致命坏文件（实测会让引擎启动即退）。全部撤回 staging，逐个验
      for (const item of staged) {
        if (existsSync(userFile(item.safe))) {
          await rm(userFile(item.safe), { force: true }).catch(() => {})
          // 重新从源拷回 staging（被覆盖的旧音色也从备份恢复，保持导入前状态）
          await copyFile(item.from, stagedFile(item.safe)).catch(() => {})
          if (existsSync(backupFile(item.safe))) await rename(backupFile(item.safe), userFile(item.safe)).catch(() => {})
        }
      }
      for (const item of staged) {
        if (!existsSync(stagedFile(item.safe))) continue
        try {
          await rm(userFile(item.safe), { force: true }).catch(() => {})
          await rename(stagedFile(item.safe), userFile(item.safe))
        } catch {
          continue
        }
        try {
          const loaded = await loadUserVoices()
          settle(item, loaded.has(item.safe))
        } catch {
          // 单个也起不来：移走它再起一次对照——起来了才归罪于这个文件，起不来是环境问题
          await rm(userFile(item.safe), { force: true }).catch(() => {})
          if (existsSync(backupFile(item.safe))) await rename(backupFile(item.safe), userFile(item.safe)).catch(() => {})
          try {
            await loadUserVoices() // 对照成功（顺带把语音恢复可用）
            failed.push({ file: basename(item.from), error: '引擎加载不了（gguf 损坏，已跳过）' })
          } catch (env) {
            await rm(staging, { recursive: true, force: true }).catch(() => {})
            throw new Error(
              `语音引擎启动失败（环境问题，不是导入文件的问题）：${(env as Error).message}。` +
                `已导入 ${imported.join('、') || '无'}，其余已回滚`
            )
          }
        }
      }
    }
  }
  await rm(staging, { recursive: true, force: true }).catch(() => {})
  return { imported, failed }
}

export function registerCosyVoiceIpc(): void {
  // 播报合成（原 kokoro/CosyVoice3 双路由收敛为引擎一条路；engine 字段兼容旧渲染层缓存）
  ipcMain.handle(
    'voice:speak',
    async (
      event: IpcMainInvokeEvent,
      payload: { text: string; speed?: number; voice?: string; instruction?: string }
    ): Promise<{ samples: Float32Array; sampleRate: number }> =>
      synthesizeCosyVoice(event.sender, payload.text, {
        voice: payload.voice,
        speed: payload.speed,
        instruction: payload.instruction
      })
  )
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
  // v0.5 克隆状态：引擎得是 0.5（旧版 0.4.x 没有克隆端点）+ 前端两个 ONNX + CosyVoice3 都在
  ipcMain.handle('voice:clone-status', () => {
    const dir = activeEngineDir()
    const modern =
      !!dir &&
      (dir === engineDir() || versionAtLeast(detectEngineVersion(exeIn(dir)), POWER_VERSION))
    return {
      supported: engineTarget() !== null,
      installed:
        engineTarget() !== null &&
        modern &&
        existsSync(join(modelsDir(), 'frontend-onnx', 'speech_tokenizer_v3.int8.onnx')) &&
        existsSync(join(modelsDir(), 'frontend-onnx', 'campplus.onnx')) &&
        existsSync(join(modelsDir(), 'cosyvoice3', 'CosyVoice3-2512_Q8_0.gguf')),
      serving: running?.caps.clone === true
    }
  })
  // 克隆：audio 为 16 kHz Float32（8~15 秒）；没给 text 让引擎听写当底稿。首次会先下前端模型（进度走 voice:model-progress）。
  // 名字送引擎一律 ASCII 安全名（引擎在 Windows 会把中文名落盘成 GBK 乱码），显示名存 voice-names.json
  ipcMain.handle(
    'voice:clone',
    async (
      event: IpcMainInvokeEvent,
      payload: { name: string; audio: Float32Array; text?: string }
    ): Promise<{ voice: string; name: string; transcript: string; seconds: number; took: number }> => {
      if (!payload?.name || !payload.audio?.length) throw new Error('克隆要名字和录音')
      if (!validVoiceName(payload.name)) throw new Error('音色名不合法（字母、数字、下划线、连字符或中文，最长 60）')
      const server = await ensureServe(event.sender, { forClone: true, progress: 'voice:model-progress' })
      const display = payload.name
      const map = loadDisplayNames()
      // 同名再克隆 = 更新那个音色：引擎对已存在的名字直接拒绝（已有同名音色），
      // 所以先删旧的再沿用原安全名克隆
      const taken = await fetchUserVoices(server)
      const existing = Object.entries(map).find(([safe, d]) => d === display && taken.includes(safe))
      if (existing) {
        await fetch(`${server.wsUrl.replace(/^ws:/, 'http:')}/v1/voice/${encodeURIComponent(existing[0])}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${server.token}` }
        }).catch(() => {})
      }
      const safe = existing?.[0] ?? newSafeName([...taken.filter((n) => n !== existing?.[0]), ...Object.keys(map)])
      const result = await cloneVoiceRequest(server, safe, payload.audio, payload.text)
      map[safe] = display
      saveDisplayNames(map)
      return { ...result, voice: safe, name: display }
    }
  )
  // 引擎音色列表（内置 + 用户克隆的；带 default，供播报选音色）。user 是引擎侧安全名，
  // userDisplay 把安全名换回用户起的名字；顺手修存量乱码文件（改了文件 → 停 serve，下次使用重新扫）
  ipcMain.handle(
    'voice:voices',
    async (): Promise<{
      voices: string[]
      user: string[]
      clone: boolean
      default: string
      userDisplay: Record<string, string>
    }> => {
      if (await repairMojibakeUserVoices()) {
        // 文件名改了：正在跑的引擎内存里还是旧名，停掉它（本次返回空 user 列表，下次使用重新拉起）
        if (running) await stopServe()
        return { voices: await installedVoices(), user: [], clone: false, default: 'default', userDisplay: loadDisplayNames() }
      }
      const userDisplay = loadDisplayNames()
      // 引擎懒启动（重启后 / 闲置停掉后都不跑）：不能为了看列表拉起它（要好几秒还占 GPU）。
      // user-voices 目录本身就是持久化清单，直接扫；引擎起来后扫的也是同一个目录，两边一致。
      // clone: false 只代表引擎此刻没在跑，克隆能力看 clone-status。
      if (!running) {
        return { voices: await installedVoices(), user: await listUserVoiceFiles(), clone: false, default: 'default', userDisplay }
      }
      const response = await fetch(`${running.wsUrl.replace(/^ws:/, 'http:')}/v1/voices`, {
        headers: { Authorization: `Bearer ${running.token}` }
      })
      if (!response.ok) throw new Error(`音色列表拉取失败（${response.status}）`)
      const body = (await response.json()) as { voices?: string[]; user_voices?: string[]; clone?: boolean; default?: string }
      return { voices: body.voices ?? [], user: body.user_voices ?? [], clone: body.clone === true, default: body.default ?? 'default', userDisplay }
    }
  )
  ipcMain.handle('voice:delete-voice', async (_event: IpcMainInvokeEvent, name: string): Promise<void> => {
    if (!running) throw new Error('语音引擎没在跑')
    const response = await fetch(`${running.wsUrl.replace(/^ws:/, 'http:')}/v1/voice/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${running.token}` }
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
      throw new Error(body.error?.message ?? `删除失败（${response.status}）`)
    }
    // 删成功了才清显示名映射：先清的话引擎删除失败时映射已丢，音色还在但 UI 只能显示安全名
    const map = loadDisplayNames()
    if (map[name]) {
      delete map[name]
      saveDisplayNames(map)
    }
  })
  // 拖拽导入音色 gguf：路径是 preload 用 webUtils 从拖放的 File 里换出来的（和 upload:register-drop
  // 同一信任级别——渲染进程接触不到本机路径，伪造不了）；这里只收数组、逐个校验
  ipcMain.handle('voice:import-voice', async (event, paths: unknown): Promise<VoiceImportResult> =>
    importVoiceFiles(event.sender, Array.isArray(paths) ? paths.map(String) : [])
  )
  // 点击「选择文件」导入：对话框在主进程弹，选中的路径不经过渲染层直接导入
  ipcMain.handle(
    'voice:import-picked',
    async (
      event: IpcMainInvokeEvent
    ): Promise<VoiceImportResult & { canceled: boolean }> => {
      const picked = await dialog.showOpenDialog({
        title: '选择要导入的音色文件',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'CosyVoice 音色（gguf）', extensions: ['gguf'] }]
      })
      if (picked.canceled || !picked.filePaths.length) return { canceled: true, imported: [], failed: [] }
      return { canceled: false, ...(await importVoiceFiles(event.sender, picked.filePaths)) }
    }
  )
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
      (existsSync(executablePath()) || existsSync(legacyExecutablePath())) &&
      existsSync(join(modelsDir(), 'sensevoice-small-q8.gguf')) &&
      existsSync(join(modelsDir(), 'fsmn-vad.gguf')) &&
      existsSync(join(modelsDir(), 'whisper', 'ggml-large-v3-turbo-q5_0.bin')),
    serving: running !== null,
    whisperInstalled: existsSync(join(modelsDir(), 'whisper', 'ggml-large-v3-turbo-q5_0.bin'))
  }
}
