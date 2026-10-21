// preload：只开一个最小的类型化 API 面（方案 §7.2/§7.3）。
// 数据面：主进程发来的 MessagePort 原样转进页面（高频事件不经过主进程）。
// 控制面：文件选择、拖放路径换出、语音片段落盘、系统通知。渲染进程始终接触不到 Node、令牌与凭据。

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PickedFile } from '../shared/api.js'
import type { UpdateState } from '../shared/update.js'

// 数据面端口：页面加载完成后请求主进程建一对，主进程把 port1 发来，这里转给主世界
ipcRenderer.on('friday-port', (event) => {
  // MessagePort 是转移对象，经 postMessage 转进主世界
  window.postMessage('friday-port', '*', event.ports)
})

// 等页面监听就绪后再请求端口（页面先挂好 message 监听，再调这个）
contextBridge.exposeInMainWorld('fridayRequestPort', () => {
  ipcRenderer.send('friday-request-port')
})

contextBridge.exposeInMainWorld('fridayBridge', {
  pickAttachments: (): Promise<PickedFile[]> => ipcRenderer.invoke('dialog:pick-attachments'),
  /** 拖放进来的 File：在 preload 里换出本机路径，主进程登记白名单后返回句柄 */
  registerDrop: (file: File): Promise<PickedFile | null> => {
    const path = webUtils.getPathForFile(file)
    return ipcRenderer.invoke('upload:register-drop', path)
  },
  /** 一段录音（M3-A）：字节交给主进程落成临时文件、领句柄 */
  saveVoiceClip: (bytes: ArrayBuffer, mimeType: string): Promise<PickedFile | null> =>
    ipcRenderer.invoke('voice:save-clip', { bytes, mimeType }),
  /** 媒体叠本地缓存：把一份媒体字节（或 http/data URL，主进程代下）落进 userData/MediaStack */
  saveStackMedia: (payload: { name: string; bytes?: ArrayBuffer; url?: string }): Promise<{ name: string } | null> =>
    ipcRenderer.invoke('media-stack:save', payload),
  /** 删掉一批缓存文件（清空一叠时连本地文件一起删） */
  deleteStackMedia: (names: string[]): Promise<number> => ipcRenderer.invoke('media-stack:delete', { names }),
  /** 列出已缓存的文件名（启动时回填注册表） */
  listStackMedia: (): Promise<string[]> => ipcRenderer.invoke('media-stack:list'),
  /** 系统通知（attention / 任务跑完） */
  notify: (payload: { title: string; body?: string; conversationID?: string }): void => {
    ipcRenderer.send('notify:show', payload)
  },
  /** 界面主题底色：渲染层应用主题后同步给主进程（BrowserWindow 底色 CSS 管不到） */
  setWindowBackground: (color: string): void => {
    ipcRenderer.send('ui:background', color)
  },
  /** 无边框窗口的窗控钮 */
  winMinimize: (): void => {
    ipcRenderer.send('win:minimize')
  },
  winMaximizeToggle: (): void => {
    ipcRenderer.send('win:maximize-toggle')
  },
  winClose: (): void => {
    ipcRenderer.send('win:close')
  },
  /** 点系统通知回到对应会话 */
  onOpenConversation: (listener: (conversationID: string) => void): (() => void) => {
    const handler = (_event: unknown, conversationID: string): void => listener(conversationID)
    ipcRenderer.on('friday-open-conversation', handler)
    return () => ipcRenderer.removeListener('friday-open-conversation', handler)
  },
  /** 客户端更新：拉当前状态 / 手动检查 / 下载并装；自动管线的重启可推迟/立即执行（状态变化经 onUpdateState 推送） */
  updateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),
  updateCheck: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  updateInstall: (): Promise<UpdateState> => ipcRenderer.invoke('update:install'),
  updatePostpone: (): Promise<UpdateState> => ipcRenderer.invoke('update:postpone'),
  updateApply: (): Promise<UpdateState> => ipcRenderer.invoke('update:apply'),
  onUpdateState: (listener: (state: UpdateState) => void): (() => void) => {
    const handler = (_event: unknown, state: UpdateState): void => listener(state)
    ipcRenderer.on('update:state', handler)
    return () => ipcRenderer.removeListener('update:state', handler)
  }
})

export type { PickedFile }
