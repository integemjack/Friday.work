// 输入框语音听写的 Qwen3-ASR 引擎（sherpa-onnx 运行时，CPU 推理）：
//   - 定位（2026-10）：替换 whisper 槽位——「中英混合」与俄/法/德/西等 SenseVoice
//     不支持的语言默认走这里；「识别模型」菜单也可显式锁定 0.6B / 1.7B。
//   - 为什么：本机同题实测（i7-10700F / int8 / 4 线程，详见 works 分析报告 §6），
//     0.6B 在极快语速、粤语中英夹杂、英文+噪声三段明显好于 SenseVoice/whisper，
//     自带标点，支持 30 语种 + 22 中文方言；RTF 0.22–0.52（5s 句 1.4–2.6s），
//     快于 whisper-small 的 3–5s。
//   - 已知弱点（实测）：强噪下偶发「幻觉」——补出音频里没有的整句；whisper 保留
//     为下载/加载失败时的回退引擎（回退链见 Dictation.ts）。
//   - 模型（int8，sherpa 格式）：
//     · 0.6B 官方包：GitHub releases 单文件 tar.bz2（约 838MB，解压后 ~940MB）
//     · 1.7B 社区包：HuggingFace thieunv-asilla 按文件下载（约 2.4GB；官方暂未
//       发布 1.7B，后续官方出了只需换这里清单）
//     下载到 userData/qwen3-asr-models/<size>/，之后完全离线；进度复用
//     'voice:model-progress' 推给渲染进程。
//   - 模型无 language 配置（sherpa 的 qwen3Asr 只有 hotwords，语种全自动识别）。

import { app, type WebContents } from 'electron'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export type Qwen3Size = '0.6b' | '1.7b'

/** 只声明听写用到的最小面（sherpa-onnx-node 未随包发布类型） */
interface OfflineStreamLike {
  acceptWaveform(obj: { sampleRate: number; samples: Float32Array }): void
}
interface OfflineRecognizerLike {
  createStream(): OfflineStreamLike
  decode(stream: OfflineStreamLike): void
  getResult(stream: OfflineStreamLike): { text: string }
}

function pushProgress(
  to: WebContents,
  phase: 'downloading' | 'loading' | 'ready',
  percent?: number,
  detail?: string
): void {
  try {
    to.send('voice:model-progress', { phase, percent, detail })
  } catch {
    // 窗口已关：忽略
  }
}

/** 各尺寸的模型清单：有 tarball = 官方单包（下载后解压）；有 repo+files = 按文件下 */
const MANIFESTS: Record<
  Qwen3Size,
  { label: string; tarball?: string; tarDir?: string; repo?: string; files?: string[]; marker: string }
> = {
  '0.6b': {
    label: 'Qwen3-ASR 0.6B',
    tarball:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2',
    tarDir: 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25',
    marker: 'decoder.int8.onnx'
  },
  '1.7b': {
    label: 'Qwen3-ASR 1.7B',
    repo: 'thieunv-asilla/sherpa-onnx-qwen3-asr-1.7B-int8',
    files: [
      'conv_frontend.onnx',
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'tokenizer/merges.txt',
      'tokenizer/tokenizer_config.json',
      'tokenizer/vocab.json'
    ],
    marker: 'decoder.int8.onnx'
  }
}

/** HF 按文件下载的双源：官方源连不上很常见（同 SenseVoice/whisper 的策略） */
const HOSTS = ['https://huggingface.co', 'https://hf-mirror.com']

function modelDir(size: Qwen3Size): string {
  return join(app.getPath('userData'), 'qwen3-asr-models', size)
}

/** 下载一个文件到 dest（先写 .part 再改名，中断不会留下假完整的文件），进度按 content-length 推百分比 */
async function download(
  to: WebContents,
  label: string,
  url: string,
  dest: string
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${url}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const part = `${dest}.part`
  let received = 0
  let lastPush = 0
  const stream = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream)
  stream.on('data', (chunk: Uint8Array) => {
    received += chunk.length
    const now = Date.now()
    if (now - lastPush > 400) {
      lastPush = now
      pushProgress(to, 'downloading', total ? Math.round((received / total) * 100) : undefined, label)
    }
  })
  try {
    await pipeline(stream, createWriteStream(part))
    await rename(part, dest)
  } catch (error) {
    await rm(part, { force: true })
    throw error
  }
}

/** 解压 tar.bz2（Windows 10 1803+ / macOS / Linux 均内置 tar） */
function extractTarball(tarball: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', tarball, '-C', dir], { stdio: 'ignore' })
    child.on('error', (error) => reject(new Error(`解压模型失败（没有 tar 命令）：${error.message}`)))
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压模型失败（tar 退出码 ${code}）`))))
  })
}

/** 0.6B：官方 tar.bz2 单包下载 + 解压，解完删包 */
async function ensureTarballModel(to: WebContents, size: Qwen3Size): Promise<string> {
  const manifest = MANIFESTS[size]
  const base = modelDir(size)
  await mkdir(base, { recursive: true })
  const extracted = join(base, manifest.tarDir!)
  if (existsSync(join(extracted, manifest.marker))) return extracted
  const tarball = join(base, 'model.tar.bz2')
  if (!existsSync(tarball)) {
    pushProgress(to, 'downloading', 0, manifest.label)
    await download(to, manifest.label, manifest.tarball!, tarball)
  }
  pushProgress(to, 'downloading', undefined, `${manifest.label} 解压中`)
  await extractTarball(tarball, base)
  if (!existsSync(join(extracted, manifest.marker))) {
    throw new Error(`${manifest.label} 解压后缺文件（${manifest.marker}）`)
  }
  await rm(tarball, { force: true })
  return extracted
}

/** 1.7B：HF 仓库按文件下载（先下小的词表文件，再下大的模型体） */
async function ensureFileModel(to: WebContents, size: Qwen3Size): Promise<string> {
  const manifest = MANIFESTS[size]
  const dir = modelDir(size)
  await mkdir(dir, { recursive: true })
  for (const name of manifest.files!) {
    const dest = join(dir, name)
    if (existsSync(dest)) continue
    pushProgress(to, 'downloading', 0, `${manifest.label} ${name}`)
    let firstError: unknown = null
    let done = false
    for (const host of HOSTS) {
      try {
        await download(to, manifest.label, `${host}/${manifest.repo}/resolve/main/${name}`, dest)
        done = true
        break
      } catch (error) {
        firstError ??= error
      }
    }
    if (!done) {
      throw new Error(`${manifest.label} 下载失败：${String((firstError as Error)?.message ?? firstError)}`)
    }
  }
  return dir
}

/** 模型就位（已存在跳过下载），返回 sherpa 模型根目录 */
function ensureModel(to: WebContents, size: Qwen3Size): Promise<string> {
  return MANIFESTS[size].tarball ? ensureTarballModel(to, size) : ensureFileModel(to, size)
}

/** 每个尺寸各自常驻一份识别器（同时加载约 3.5GB RSS，32GB 机器无碍） */
const recognizers = new Map<Qwen3Size, OfflineRecognizerLike>()
const loadings = new Map<Qwen3Size, Promise<OfflineRecognizerLike>>()

/** 懒加载（含首次下载）；同一尺寸重复调用共用同一个 Promise */
function loadRecognizer(to: WebContents, size: Qwen3Size): Promise<OfflineRecognizerLike> {
  const loaded = recognizers.get(size)
  if (loaded) return Promise.resolve(loaded)
  const pending = loadings.get(size)
  if (pending) return pending
  const task = (async () => {
    const dir = await ensureModel(to, size)
    pushProgress(to, 'loading', undefined, MANIFESTS[size].label)
    // 加载顺序坑（实测，同 SenseVoiceService）：sherpa-onnx-node 先加载后，
    // whisper 用的 onnxruntime-node 再加载会直接 LoadLibrary 失败；先把它拉起来占位
    try {
      createRequire(import.meta.url)('onnxruntime-node')
    } catch {
      // onnxruntime-node 缺失时 whisper 回退不可用，Qwen3 不受影响
    }
    // CJS 包走动态 import 会带 default 互操作，两种形态都认
    const mod = (await import('sherpa-onnx-node')) as unknown as {
      OfflineRecognizer?: new (config: unknown) => OfflineRecognizerLike
      default?: { OfflineRecognizer: new (config: unknown) => OfflineRecognizerLike }
    }
    const Ctor = mod.OfflineRecognizer ?? mod.default?.OfflineRecognizer
    if (!Ctor) throw new Error('sherpa-onnx-node 加载异常（找不到 OfflineRecognizer）')
    const recognizer = new Ctor({
      modelConfig: {
        qwen3Asr: {
          convFrontend: join(dir, 'conv_frontend.onnx'),
          encoder: join(dir, 'encoder.int8.onnx'),
          decoder: join(dir, 'decoder.int8.onnx'),
          tokenizer: join(dir, 'tokenizer'),
          hotwords: ''
        },
        tokens: '',
        numThreads: 4,
        debug: 0,
        provider: 'cpu'
      }
    })
    recognizers.set(size, recognizer)
    loadings.delete(size)
    pushProgress(to, 'ready')
    return recognizer
  })()
  loadings.set(size, task)
  task.catch(() => loadings.delete(size)) // 失败让下次能重试
  return task
}

/** 转写一段 16 kHz 单声道采样（语种由模型自动识别，无 language 配置）。
 *  模型下载/加载失败会抛错（Dictation 兜底回 whisper） */
export async function transcribeWithQwen3(
  to: WebContents,
  audio: Float32Array,
  size: Qwen3Size
): Promise<{ text: string }> {
  const r = await loadRecognizer(to, size)
  const stream = r.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples: audio })
  r.decode(stream)
  return { text: (r.getResult(stream).text ?? '').trim() }
}
