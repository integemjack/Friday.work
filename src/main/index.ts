// 主进程入口：窗口、单实例、安全边界、生命周期（方案 §3/§7.2）。
// 主进程 = 窗口、凭据、安全边界；网络 I/O 全在协议进程（utilityProcess）。
// 数据面端口由渲染进程加载完成后主动请求（preload: friday-request-port）。

import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { CredentialStore } from './CredentialStore.js'
import { ProtocolHost as ProtocolProcessHost } from './protocolHost.js'
import { IpcBridge } from './ipc/bridge.js'

// 单实例：第二个实例把参数交给开着的那个后退出
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

const credentialStore = new CredentialStore()
const protocolProcessHost = new ProtocolProcessHost(credentialStore, (handle) => resolveHandle(handle))

// 句柄 → 路径（IpcBridge 登记，协议进程解析）
const handleTable = new Map<string, string>()
function resolveHandle(handle: string): string | null {
  return handleTable.get(handle) ?? null
}

let bridge: IpcBridge | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Friday',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f6f6f7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

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
  protocolProcessHost.start()
  bridge = new IpcBridge(protocolProcessHost)
  bridge.register()
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
