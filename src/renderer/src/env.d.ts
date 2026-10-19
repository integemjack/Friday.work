/// <reference types="vite/client" />

import type { PickedFile } from '../../shared/api.js'

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
      /** 点通知回会话 */
      onOpenConversation(listener: (conversationID: string) => void): () => void
    }
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

export {}