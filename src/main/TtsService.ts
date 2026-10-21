// 助手回复的语音播报（TTS）：两套引擎可选，入口同一个（ipcMain 'voice:speak' 按
// payload.engine 分发）：
//   - kokoro v1.1（本文件）：sherpa-onnx 运行时、CPU 推理，103 个音色、无需显卡、
//     模型包约 350MB；默认引擎。
//   - CosyVoice3（CosyVoiceService.ts）：服务端本地语音 Power 同款模型和加载方式，
//     本机 GPU（Vulkan）推理，5 个音色 + 语气指令，音质更自然。
//   - 103 个音色：sid 0-2 英文女声（af_maple/af_sol/bf_vale），3-57 中文女声
//     （zf_001-zf_055），58-102 中文男声（zm_001-zm_045）——映射来自
//     k2-fsa/sherpa-onnx PR #1942；中英文都能念，标点自带停顿。
//     默认 sid 44（zf_042）：103 个音色实测基频/亮度里最「清亮」的一档，见渲染层
//     speechOutput.ts 的 PRESET_VOICES 注释。
//   - 用 fp32 不用 int8：实测 i7-10700F（8核）上 int8 RTF 1.29（比实时还慢，
//     反量化反而拖后腿），fp32 RTF 0.30-0.43（快 3-4 倍）；配合渲染层分句
//     流水线，首句 1-2 秒出声，后续句在播放期间合成。
//   - 模型包 fp32 约 350MB（tar.bz2 单文件：model.onnx + voices.bin +
//     espeak-ng-data + lexicon + 数字/日期规则），首次从 GitHub release 下载
//     （直连，失败换 ghproxy / ghfast 镜像）到 userData/tts-models/，之后完全
//     离线；下载/解压/加载进度经 'voice:tts-progress' 事件推给渲染进程。
//   - 与听写共用 sherpa-onnx-node 原生模块（asUnpack '*.node'）；
//     加载顺序坑见 SenseVoiceService：先让 onnxruntime-node 占位再拉 sherpa。
//   - 合成走 generateAsync（不阻塞主进程 event loop）；同一时刻只跑一份合成
//     （串行队列），支持打断（丢弃 token 的任务结果不返回）。

import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { GeneratedAudio, OfflineTts } from 'sherpa-onnx-node'
import { synthesizeCosyVoice } from './CosyVoiceService.js'

/** GitHub release 附件（tts-models tag）；直连失败换公共镜像（都指向同一附件） */
const RELEASE_PATH = 'k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2'
const DOWNLOAD_HOSTS = ['https://github.com', 'https://ghproxy.net/https://github.com', 'https://ghfast.top/https://github.com']
/** tar 包解出来的顶层目录名 */
const ARCHIVE_DIR = 'kokoro-multi-lang-v1_1'
/** 合成用的模型文件（fp32；不用 int8 的理由见文件头） */
const MODEL_FILE = 'model.onnx'

function pushProgress(
  to: WebContents,
  phase: 'downloading' | 'extracting' | 'loading' | 'ready' | 'error',
  percent?: number,
  detail?: string
): void {
  try {
    to.send('voice:tts-progress', { phase, percent, detail })
  } catch {
    // 窗口已关：忽略
  }
}

function modelDir(): string {
  return join(app.getPath('userData'), 'tts-models', ARCHIVE_DIR)
}

/** 下载 tar.bz2 到 dest（.part 再改名），进度按 content-length 推百分比 */
async function download(to: WebContents, url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
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
      pushProgress(to, 'downloading', total ? Math.round((received / total) * 100) : undefined)
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

/** 系统 tar 解压（Windows 10+ 自带 bsdtar，macOS/Linux 也有）；解完删压缩包 */
function extract(archive: string, intoDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xjf', archive, '-C', intoDir], { windowsHide: true })
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

let tts: OfflineTts | null = null
let loading: Promise<OfflineTts> | null = null

/** 懒加载模型（含首次下载 + 解压）；同一时刻只加载一份，重复调用共用同一个 Promise */
function loadTts(to: WebContents): Promise<OfflineTts> {
  if (tts) return Promise.resolve(tts)
  if (loading) return loading
  loading = (async () => {
    const dir = modelDir()
    const modelFile = join(dir, MODEL_FILE)
    if (!existsSync(modelFile)) {
      const parent = join(dir, '..')
      await mkdir(parent, { recursive: true })
      const archive = join(parent, `${ARCHIVE_DIR}.tar.bz2`)
      pushProgress(to, 'downloading', 0, 'kokoro 语音模型')
      let firstError: unknown = null
      let done = false
      for (const host of DOWNLOAD_HOSTS) {
        try {
          await download(to, `${host}/${RELEASE_PATH}`, archive)
          done = true
          break
        } catch (error) {
          firstError ??= error
        }
      }
      if (!done) {
        loading = null // 让下次触发能重试
        throw new Error(`kokoro 模型下载失败：${String((firstError as Error)?.message ?? firstError)}`)
      }
      pushProgress(to, 'extracting', undefined, '解压语音模型')
      try {
        await extract(archive, parent)
      } catch (error) {
        await rm(archive, { force: true })
        await rm(dir, { recursive: true, force: true })
        loading = null
        throw new Error(`kokoro 模型解压失败：${String((error as Error)?.message ?? error)}`)
      }
      await rm(archive, { force: true })
      if (!existsSync(modelFile)) {
        await rm(dir, { recursive: true, force: true })
        loading = null
        throw new Error('kokoro 模型包内容不完整（缺 model.onnx）')
      }
    }
    pushProgress(to, 'loading', undefined, 'kokoro')
    // 加载顺序坑（同 SenseVoiceService）：先让 onnxruntime-node 占位再拉 sherpa-onnx-node
    try {
      createRequire(import.meta.url)('onnxruntime-node')
    } catch {
      // onnxruntime-node 缺失时 whisper 不可用，TTS 不受影响
    }
    const mod = (await import('sherpa-onnx-node')) as unknown as {
      OfflineTts?: new (config: unknown) => OfflineTts
      default?: { OfflineTts: new (config: unknown) => OfflineTts }
    }
    const Ctor = mod.OfflineTts ?? mod.default?.OfflineTts
    if (!Ctor) throw new Error('sherpa-onnx-node 加载异常（找不到 OfflineTts）')
    const loaded = new Ctor({
      model: {
        kokoro: {
          model: modelFile,
          voices: join(dir, 'voices.bin'),
          tokens: join(dir, 'tokens.txt'),
          // espeak-ng 的 G2P 数据目录（英文按音素拼读、中文生僻字兜底）
          dataDir: join(dir, 'espeak-ng-data'),
          // 中英双 lexicon（zh 查词表 + 美音英文表），逗号分隔
          lexicon: [join(dir, 'lexicon-zh.txt'), join(dir, 'lexicon-us-en.txt')].join(','),
          lengthScale: 1.0
        },
        numThreads: 8,
        debug: 0,
        provider: 'cpu'
      },
      // 长文本按单句合成再拼接（省内存），句间静音略收紧
      maxNumSentences: 1,
      silenceScale: 0.2,
      // 日期/数字的中文读法（2026年10月、110、18601200909 这类）
      ruleFsts: [join(dir, 'date-zh.fst'), join(dir, 'number-zh.fst')].join(',')
    })
    tts = loaded
    pushProgress(to, 'ready')
    return loaded
  })()
  return loading
}

/** 串行合成队列：同一时刻只跑一份（onnx 会话占几百 MB，并发没有意义） */
let queueTail: Promise<unknown> = Promise.resolve()

/** 合成一段语音。首次调用会触发模型下载/加载（进度经事件推送）。 */
export function synthesizeSpeech(
  to: WebContents,
  text: string,
  sid: number,
  speed: number
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const run = async (): Promise<{ samples: Float32Array; sampleRate: number }> => {
    const engine = await loadTts(to)
    // enableExternalBuffer: false —— Electron 44 的 Node 运行时禁止创建外部 ArrayBuffer
    // （sherpa 默认用它零拷贝返回音频：同步路径直接抛「External buffers are not allowed」，
    // 异步路径在收尾时抛、被 addon 吞成「TTS settlement failed」）。改为拷入 JS 内存，
    // 每句只多拷几百 KB；结果本来就要经 IPC 结构化克隆发给渲染层，无额外代价。
    const audio: GeneratedAudio = await engine.generateAsync({ text, sid, speed, enableExternalBuffer: false })
    return { samples: audio.samples, sampleRate: audio.sampleRate }
  }
  const next = queueTail.then(run, run)
  // 队列只关心顺序，不把前一个的失败传染给后一个
  queueTail = next.catch(() => {})
  return next
}

/** 只触发模型下载/加载（设置里的「立即下载」），不合成 */
export function prefetchTtsModel(to: WebContents): Promise<void> {
  return loadTts(to).then(
    () => {},
    () => {}
  )
}

export function registerTtsIpc(): void {
  ipcMain.handle(
    'voice:speak',
    async (
      event: IpcMainInvokeEvent,
      payload: { text?: string; sid?: number; speed?: number; engine?: string; voice?: string; instruction?: string }
    ): Promise<{ samples: Float32Array; sampleRate: number }> => {
      const text = (payload.text ?? '').trim()
      if (!text) return { samples: new Float32Array(0), sampleRate: 24000 }
      const speed = typeof payload.speed === 'number' && payload.speed > 0.2 && payload.speed < 4 ? payload.speed : 1.0
      // 两套引擎同一入口：kokoro（CPU、103 音色、无需额外下载）/ cosyvoice3（本机 GPU、
      // 服务端同款模型，见 CosyVoiceService）；返回格式一致，渲染层播放不用分叉
      if (payload.engine === 'cosyvoice3') {
        return synthesizeCosyVoice(event.sender, text, {
          voice: payload.voice,
          speed,
          instruction: payload.instruction
        })
      }
      const sid = Number.isInteger(payload.sid) && payload.sid! >= 0 ? payload.sid! : 44
      return synthesizeSpeech(event.sender, text, sid, speed)
    }
  )

  ipcMain.handle('voice:tts-prefetch', (event: IpcMainInvokeEvent): void => {
    void prefetchTtsModel(event.sender)
  })
}

