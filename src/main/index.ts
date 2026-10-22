// 主进程入口：窗口、单实例、安全边界、生命周期（方案 §3/§7.2）。
// 主进程 = 窗口、凭据、安全边界；网络 I/O 全在协议进程（utilityProcess）。
// 数据面端口由渲染进程加载完成后主动请求（preload: friday-request-port）。

import { app, BrowserWindow, Menu, nativeTheme, protocol, screen, session, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerDictationIpc } from './Dictation.js'
import { registerRealtimeDictationIpc } from './RealtimeDictation.js'
import { registerTtsIpc } from './TtsService.js'
import { registerCosyVoiceIpc } from './CosyVoiceService.js'
import { ClientUpdate } from './ClientUpdate.js'
import { CredentialStore } from './CredentialStore.js'
import { handleMediaStackRequest } from './MediaStack.js'
import { ProtocolHost as ProtocolProcessHost } from './protocolHost.js'
import { IpcBridge } from './ipc/bridge.js'

// 媒体叠本地缓存的供文件协议（friday-media://stack/<name>，只出 MediaStack 目录里的文件）：
// 必须在 app ready 前注册为特权 scheme，<img>/<video> 才能直接引
protocol.registerSchemesAsPrivileged([
  { scheme: 'friday-media', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

// 单实例：第二个实例把参数交给开着的那个后退出
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

// 主窗口大小/位置/最大化持久化（用户要求：记住重启前状态，重启后原样恢复——
// 含自动更新静默安装 + --force-run 拉起重启的场景）。存 userData/window-state.json，
// 动/缩/最大化后防抖落盘，close 时同步兜底写一次（updater 退出路径也走得到）。
const WINDOW_MIN_W = 960
const WINDOW_MIN_H = 600

interface MainWindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

function windowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

/** 读上次的状态；坐标不在任何显示器工作区上（拔了显示器/挪过桌面布局）就当没有 */
function loadWindowState(): MainWindowState | null {
  try {
    const raw = JSON.parse(readFileSync(windowStatePath(), 'utf8')) as Partial<MainWindowState>
    const state: MainWindowState = {
      x: Math.round(Number(raw.x)),
      y: Math.round(Number(raw.y)),
      width: Math.round(Number(raw.width)),
      height: Math.round(Number(raw.height)),
      maximized: raw.maximized === true
    }
    for (const value of [state.x, state.y, state.width, state.height]) {
      if (!Number.isFinite(value)) return null
    }
    state.width = Math.min(Math.max(state.width, WINDOW_MIN_W), 8192)
    state.height = Math.min(Math.max(state.height, WINDOW_MIN_H), 8192)
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea
      // 至少留 60px 边缘在屏内：拖到角落、藏一半在屏外的都算有效，完全不在屏上的不算
      return (
        state.x < area.x + area.width - 60 &&
        state.x + state.width > area.x + 60 &&
        state.y < area.y + area.height - 60 &&
        state.y + state.height > area.y + 60
      )
    })
    return visible ? state : null
  } catch {
    return null
  }
}

let lastWindowState: MainWindowState | null = null
let saveWindowStateTimer: NodeJS.Timeout | null = null

function persistWindowState(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) return // 最小化时的 bounds 不可用，别把好的覆盖掉
  try {
    // 最大化时存的是还原尺寸（getNormalBounds）：重启后先按原尺寸建窗再 maximize，取消最大化后不变样
    const bounds = win.getNormalBounds()
    lastWindowState = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      maximized: win.isMaximized()
    }
    writeFileSync(windowStatePath(), JSON.stringify(lastWindowState))
  } catch {
    // 存不下就算了
  }
}

function schedulePersistWindowState(): void {
  if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer)
  saveWindowStateTimer = setTimeout(() => {
    saveWindowStateTimer = null
    persistWindowState()
  }, 500)
}

const credentialStore = new CredentialStore()
const protocolProcessHost = new ProtocolProcessHost(credentialStore, (handle) => resolveHandle(handle))

// 句柄 → 路径（IpcBridge 登记，协议进程解析）
const handleTable = new Map<string, string>()
function resolveHandle(handle: string): string | null {
  return handleTable.get(handle) ?? null
}

let bridge: IpcBridge | null = null

// 客户端自动更新：状态推给渲染层（设置窗口），退出时接手静默安装（仅 Windows）
const updater = new ClientUpdate(() => mainWindow?.webContents ?? null)

function createWindow(): void {
  // 贾维斯风：去掉系统边框和默认英文菜单，标题栏由应用自己画（TitleBar.vue，带拖拽区和窗控钮）
  Menu.setApplicationMenu(null)
  const saved = lastWindowState ?? loadWindowState()
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    x: saved?.x,
    y: saved?.y,
    minWidth: WINDOW_MIN_W,
    minHeight: WINDOW_MIN_H,
    show: false,
    title: 'Friday',
    icon: join(__dirname, '../../resources/icon.png'),
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f6f6f7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  // 上次是最大化：建完窗直接补最大化（show 前做，用户看不到跳变）
  if (saved?.maximized) mainWindow.maximize()

  // 大小/位置/最大化状态：变了防抖落盘，关窗时同步兜底写一次（下次重启原样恢复）
  mainWindow.on('resize', schedulePersistWindowState)
  mainWindow.on('move', schedulePersistWindowState)
  mainWindow.on('maximize', schedulePersistWindowState)
  mainWindow.on('unmaximize', schedulePersistWindowState)
  mainWindow.on('close', persistWindowState)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 麦克风只给本应用页面（方案 §11 风险对策）
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })

  // 媒体叠本地缓存：看图/看视频归档的文件落在本机，这个协议供 <img>/<video> 直接加载
  // （支持 Range，视频可拖进度）；必须在建窗口前接好
  protocol.handle('friday-media', (request) => handleMediaStackRequest(request))

  protocolProcessHost.start()
  bridge = new IpcBridge(protocolProcessHost, () => mainWindow)
  bridge.register()
  // 输入框语音听写：SenseVoice（主力）/ whisper（混合与多语言）按语言+菜单选择路由；
  // 「GPU 实时」引擎（friday-voice，边说边出字 + Whisper 定稿）走流式链路 RealtimeDictation
  registerDictationIpc()
  registerRealtimeDictationIpc()
  // 助手回复语音播报：kokoro v1.1（CPU、103 音色）+ CosyVoice3（本机 GPU、服务端同款模型）
  registerTtsIpc()
  registerCosyVoiceIpc()
  updater.register()
  updater.spawnInstallerOnQuit()
  updater.startAutoUpdate()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  protocolProcessHost.stop()
})
