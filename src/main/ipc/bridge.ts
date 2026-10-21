// 主进程的 IPC 桥：附件文件对话框、拖放路径登记、端口分发（方案 §7.3）。
// 上传不接受渲染进程传来的任意本机路径：只认对话框选中的、或拖放进来的 File
// （preload 用 webUtils 换出路径），协议进程只能读这里背书过的路径。

import { app, BrowserWindow, dialog, ipcMain, Notification, type FileFilter, type WebContents } from 'electron'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deleteStackMediaFiles, isValidStackMediaName, listStackMediaFiles, saveStackMediaFile } from '../MediaStack.js'
import { registerSysStatsIpc } from './SysStats.js'

export interface PickedFile {
  handle: string
  name: string
  size: number
}

export class IpcBridge {
  private readonly handles = new Map<string, string>()

  constructor(
    private readonly protocolHost: { providePort(webContents: WebContents): void },
    private readonly getWindow: () => Electron.BrowserWindow | null = () => null
  ) {}

  private async registerPath(path: string): Promise<PickedFile | null> {
    try {
      const info = await stat(path)
      if (!info.isFile()) return null
      const handle = randomUUID()
      this.handles.set(handle, path)
      return { handle, name: path.split(/[\\/]/).pop() ?? path, size: Number(info.size) }
    } catch {
      return null
    }
  }

  register(): void {
    // 本机系统资源（贾维斯 HUD 的远程遥测：当前连接的服务器就是本机时的 CPU/RAM/GPU/显存/进程数）
    registerSysStatsIpc()

    ipcMain.on('friday-request-port', (event) => {
      this.protocolHost.providePort(event.sender)
    })

    ipcMain.handle('dialog:pick-attachments', async (): Promise<PickedFile[]> => {
      const filters: FileFilter[] = [{ name: '全部文件', extensions: ['*'] }]
      const result = await dialog.showOpenDialog({
        title: '选择要发送的附件',
        properties: ['openFile', 'multiSelections'],
        filters
      })
      if (result.canceled) return []
      const picked: PickedFile[] = []
      for (const path of result.filePaths) {
        const file = await this.registerPath(path)
        if (file) picked.push(file)
      }
      return picked
    })

    // 拖放的 File：preload 用 webUtils.getPathForFile 换出路径（渲染进程接触不到 Node）
    ipcMain.handle('upload:register-drop', async (_event, path: unknown): Promise<PickedFile | null> => {
      if (typeof path !== 'string' || !path) return null
      return this.registerPath(path)
    })

    // 语音（M3-A）：渲染进程录好的一段音频字节落成临时文件、领一个句柄（路径由主进程决定，不信任渲染进程）
    ipcMain.handle('voice:save-clip', async (_event, payload: unknown): Promise<PickedFile | null> => {
      const input = payload as { bytes?: ArrayBuffer | Uint8Array; mimeType?: string } | null
      if (!input?.bytes) return null
      const bytes = Buffer.from(input.bytes as ArrayBuffer)
      if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) return null
      const ext = /ogg/.test(input.mimeType ?? '')
        ? 'ogg'
        : /mp4|m4a/.test(input.mimeType ?? '')
          ? 'm4a'
          : /wav/.test(input.mimeType ?? '')
            ? 'wav'
            : 'webm'
      const dir = join(app.getPath('temp'), 'friday-voice')
      await mkdir(dir, { recursive: true })
      const path = join(dir, `voice-${Date.now()}.${ext}`)
      await writeFile(path, bytes)
      return this.registerPath(path)
    })

    // 媒体叠本地缓存（看图/看视频归档时把文件落一份在本机，会话结束/重启后仍能看）：
    //   save   渲染层传字节（远端 fs.read / data: URL 解出来的），或给 URL 主进程代下（渲染层有 CORS）
    //   list   启动时回填「已缓存文件名」注册表
    //   delete 清空一叠时把缓存文件一起删掉
    // 文件名由渲染层确定性算出，MediaStack 里按白名单校验，不认任何路径
    ipcMain.handle('media-stack:save', async (_event, payload: unknown): Promise<{ name: string } | null> => {
      const input = payload as { name?: string; bytes?: Uint8Array | ArrayBuffer; url?: string } | null
      if (!input || !isValidStackMediaName(input.name)) return null
      const saved = await saveStackMediaFile(input.name, { bytes: input.bytes, url: input.url })
      return saved ? { name: saved } : null
    })

    ipcMain.handle('media-stack:delete', async (_event, payload: unknown): Promise<number> => {
      return deleteStackMediaFiles((payload as { names?: unknown } | null)?.names)
    })

    ipcMain.handle('media-stack:list', async (): Promise<string[]> => listStackMediaFiles())

    // 系统通知（attention、任务跑完这类）：点通知回到对应会话
    ipcMain.on('notify:show', (_event, payload: unknown) => {
      const input = payload as { title?: string; body?: string; conversationID?: string } | null
      if (!input?.title) return
      if (!Notification.isSupported()) return
      const notification = new Notification({ title: input.title, body: input.body ?? '' })
      notification.on('click', () => {
        const window = this.getWindow()
        if (!window) return
        if (window.isMinimized()) window.restore()
        window.focus()
        if (input.conversationID) {
          window.webContents.send('friday-open-conversation', input.conversationID)
        }
      })
      notification.show()
    })

    // 界面主题底色（贾维斯深空蓝 / 跟随系统）：渲染层应用主题时报过来，避免窗口底色和页面不一致
    ipcMain.on('ui:background', (_event, color: unknown) => {
      if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return
      this.getWindow()?.setBackgroundColor(color)
    })

    // 有待答的 ask_user：窗口切到系统级置顶（提问浮层显示中永远最前，压过其他应用），没了恢复
    ipcMain.on('ui:ask-pinned', (_event, pinned: unknown) => {
      this.getWindow()?.setAlwaysOnTop(pinned === true, 'screen-saver')
    })

    // 无边框窗口的窗控钮（TitleBar.vue）：最小化 / 最大化切换 / 关闭
    ipcMain.on('win:minimize', (event) => {
      BrowserWindow.fromWebContents(event.sender)?.minimize()
    })
    ipcMain.on('win:maximize-toggle', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    })
    ipcMain.on('win:close', (event) => {
      BrowserWindow.fromWebContents(event.sender)?.close()
    })
  }
}
