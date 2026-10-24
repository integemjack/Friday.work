// 全屏桌面模式（无窗全屏）：整个应用无边框铺满整屏——任务栏、桌面图标、其它窗口都在它
// 上面，体感上应用成了桌面背景。窗口本体还是普通窗口（有焦点时可正常打字、点按），
// 被别的窗口盖住时 Ctrl+Alt+F 呼出置顶输入条（真窗口、永远可点可输入），提交后转给
// 主窗口的常规提交路径（会话 / 和助手说）。
// 早期版本做过 WorkerW 壁纸层挂接（SetParent 到桌面图标之下，Win+D 不收走），真机体感
// 与全屏窗口无差、还引入 koffi FFI 依赖，按反馈简化成纯全屏；渲染层联动（标题栏不拖拽、
// 窗控换退出钮）与持久化（userData/desktop-mode.json）不变，IPC 通道沿用 wallpaper:*。

import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { THEME_BG } from '../shared/theme-tokens.js'

const QUICK_INPUT_SIZE = { width: 680, height: 172 }

export class WallpaperLayer {
  private enabled = false
  private savedBounds: Electron.Rectangle | null = null
  private quick: BrowserWindow | null = null

  constructor(private getWin: () => BrowserWindow | null) {}

  /** 建窗后调用：上次开着全屏桌面模式就在窗口就绪后进全屏 */
  init(): void {
    if (!this.loadEnabled()) return
    const attach = (): void => {
      const win = this.getWin()
      if (!win || win.isDestroyed()) return
      if (!this.enable()) {
        // 进不去全屏（窗口没了之类）：别留在「存档开着但实际没进」的假状态
        this.enabled = false
        this.persist()
        this.notify()
      }
    }
    const win = this.getWin()
    if (win && !win.isDestroyed()) {
      // 等渲染层起来再切：切全屏会让 Vue 的自适应布局（会话列表/聊天栏/输入台）跟着重排，
      // 画面稳定后再切；400ms 是经验值（首帧 + 布局稳定）
      win.once('ready-to-show', () => setTimeout(attach, 400))
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** 进全屏桌面：记住原窗口尺寸，无边框铺满窗口当前所在显示器的整面
   *  （bounds 而非 workArea：连任务栏区域一起盖住才是「桌面」，任务栏自己会浮在上面） */
  enable(): boolean {
    const win = this.getWin()
    if (!win || win.isDestroyed()) return false
    if (this.enabled) return true
    this.savedBounds = win.getNormalBounds()
    win.setResizable(false)
    win.setBounds(screen.getDisplayMatching(win.getBounds()).bounds)
    this.enabled = true
    this.persist()
    this.registerShortcut()
    this.notify()
    return true
  }

  /** 退出全屏桌面：恢复尺寸可调、原位置并聚焦 */
  disable(): void {
    const win = this.getWin()
    if (this.enabled && win && !win.isDestroyed()) {
      win.setResizable(true)
      if (this.savedBounds) win.setBounds(this.savedBounds)
      win.focus()
    }
    this.enabled = false
    this.savedBounds = null
    this.persist()
    this.unregisterShortcut()
    this.notify()
  }

  /** 输入条上的保底退出按钮走到这里 */
  exitFromQuickInput(): void {
    this.closeQuickInput()
    this.disable()
  }

  private statePath(): string {
    return join(app.getPath('userData'), 'desktop-mode.json')
  }

  private loadEnabled(): boolean {
    try {
      return (JSON.parse(readFileSync(this.statePath(), 'utf8')) as { enabled?: boolean }).enabled === true
    } catch {
      return false
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.statePath(), JSON.stringify({ enabled: this.enabled }))
    } catch {
      // 存不下就算了，本次会话内生效
    }
  }

  /** 状态变化推给渲染层（TitleBar 窗控 / 拖拽禁用、设置页开关） */
  private notify(): void {
    const win = this.getWin()
    if (win && !win.isDestroyed()) win.webContents.send('wallpaper:state', this.enabled)
  }

  // MARK: 输入浮层（Ctrl+Alt+F）——全屏窗口被别的窗口盖住时的快速输入

  private static readonly SHORTCUT = 'Control+Alt+F'

  private registerShortcut(): void {
    try {
      globalShortcut.register(WallpaperLayer.SHORTCUT, () => this.toggleQuickInput())
    } catch {
      // 注册不上（被别的程序占了）：不致命，点回应用窗口也能正常输入
    }
  }

  private unregisterShortcut(): void {
    try {
      globalShortcut.unregister(WallpaperLayer.SHORTCUT)
    } catch {
      // 没注册过就注销，忽略
    }
  }

  private toggleQuickInput(): void {
    if (this.quick && !this.quick.isDestroyed()) {
      this.quick.close()
      return
    }
    const quick = new BrowserWindow({
      ...QUICK_INPUT_SIZE,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: THEME_BG.jarvis,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })
    // 主窗口所在显示器的工作区底部中央（输入台的位置感），失焦即收
    const main = this.getWin()
    const area = (main && !main.isDestroyed()
      ? screen.getDisplayMatching(main.getBounds())
      : screen.getPrimaryDisplay()
    ).workArea
    quick.setPosition(
      Math.round(area.x + (area.width - QUICK_INPUT_SIZE.width) / 2),
      area.y + area.height - QUICK_INPUT_SIZE.height - 16
    )
    quick.on('blur', () => {
      if (!quick.isDestroyed()) quick.close()
    })
    quick.on('closed', () => {
      if (this.quick === quick) this.quick = null
    })
    quick.once('ready-to-show', () => quick.show())
    if (process.env.ELECTRON_RENDERER_URL) {
      void quick.loadURL(`${process.env.ELECTRON_RENDERER_URL}?quick=1`)
    } else {
      void quick.loadFile(join(__dirname, '../renderer/index.html'), { query: { quick: '1' } })
    }
    this.quick = quick
  }

  private closeQuickInput(): void {
    if (this.quick && !this.quick.isDestroyed()) this.quick.close()
    this.quick = null
  }

  // MARK: IPC（preload → 渲染层设置页 / 输入浮层）

  registerIpc(): void {
    ipcMain.handle('wallpaper:get-state', () => ({ enabled: this.enabled }))
    ipcMain.handle('wallpaper:set-enabled', (_event, enabled: unknown) => {
      if (enabled === true) return this.enable()
      if (enabled === false) {
        this.disable()
        return true
      }
      return false
    })
    // 输入浮层：提交 → 关浮层 → 转给主窗口的常规提交路径（App.vue 的 onComposerSubmit）
    ipcMain.on('wallpaper:quick-submit', (_event, text: unknown) => {
      if (typeof text !== 'string' || !text.trim()) return
      this.closeQuickInput()
      const win = this.getWin()
      if (win && !win.isDestroyed()) win.webContents.send('wallpaper:quick-input', text)
    })
    ipcMain.on('wallpaper:quick-close', () => this.closeQuickInput())
    ipcMain.on('wallpaper:exit', () => this.exitFromQuickInput())
  }
}
