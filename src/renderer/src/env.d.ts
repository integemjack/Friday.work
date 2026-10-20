/// <reference types="vite/client" />

import type { PickedFile } from '../../shared/api.js'
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
      /** 系统通知 */
      notify(payload: { title: string; body?: string; conversationID?: string }): void
      /** 界面主题底色（贾维斯深空蓝 / 跟随系统深浅） */
      setWindowBackground(color: string): void
      /** 无边框窗口的窗控钮 */
      winMinimize(): void
      winMaximizeToggle(): void
      winClose(): void
      /** 点通知回会话 */
      onOpenConversation(listener: (conversationID: string) => void): () => void
      /** 客户端更新（设置窗口展示；状态变化由主进程推送） */
      updateState(): Promise<UpdateState>
      updateCheck(): Promise<UpdateState>
      updateInstall(): Promise<UpdateState>
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