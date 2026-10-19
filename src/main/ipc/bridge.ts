// 主进程的 IPC 桥：附件文件对话框、拖放路径登记、端口分发（方案 §7.3）。
// 上传不接受渲染进程传来的任意本机路径：只认对话框选中的、或拖放进来的 File
// （preload 用 webUtils 换出路径），协议进程只能读这里背书过的路径。

import { dialog, ipcMain, type FileFilter, type WebContents } from 'electron'
import { stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export interface PickedFile {
  handle: string
  name: string
  size: number
}

export class IpcBridge {
  private readonly handles = new Map<string, string>()

  constructor(private readonly protocolHost: { providePort(webContents: WebContents): void }) {}

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
  }
}
