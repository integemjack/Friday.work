// 输入框语音听写的主力引擎：SenseVoice-small（sherpa-onnx 运行时，CPU 推理）。
//   - 为什么主力：对中文/带噪/电话带宽音频远强于同级 whisper——实测同一段
//     「强噪+混响+电话带宽」音频，whisper-base 输出「请看City」、whisper-small
//     输出「您可以進去」，SenseVoice 仍全对；CPU 短句 0.1s 级出字
//     （whisper-small 要 3–5s），输出自带标点、简体。
//   - 弱点：中英夹杂句里的英文专名会拼音化（GitHub→gi top），纯英文整句没问题；
//     「中英混合」和俄/法/德/西等语言由 Dictation.ts 路由到 whisper。
//   - 模型 int8 约 230MB + tokens.txt，首次从 HuggingFace（失败换 hf-mirror 镜像）
//     下载到 userData/sensevoice-models/，之后完全离线；下载进度复用
//     'voice:model-progress' 事件推给渲染进程。
//   - sherpa-onnx-node 是预编译 N-API 原生模块（Electron 44 实测可直接加载）；
//     打包时 .node 由 electron-builder 的 asarUnpack '**/*.node' 处理。

import { app, type WebContents } from 'electron'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
/** 官方源连不上很常见（同 whisper 的策略），失败换国内镜像 */
const HOSTS = ['https://huggingface.co', 'https://hf-mirror.com']
/** 模型文件（先下小的 tokens，再下大的模型体） */
const FILES = ['tokens.txt', 'model.int8.onnx'] as const

/** 只声明听写用到的最小面（sherpa-onnx-node 未随包发布类型） */
interface OfflineStreamLike {
  acceptWaveform(obj: { sampleRate: number; samples: Float32Array }): void
}
interface OfflineRecognizerLike {
  createStream(): OfflineStreamLike
  decode(stream: OfflineStreamLike): void
  getResult(stream: OfflineStreamLike): { text: string }
  /** 热切换语言（zh/en/ja/ko），不用重建实例（每个实例独立加载一份 onnx） */
  setConfig(config: unknown): void
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

function modelDir(): string {
  return join(app.getPath('userData'), 'sensevoice-models')
}

/** 下载一个文件到 dest（先写 .part 再改名，中断不会留下假完整的文件），进度按 content-length 推百分比 */
async function download(to: WebContents, url: string, dest: string): Promise<void> {
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
      pushProgress(to, 'downloading', total ? Math.round((received / total) * 100) : undefined, undefined)
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

let recognizer: OfflineRecognizerLike | null = null
let loading: Promise<OfflineRecognizerLike> | null = null
/** recognizer 当前语言（setConfig 切换后更新；空 = 未设置） */
let recognizerLang = ''

/** 懒加载模型（含首次下载）；同一时刻只加载一份，重复调用共用同一个 Promise */
function loadRecognizer(to: WebContents): Promise<OfflineRecognizerLike> {
  if (recognizer) return Promise.resolve(recognizer)
  if (loading) return loading
  loading = (async () => {
    const dir = modelDir()
    await mkdir(dir, { recursive: true })
    for (const name of FILES) {
      const dest = join(dir, name)
      if (existsSync(dest)) continue
      pushProgress(to, 'downloading', 0, name === 'tokens.txt' ? 'SenseVoice 词表' : 'SenseVoice 模型')
      let firstError: unknown = null
      let done = false
      for (const host of HOSTS) {
        try {
          await download(to, `${host}/${REPO}/resolve/main/${name}`, dest)
          done = true
          break
        } catch (error) {
          firstError ??= error
        }
      }
      if (!done) {
        loading = null // 让下次按键能重试
        throw new Error(`SenseVoice 模型下载失败：${String((firstError as Error)?.message ?? firstError)}`)
      }
    }
    pushProgress(to, 'loading', undefined, 'SenseVoice')
    // 加载顺序坑（实测）：sherpa-onnx-node 先加载后，whisper 用的 onnxruntime-node
    // 再加载会直接 LoadLibrary 失败（"The operating system cannot run %1"，两个
    // native 模块各自捆了 onnxruntime 运行时）；反过来先加载 onnxruntime-node 则
    // 相安无事。这里用 createRequire（不被打包器静态分析/内联，dev 与打包后都
    // 走运行时 node_modules 解析）先把它拉起来占位；拉不起来不拦 SenseVoice，
    // whisper 路径自己会报错。
    try {
      createRequire(import.meta.url)('onnxruntime-node')
    } catch {
      // onnxruntime-node 缺失时 whisper 不可用，SenseVoice 不受影响
    }
    // CJS 包走动态 import 会带 default 互操作，两种形态都认
    const mod = (await import('sherpa-onnx-node')) as unknown as {
      OfflineRecognizer?: new (config: unknown) => OfflineRecognizerLike
      default?: { OfflineRecognizer: new (config: unknown) => OfflineRecognizerLike }
    }
    const Ctor = mod.OfflineRecognizer ?? mod.default?.OfflineRecognizer
    if (!Ctor) throw new Error('sherpa-onnx-node 加载异常（找不到 OfflineRecognizer）')
    const loaded = new Ctor({
      modelConfig: {
        senseVoice: {
          model: join(dir, 'model.int8.onnx'),
          // 初始留空，首次转写前按路由语言 setConfig（见 transcribeWithSenseVoice）
          language: '',
          useInverseTextNormalization: 0
        },
        tokens: join(dir, 'tokens.txt'),
        numThreads: 4,
        debug: 0,
        provider: 'cpu'
      }
    })
    recognizer = loaded
    pushProgress(to, 'ready')
    return loaded
  })()
  return loading
}

/** 转写一段 16 kHz 单声道采样；lang 为 SenseVoice 语言码（zh/en/ja/ko）。
 *  语言用 setConfig 热切（实测自动语言预测在噪声下会退化：同一段 L6 强噪音频
 *  language='' 出「你开星期几」，强制 zh 出「今天星期几」）。
 *  模型下载/加载失败会抛错（Dictation 兜底回 whisper） */
export async function transcribeWithSenseVoice(
  to: WebContents,
  audio: Float32Array,
  lang: string
): Promise<{ text: string }> {
  const r = await loadRecognizer(to)
  if (lang && lang !== recognizerLang) {
    r.setConfig({ modelConfig: { senseVoice: { language: lang } } })
    recognizerLang = lang
  }
  const stream = r.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples: audio })
  r.decode(stream)
  return { text: (r.getResult(stream).text ?? '').trim() }
}
