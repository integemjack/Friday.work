// 输入框语音听写的实时引擎：friday-voice serve 的 /v1/realtime/transcribe WebSocket
// （协议与服务端 RealtimeVoice.cpp 同一份）——GPU(Vulkan) 上的 SenseVoice 边说边出字，
// FSMN-VAD 断句，每句由 Whisper large-v3-turbo 定稿（中英混说时认英文词）。
// 与 CosyVoice3 播报共用同一个 serve 进程（CosyVoiceService.ensureVoiceServe 单例）。
//
// IPC 面（渲染层 speechInput.ts 的实时分支）：
//   voice:rt-begin  (invoke) { lang? }  → 起 serve + 连 WS + 发 start；进度走 voice:model-progress
//   voice:rt-feed   (send)   ArrayBuffer 16 位小端 PCM 帧 → 原样转 WS 二进制
//   voice:rt-flush  (send)   正在说的这句马上定稿（松开麦/结束时用）
//   voice:rt-stop   (send)   结束本次会话（关 WS；serve 进程留给闲置策略处理）
//   voice:rt-event  (主→渲染) { type, segment?, text?, language?, emotion?, message? }
//     type = speech_start | partial | final | speech_end | error
//   voice:rt-status (invoke) → { supported, ready, serving }（菜单/设置用，模型没下全时
//     渲染层提示去选别的引擎；不在这里触发下载——begin 才下载，失败回落别的引擎）

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import WebSocket from 'ws'
import { dictationEngineState, ensureVoiceServe, touchVoiceServe } from './CosyVoiceService.js'

/** 菜单语言值 → friday-voice 的 language（auto|zh|en|yue|ja|ko，serve --help 同款枚举）。
 *  俄/法/德/西这些 SenseVoice 不支持的落 auto：实时字幕可能不出，但 Whisper 定稿
 *  自己认多语言，最终文字仍是对的——小语种要快还是选 Qwen3-ASR（菜单 note 里写了） */
const LANGS: Record<string, string> = {
  'zh-CN': 'zh',
  'zh-TW': 'zh',
  'en-US': 'en',
  'en-GB': 'en',
  'ja-JP': 'ja',
  'ko-KR': 'ko',
  mix: 'auto',
  auto: 'auto'
}

function mapLanguage(value: string | undefined): string {
  if (!value) return 'auto'
  if (LANGS[value]) return LANGS[value]
  // navigator.language 可能是 zh、zh-Hans-CN、en 这类变体：按主标签回退
  const prefix = value.split('-')[0]?.toLowerCase()
  if (prefix === 'zh') return 'zh'
  if (prefix === 'en') return 'en'
  if (prefix === 'ja') return 'ja'
  if (prefix === 'ko') return 'ko'
  return 'auto'
}

interface RtEvent {
  type: 'speech_start' | 'partial' | 'final' | 'speech_end' | 'error'
  segment?: number
  text?: string
  language?: string
  emotion?: string
  message?: string
}

/** 一次听写会话：一条到 serve 的 transcribe WS */
interface Session {
  ws: WebSocket
  /** 发起 begin 的渲染层（feed/flush/stop 只认它，别的窗口喂不进来） */
  sender: WebContents
  closed: boolean
}

let session: Session | null = null

function closeSession(): void {
  const current = session
  session = null
  if (!current) return
  current.closed = true
  try {
    current.ws.close()
  } catch {
    // 已断
  }
}

export function registerRealtimeDictationIpc(): void {
  ipcMain.handle('voice:rt-status', async () => dictationEngineState())

  ipcMain.handle('voice:rt-begin', async (event: IpcMainInvokeEvent, payload: { lang?: string }): Promise<void> => {
    // 上一路没关干净（渲染层崩溃等）：先关，一路只留一条 WS
    closeSession()
    const server = await ensureVoiceServe(event.sender, { forDictation: true, progress: 'voice:model-progress' })
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${server.wsUrl}/v1/realtime/transcribe?token=${server.token}`)
      const fail = (error: Error) => {
        try {
          ws.close()
        } catch {
          // 已断
        }
        reject(error)
      }
      const timer = setTimeout(() => fail(new Error('连接语音引擎超时')), 30_000)
      ws.on('error', (error) => {
        clearTimeout(timer)
        fail(new Error(`连不上语音引擎：${String((error as Error).message ?? error)}`))
      })
      ws.on('close', () => {
        clearTimeout(timer)
        // 握手阶段被关（引擎退出等）：还没 resolve 就是失败
        fail(new Error('语音引擎连接已关闭'))
      })
      ws.on('message', (data: Buffer | ArrayBuffer, isBinary: boolean) => {
        if (isBinary) return
        let message: { type?: string }
        try {
          message = JSON.parse(String(data))
        } catch {
          return
        }
        if (message.type !== 'ready') return
        clearTimeout(timer)
        const next: Session = { ws, sender: event.sender, closed: false }
        // 握手监听换成长连接监听（close 的 fail 语义只属于握手期）
        ws.removeAllListeners('message')
        ws.removeAllListeners('close')
        ws.removeAllListeners('error')
        ws.on('message', (data: Buffer | ArrayBuffer, isBinary: boolean) => {
          if (isBinary || next.closed) return
          let rtEvent: RtEvent
          try {
            rtEvent = JSON.parse(String(data)) as RtEvent
          } catch {
            return
          }
          if (rtEvent.type === 'speech_start' || rtEvent.type === 'partial' || rtEvent.type === 'final' || rtEvent.type === 'speech_end') {
            touchVoiceServe() // 出字说明在用：别让闲置策略把引擎停了
            try {
              next.sender.send('voice:rt-event', rtEvent)
            } catch {
              // 窗口已关
            }
          } else if (rtEvent.type === 'error') {
            try {
              next.sender.send('voice:rt-event', { type: 'error', message: rtEvent.message ?? '语音引擎听写出错' })
            } catch {
              // 窗口已关
            }
          }
        })
        ws.on('close', () => {
          if (session === next) session = null
          if (!next.closed) {
            try {
              next.sender.send('voice:rt-event', { type: 'error', message: '和语音引擎的连接断了' })
            } catch {
              // 窗口已关
            }
          }
        })
        ws.on('error', () => {
          /* close 会跟着来，那里统一报 */
        })
        session = next
        // 与服务端 RealtimeTranscriber::start 同一套参数：450ms 静音断句、开实时字幕
        ws.send(
          JSON.stringify({
            type: 'start',
            sample_rate: 16000,
            language: mapLanguage(payload.lang),
            end_silence_ms: 450,
            partials: true,
            speaker: false
          })
        )
        resolve()
      })
    })
  })

  ipcMain.on('voice:rt-feed', (event, chunk: ArrayBuffer) => {
    const current = session
    if (!current || current.sender.id !== event.sender.id) return
    if (current.ws.readyState !== WebSocket.OPEN) return
    touchVoiceServe()
    current.ws.send(Buffer.from(new Uint8Array(chunk)))
  })

  ipcMain.on('voice:rt-flush', (event) => {
    const current = session
    if (!current || current.sender.id !== event.sender.id) return
    if (current.ws.readyState === WebSocket.OPEN) current.ws.send(JSON.stringify({ type: 'flush' }))
  })

  ipcMain.on('voice:rt-stop', (event) => {
    const current = session
    if (!current || current.sender.id !== event.sender.id) return
    closeSession()
  })
}

/** 主进程退出前收尾（Electron 退出自然断 WS；这里只清引用） */
export function shutdownRealtimeDictation(): void {
  closeSession()
}
