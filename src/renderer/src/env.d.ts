/// <reference types="vite/client" />

import type { PickedFile } from '../../shared/api.js'

declare global {
  interface Window {
    /** preload：页面监听就绪后请求主进程建数据面端口 */
    fridayRequestPort(): void
    fridayBridge: {
      pickAttachments(): Promise<PickedFile[]>
      registerDrop(file: File): Promise<PickedFile | null>
    }
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

export {}