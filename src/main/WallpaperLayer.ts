// 桌面背景层（混合模式）：把主窗口 SetParent 进 Windows 桌面的壁纸层（WorkerW，
// 位于桌面图标之下、静态壁纸之上）——Win+D /「显示桌面」不再把它收走，其它窗口永远浮在
// 它上面，整个应用成为桌面背景。机制与 Rainmeter / Lively Wallpaper / Wallpaper Engine 相同。
// 已知的系统限制：壁纸层窗口拿不到键盘焦点（shell 不把输入转发给桌面层，见 Lively wiki
// 「Web Guide IV : Interaction」），所以打字走 Ctrl+Alt+F 呼出的置顶输入浮层（真窗口，
// 永远可点可输入），提交后转给主窗口的常规提交路径（会话 / 和助手说）。
// 只挂主屏；explorer.exe 重启会重建 WorkerW，守护定时器发现挂接丢了会自动重挂。

import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import koffi from 'koffi'
import { THEME_BG } from '../shared/theme-tokens.js'

const user32 = koffi.load('user32.dll')
const FindWindowW = user32.func('intptr_t FindWindowW(const char16_t *, const char16_t *)')
const FindWindowExW = user32.func('intptr_t FindWindowExW(intptr_t, intptr_t, const char16_t *, const char16_t *)')
// 0x052C：让 explorer 把图标层（SHELLDLL_DefView）拆进一个顶层 WorkerW；幂等、无副作用，
// 壁纸软件的标准起手式。SMTO_NORMAL=2，1000ms 足够
const SendMessageTimeoutW = user32.func(
  'intptr_t SendMessageTimeoutW(intptr_t, uint32_t, uintptr_t, intptr_t, uint32_t, uint32_t, uintptr_t *)'
)
const SetParent = user32.func('intptr_t SetParent(intptr_t, intptr_t)')
const GetParent = user32.func('intptr_t GetParent(intptr_t)')
const EnumCb = koffi.proto('int32_t EnumCb(intptr_t, intptr_t)')
const EnumWindows = user32.func('int32_t EnumWindows(EnumCb *, intptr_t)')

/** 找壁纸层：枚举顶层窗口，图标层宿主（子窗口是 SHELLDLL_DefView 的那个）z 序后面的
 *  WorkerW 就是壁纸层；个别系统不拆 WorkerW 时退回 Progman。找不到桌面（无 explorer）返回 0n。 */
function findWallpaperLayer(): bigint {
  const progman = FindWindowW('Progman', null)
  if (progman === 0n) return 0n
  SendMessageTimeoutW(progman, 0x052c, 0n, 0n, 0x2, 1000, null)
  let worker = 0n
  const cb = koffi.register((hwnd: bigint) => {
    if (FindWindowExW(hwnd, 0n, 'SHELLDLL_DefView', null) !== 0n) {
      worker = FindWindowExW(0n, hwnd, 'WorkerW', null)
      return 0 // 找到了，停止枚举
    }
    return 1
  }, koffi.pointer(EnumCb))
  EnumWindows(cb, 0n)
  koffi.unregister(cb)
  return worker !== 0n ? worker : progman
}

/** Electron 窗口句柄（HWND）——getNativeWindowHandle 给的是 little-endian Buffer */
function hwndOf(win: BrowserWindow): bigint {
  return win.getNativeWindowHandle().readBigInt64LE()
}

const QUICK_INPUT_SIZE = { width: 680, height: 172 }

export class WallpaperLayer {
  private enabled = false
  private savedBounds: Electron.Rectangle | null = null
  private guard: NodeJS.Timeout | null = null
  private quick: BrowserWindow | null = null

  constructor(private getWin: () => BrowserWindow | null) {}

  /** 建窗后调用：上次开着桌面模式就在窗口就绪后挂进去 */
  init(): void {
    if (!this.loadEnabled()) return
    const attach = (): void => {
      const win = this.getWin()
      if (!win || win.isDestroyed()) return
      if (!this.enable()) {
        // 挂不上（explorer 没起 / 会话没有桌面）：别留在「存档开着但实际没挂」的假状态
        this.enabled = false
        this.persist()
        this.notify()
      }
    }
    const win = this.getWin()
    if (win && !win.isDestroyed()) {
      // 等渲染层起来再挂：挂接会让窗口突然变全屏，Vue 的自适应布局（会话列表/聊天栏/输入台）
      // 跟着重排，画面稳定后再切
      win.once('ready-to-show', () => setTimeout(attach, 400))
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** 挂进壁纸层。失败（找不到桌面层 / SetParent 被拒）返回 false，窗口保持原样 */
  enable(): boolean {
    const win = this.getWin()
    if (!win || win.isDestroyed()) return false
    if (this.enabled) return true
    const layer = findWallpaperLayer()
    if (layer === 0n) return false
    const hwnd = hwndOf(win)
    if (SetParent(hwnd, layer) === 0n) return false
    this.savedBounds = win.getNormalBounds()
    win.setSkipTaskbar(true)
    win.setResizable(false)
    // 铺满主屏整面（bounds 而非 workArea：连任务栏区域一起盖住，才是「桌面」）
    win.setBounds(screen.getPrimaryDisplay().bounds)
    this.enabled = true
    this.persist()
    this.startGuard()
    this.registerShortcut()
    this.notify()
    return true
  }

  /** 摘下来回到普通窗口：恢复任务栏、尺寸可调、原位置 */
  disable(): void {
    const win = this.getWin()
    if (this.enabled && win && !win.isDestroyed()) {
      SetParent(hwndOf(win), 0n)
      win.setSkipTaskbar(false)
      win.setResizable(true)
      if (this.savedBounds) win.setBounds(this.savedBounds)
      win.focus()
    }
    this.enabled = false
    this.savedBounds = null
    this.persist()
    this.stopGuard()
    this.unregisterShortcut()
    this.notify()
  }

  /** 壁纸层点击/键盘受限场景下的保底退出：输入浮层上的按钮走到这里 */
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

  /** 状态变化推给渲染层（TitleBar 窗控、设置页开关） */
  private notify(): void {
    const win = this.getWin()
    if (win && !win.isDestroyed()) win.webContents.send('wallpaper:state', this.enabled)
  }

  /** explorer 重启（崩溃/手动重启任务管理器）会重建 WorkerW，挂接随之失效：发现丢了重挂 */
  private startGuard(): void {
    this.stopGuard()
    this.guard = setInterval(() => {
      const win = this.getWin()
      if (!win || win.isDestroyed()) {
        this.stopGuard()
        return
      }
      if (GetParent(hwndOf(win)) !== 0n) return // 还挂着
      const layer = findWallpaperLayer()
      if (layer === 0n) return // explorer 还没缓过来，下个周期再试
      if (SetParent(hwndOf(win), layer) === 0n) return
      win.setBounds(screen.getPrimaryDisplay().bounds)
    }, 3000)
  }

  private stopGuard(): void {
    if (this.guard) clearInterval(this.guard)
    this.guard = null
  }

  // MARK: 输入浮层（Ctrl+Alt+F）

  private static readonly SHORTCUT = 'Control+Alt+F'

  private registerShortcut(): void {
    try {
      globalShortcut.register(WallpaperLayer.SHORTCUT, () => this.toggleQuickInput())
    } catch {
      // 注册不上（被别的程序占了）：不致命，退出还有设置页 / 标题栏按钮两条路
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
    // 主屏底部中央（输入台的位置感），失焦即收
    const area = screen.getPrimaryDisplay().workArea
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
