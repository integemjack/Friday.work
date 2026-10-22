/// <reference types="vite/client" />

import type { PickedFile, SysStats } from '../../shared/api.js'
import type { UpdateState } from '../../shared/update.js'

declare global {
  interface Window {
    /** preload：页面监听就绪后请求主进程建数据面端口 */
    fridayRequestPort(): void
    fridayBridge: {
      pickAttachments(): Promise<PickedFile[]>
      registerDrop(file: File): Promise<PickedFile | null>
      /** 一段录音交给主进程落盘（M3-A） */
      saveVoiceClip(bytes: ArrayBuffer, mimeType: string): Promise<PickedFile | null>
      /** 输入框语音听写：16 kHz 单声道采样送主进程本地模型转写（SenseVoice/whisper），返回文字 */
      transcribeVoice(audio: Float32Array, lang?: string, model?: string): Promise<{ text: string }>
      /** 实时听写（friday-voice 引擎，GPU）：begin 起 serve+连接（首次下载进度走 onVoiceModelProgress），
       *  feed 喂 16 位小端 PCM16 帧，flush 定稿当前句，stop 结束；识别事件经 onRtVoiceEvent 推送 */
      rtBeginVoice(lang?: string): Promise<void>
      rtFeedVoice(chunk: ArrayBuffer): void
      rtFlushVoice(): void
      rtStopVoice(): void
      onRtVoiceEvent(
        listener: (
          event: {
            type: 'speech_start' | 'partial' | 'final' | 'speech_end' | 'error'
            segment?: number
            text?: string
            language?: string
            emotion?: string
            message?: string
          }
        ) => void
      ): () => void
      onVoiceModelProgress(
        listener: (state: {
          phase: 'downloading' | 'loading' | 'ready'
          percent?: number
          detail?: string
          received?: number
          total?: number
        }) => void
      ): () => void
      /** 助手回复语音播报：主进程合成返回采样（渲染层 WebAudio 播放）；
       *  engine 缺省 = kokoro（CPU），'cosyvoice3' = 本机 GPU、服务端同款模型 */
      speakReply(payload: {
        text: string
        speed: number
        sid?: number
        engine?: 'kokoro' | 'cosyvoice3'
        voice?: string
        instruction?: string
      }): Promise<{ samples: Float32Array; sampleRate: number }>
      /** 只触发 TTS 模型下载/加载（设置里的「立即下载」） */
      prefetchTtsModel(): void
      /** CosyVoice3 引擎状态（支持/已装/在跑/音色名） */
      cosyVoiceStatus(): Promise<{ supported: boolean; installed: boolean; serving: boolean; voices: string[]; version: string }>
      /** 下载 / 启动 CosyVoice3 引擎（约 1.2GB，进度走 onTtsModelProgress） */
      prefetchCosyVoice(): Promise<void>
      /** 打断当前这句合成 */
      cancelCosyVoice(): Promise<void>
      onTtsModelProgress(
        listener: (
          state: { phase: 'downloading' | 'extracting' | 'loading' | 'ready' | 'error'; percent?: number; detail?: string }
        ) => void
      ): () => void
      /** 媒体叠本地缓存：媒体字节（或 http/data URL，主进程代下）落进 userData/MediaStack，
       *  文件名按「会话:类型:媒体源」确定性算出，供 friday-media:// 协议加载 */
      saveStackMedia(payload: { name: string; bytes?: ArrayBuffer; url?: string }): Promise<{ name: string } | null>
      /** 删掉一批缓存文件（清空一叠时连本地文件一起删） */
      deleteStackMedia(names: string[]): Promise<number>
      /** 列出已缓存的文件名（启动时回填注册表） */
      listStackMedia(): Promise<string[]>
      /** 本机系统资源（贾维斯 HUD 的远程遥测：当前连接的服务器就是本机时的 CPU/RAM/GPU/显存/进程数实测） */
      systemStats(): Promise<SysStats>
      /** 系统通知 */
      notify(payload: { title: string; body?: string; conversationID?: string }): void
      /** 界面主题底色（贾维斯深空蓝 / 跟随系统深浅） */
      setWindowBackground(color: string): void
      /** 有待答的 ask_user 问题时窗口切到系统级置顶（提问浮层显示中永远最前），没了恢复 */
      setAskPinned(pinned: boolean): void
      /** 无边框窗口的窗控钮 */
      winMinimize(): void
      winMaximizeToggle(): void
      winClose(): void
      /** 点通知回会话 */
      onOpenConversation(listener: (conversationID: string) => void): () => void
      /** 客户端更新（设置窗口 + 桌面浮层展示；状态变化由主进程推送） */
      updateState(): Promise<UpdateState>
      updateCheck(): Promise<UpdateState>
      updateInstall(): Promise<UpdateState>
      /** 推迟自动重启（回到退出时静默安装） */
      updatePostpone(): Promise<UpdateState>
      /** 立即安装并重启 */
      updateApply(): Promise<UpdateState>
      onUpdateState(listener: (state: UpdateState) => void): () => void
    }
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

export {}