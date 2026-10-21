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
      onVoiceModelProgress(
        listener: (state: { phase: 'downloading' | 'loading' | 'ready'; percent?: number; detail?: string }) => void
      ): () => void
      /** 助手回复语音播报（本地 kokoro TTS）：主进程合成返回采样（渲染层 WebAudio 播放）；首次使用自动下载模型 */
      speakReply(payload: { text: string; sid: number; speed: number }): Promise<{ samples: Float32Array; sampleRate: number }>
      /** 只触发 TTS 模型下载/加载（设置里的「立即下载」） */
      prefetchTtsModel(): void
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