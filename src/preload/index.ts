// preload：只开一个最小的类型化 API 面（方案 §7.2/§7.3）。
// 数据面：主进程发来的 MessagePort 原样转进页面（高频事件不经过主进程）。
// 控制面：文件选择、拖放路径换出、语音片段落盘、系统通知。渲染进程始终接触不到 Node、令牌与凭据。

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PickedFile, SysStats } from '../shared/api.js'
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
  /** 客户端设备：最近一轮 navigator.serial.getPorts() 里各串口的 COM 名（主进程从设备许可回调里记的） */
  serialPortNames: (): Promise<Array<{ portName: string; displayName?: string; vendorId?: number; productId?: number }>> =>
    ipcRenderer.invoke('serial:port-names'),
  /** 客户端设备：UF2 盘（按住 BOOTSEL 插上的 Pico 等）、往里写 .uf2 */
  uf2Drives: (): Promise<Array<{ id: string; root: string; label: string; model: string; boardId: string }>> => ipcRenderer.invoke('uf2:list'),
  uf2Write: (root: string, bytes: Uint8Array): Promise<{ bytes: number; blocks: number }> => ipcRenderer.invoke('uf2:write', root, bytes),
  /** 客户端设备：跑白名单里的烧录 / 调试工具（渲染进程已经问过人） */
  toolRun: (request: {
    tool: string
    args: string[]
    files: Array<{ name: string; data: ArrayBuffer }>
    background: boolean
    timeoutMs: number
  }): Promise<{ exitCode?: number; output?: string; elapsedMs?: number; command: string; runId?: string }> =>
    ipcRenderer.invoke('tool:run', request),
  toolStop: (runId: string): Promise<boolean> => ipcRenderer.invoke('tool:stop', runId),
  onToolExited: (listener: (event: { runId: string; exitCode: number; output: string }) => void): (() => void) => {
    const handler = (_event: unknown, payload: { runId: string; exitCode: number; output: string }): void => listener(payload)
    ipcRenderer.on('tool:exited', handler)
    return () => ipcRenderer.removeListener('tool:exited', handler)
  },
  pickAttachments: (): Promise<PickedFile[]> => ipcRenderer.invoke('dialog:pick-attachments'),
  /** 拖放进来的 File：在 preload 里换出本机路径，主进程登记白名单后返回句柄 */
  registerDrop: (file: File): Promise<PickedFile | null> => {
    const path = webUtils.getPathForFile(file)
    return ipcRenderer.invoke('upload:register-drop', path)
  },
  /** 拖进文件管理器的文件 / 文件夹：换出本机路径，主进程展开成清单（每个文件一个上传句柄） */
  registerDropTree: (
    file: File
  ): Promise<{ name: string; files: Array<{ handle: string; rel: string; size: number }>; dirs: string[]; truncated: boolean } | null> => {
    const path = webUtils.getPathForFile(file)
    return ipcRenderer.invoke('upload:register-tree', path)
  },
  /** 一段录音（M3-A）：字节交给主进程落成临时文件、领句柄 */
  saveVoiceClip: (bytes: ArrayBuffer, mimeType: string): Promise<PickedFile | null> =>
    ipcRenderer.invoke('voice:save-clip', { bytes, mimeType }),
  /** 输入框语音听写（一次性）：16 kHz 单声道采样送 friday-voice 引擎转写
   *  （SenseVoice 出字 + Whisper 定稿，语言引擎内自动；首次使用会先下载模型，进度经 onVoiceModelProgress 推送） */
  transcribeVoice: (audio: Float32Array, lang?: string): Promise<{ text: string }> =>
    ipcRenderer.invoke('voice:transcribe', { audio, lang }),
  /** 实时听写（friday-voice 引擎，GPU）：begin 起 serve+连接并开始（首次会下载模型，进度走
   *  onVoiceModelProgress）；feed 喂 16 位小端 PCM16 帧；flush 把正在说的这句马上定稿；stop 结束。
   *  识别事件（边说边出字的 partial / 每句定稿的 final / 出错）经 onRtVoiceEvent 推送 */
  rtBeginVoice: (lang?: string): Promise<void> => ipcRenderer.invoke('voice:rt-begin', { lang }),
  rtFeedVoice: (chunk: ArrayBuffer): void => {
    ipcRenderer.send('voice:rt-feed', chunk)
  },
  rtFlushVoice: (): void => {
    ipcRenderer.send('voice:rt-flush')
  },
  rtStopVoice: (): void => {
    ipcRenderer.send('voice:rt-stop')
  },
  onRtVoiceEvent: (
    listener: (event: { type: 'speech_start' | 'partial' | 'final' | 'speech_end' | 'error'; segment?: number; text?: string; language?: string; emotion?: string; message?: string }) => void
  ): (() => void) => {
    const handler = (_event: unknown, state: Parameters<typeof listener>[0]): void => listener(state)
    ipcRenderer.on('voice:rt-event', handler)
    return () => ipcRenderer.removeListener('voice:rt-event', handler)
  },
  onVoiceModelProgress: (
    listener: (state: {
      phase: 'downloading' | 'loading' | 'ready'
      percent?: number
      detail?: string
      received?: number
      total?: number
    }) => void
  ): (() => void) => {
    const handler = (
      _event: unknown,
      state: {
        phase: 'downloading' | 'loading' | 'ready'
        percent?: number
        detail?: string
        received?: number
        total?: number
      }
    ): void => listener(state)
    ipcRenderer.on('voice:model-progress', handler)
    return () => ipcRenderer.removeListener('voice:model-progress', handler)
  },
  /** 助手回复语音播报：文本+音色送 friday-voice 引擎（CosyVoice3，本机 GPU）合成，
   *  返回采样和采样率（渲染层 WebAudio 播放）；首次使用会先下载（进度经 onTtsModelProgress 推） */
  speakReply: (
    payload: { text: string; speed?: number; voice?: string; instruction?: string }
  ): Promise<{ samples: Float32Array; sampleRate: number }> => ipcRenderer.invoke('voice:speak', payload),
  /** CosyVoice3 引擎状态：本机平台有无对应包、是否已下好、服务是否在跑、可用音色名 */
  cosyVoiceStatus: (): Promise<{ supported: boolean; installed: boolean; serving: boolean; voices: string[]; version: string }> =>
    ipcRenderer.invoke('voice:cv3-status'),
  /** 下载 / 启动语音引擎（约 1.2GB，进度走 onTtsModelProgress），不合成 */
  prefetchCosyVoice: (): Promise<void> => ipcRenderer.invoke('voice:cv3-prefetch'),
  /** 打断当前这句合成（不等它念完） */
  cancelCosyVoice: (): Promise<void> => ipcRenderer.invoke('voice:cv3-cancel'),
  /** 音色克隆（v0.5）：8~15 秒 16 kHz 录音 → 本地音色（首次会先下前端模型，进度走 onVoiceModelProgress）；
   *  没给 text 就用引擎听写当底稿；返回克隆名、底稿和用时 */
  cloneVoice: (payload: { name: string; audio: Float32Array; text?: string }): Promise<{ voice: string; transcript: string; seconds: number; took: number }> =>
    ipcRenderer.invoke('voice:clone', payload),
  /** 克隆能力：本机平台支持否、前端模型装了没、引擎在跑否 */
  cloneVoiceStatus: (): Promise<{ supported: boolean; installed: boolean; serving: boolean }> =>
    ipcRenderer.invoke('voice:clone-status'),
  /** 引擎音色列表（内置 + 用户克隆的） */
  listVoices: (): Promise<{ voices: string[]; user: string[]; clone: boolean; default: string }> =>
    ipcRenderer.invoke('voice:voices'),
  /** 删掉一个克隆音色（内置的引擎会拒绝） */
  deleteVoice: (name: string): Promise<void> => ipcRenderer.invoke('voice:delete-voice', name),
  /** 拖进来的音色 gguf（File）：在 preload 里换出本机路径（渲染进程接触不到），主进程复制进
   *  user-voices 持久化、重启引擎验证；返回成功导入的音色名和失败清单 */
  importVoiceFiles: (
    files: File[]
  ): Promise<{ imported: string[]; failed: { file: string; error: string }[] }> => {
    const paths = files.map((file) => webUtils.getPathForFile(file))
    return ipcRenderer.invoke('voice:import-voice', paths)
  },
  /** 点「选择文件」导入音色 gguf：主进程弹对话框并导入（路径不经过渲染层）；canceled = 没选 */
  pickVoiceFiles: (): Promise<{
    canceled: boolean
    imported: string[]
    failed: { file: string; error: string }[]
  }> => ipcRenderer.invoke('voice:import-picked'),
  onTtsModelProgress: (
    listener: (state: { phase: 'downloading' | 'extracting' | 'loading' | 'ready' | 'error'; percent?: number; detail?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: unknown,
      state: { phase: 'downloading' | 'extracting' | 'loading' | 'ready' | 'error'; percent?: number; detail?: string }
    ): void => listener(state)
    ipcRenderer.on('voice:tts-progress', handler)
    return () => ipcRenderer.removeListener('voice:tts-progress', handler)
  },
  /** 全屏桌面模式（主进程 WallpaperLayer）：状态 / 开关；变化经 onWallpaperState 推送。
   *  应用无边框铺满整屏（无窗全屏）——任务栏 / 桌面图标 / 其它窗口都在它上面 */
  wallpaperGetState: (): Promise<{ enabled: boolean }> => ipcRenderer.invoke('wallpaper:get-state'),
  wallpaperSetEnabled: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('wallpaper:set-enabled', enabled),
  onWallpaperState: (listener: (enabled: boolean) => void): (() => void) => {
    const handler = (_event: unknown, enabled: boolean): void => listener(enabled)
    ipcRenderer.on('wallpaper:state', handler)
    return () => ipcRenderer.removeListener('wallpaper:state', handler)
  },
  /** 全屏桌面模式的置顶输入浮层（?quick=1 小窗）用：提交 / 关闭 / 保底退出全屏桌面 */
  wallpaperQuickSubmit: (text: string): void => {
    ipcRenderer.send('wallpaper:quick-submit', text)
  },
  wallpaperQuickClose: (): void => {
    ipcRenderer.send('wallpaper:quick-close')
  },
  wallpaperExit: (): void => {
    ipcRenderer.send('wallpaper:exit')
  },
  /** 输入浮层提交的文本（主进程转来）：App.vue 走常规提交路径（会话 / 和助手说） */
  onQuickInput: (listener: (text: string) => void): (() => void) => {
    const handler = (_event: unknown, text: string): void => listener(text)
    ipcRenderer.on('wallpaper:quick-input', handler)
    return () => ipcRenderer.removeListener('wallpaper:quick-input', handler)
  },
  /** 媒体叠本地缓存：把一份媒体字节（或 http/data URL，主进程代下）落进 userData/MediaStack */
  saveStackMedia: (payload: { name: string; bytes?: ArrayBuffer; url?: string }): Promise<{ name: string } | null> =>
    ipcRenderer.invoke('media-stack:save', payload),
  /** 删掉一批缓存文件（清空一叠时连本地文件一起删） */
  deleteStackMedia: (names: string[]): Promise<number> => ipcRenderer.invoke('media-stack:delete', { names }),
  /** 列出已缓存的文件名（启动时回填注册表） */
  listStackMedia: (): Promise<string[]> => ipcRenderer.invoke('media-stack:list'),
  /** 本机系统资源（贾维斯 HUD 的远程遥测：当前连接的服务器就是本机时的 CPU/RAM/GPU/显存/进程数实测） */
  systemStats: (): Promise<SysStats> => ipcRenderer.invoke('sys:stats'),
  /** 本机探针文件路径（服务器上 fs.read 读得到 = 服务器就是本机）；null = 本机不提供探针 */
  selfProbePath: (): Promise<string | null> => ipcRenderer.invoke('sys:self-probe'),
  /** 文件管理器下载到本地：begin 弹保存 / 选文件夹对话框（取消返回 null），之后按会话 id 分块写；
   *  rel 是会话内的相对路径（单个文件模式不用），越界的主进程拒绝 */
  downloadBegin: (mode: 'file' | 'dir', suggestedName: string, count: number): Promise<{ id: string; target: string } | null> =>
    ipcRenderer.invoke('download:begin', { mode, suggestedName, count }),
  downloadWrite: (id: string, rel: string, offset: number, data: Uint8Array): Promise<boolean> =>
    ipcRenderer.invoke('download:write', { id, rel, offset, data }),
  downloadCloseFile: (id: string, rel: string): Promise<boolean> => ipcRenderer.invoke('download:close-file', { id, rel }),
  downloadMkdir: (id: string, rel: string): Promise<boolean> => ipcRenderer.invoke('download:mkdir', { id, rel }),
  downloadEnd: (id: string, ok: boolean): Promise<string | null> => ipcRenderer.invoke('download:end', { id, ok }),
  downloadReveal: (id: string): Promise<boolean> => ipcRenderer.invoke('download:reveal', { id }),
  /** 系统通知（attention / 任务跑完） */
  notify: (payload: { title: string; body?: string; conversationID?: string }): void => {
    ipcRenderer.send('notify:show', payload)
  },
  /** 界面主题底色：渲染层应用主题后同步给主进程（BrowserWindow 底色 CSS 管不到） */
  setWindowBackground: (color: string): void => {
    ipcRenderer.send('ui:background', color)
  },
  /** 有待答的 ask_user 问题时把窗口切到系统级置顶（浮层显示中永远最前），没了恢复 */
  setAskPinned: (pinned: boolean): void => {
    ipcRenderer.send('ui:ask-pinned', pinned)
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
