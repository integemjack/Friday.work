// 主进程入口：窗口、单实例、安全边界、生命周期（方案 §3/§7.2）。
// 主进程 = 窗口、凭据、安全边界；网络 I/O 全在协议进程（utilityProcess）。
// 数据面端口由渲染进程加载完成后主动请求（preload: friday-request-port）。

import { app, BrowserWindow, Menu, nativeTheme, session, shell } from 'electron'
import { join } from 'node:path'
import { ClientUpdate } from './ClientUpdate.js'
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

// 客户端自动更新：状态推给渲染层（设置窗口），退出时接手静默安装（仅 Windows）
const updater = new ClientUpdate(() => mainWindow?.webContents ?? null)

function createWindow(): void {
  // 贾维斯风：去掉系统边框和默认英文菜单，标题栏由应用自己画（TitleBar.vue，带拖拽区和窗控钮）
  Menu.setApplicationMenu(null)
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Friday',
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

  protocolProcessHost.start()
  bridge = new IpcBridge(protocolProcessHost, () => mainWindow)
  bridge.register()
  updater.register()
  updater.spawnInstallerOnQuit()
  updater.autoCheck()
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
