// 文件管理器「下载到本地」的主进程一侧：远端文件由渲染层经协议 fs.read 分块读回来，字节交到这里落盘。
// 安全边界：渲染进程拿不到任意写本机路径的能力——保存位置只能由用户在系统对话框里选，
// 渲染层手里只有一个下载会话 id；写入时给的相对路径逐段清洗，越出所选位置的一律拒绝。
//   begin    弹保存对话框（单个文件）或选文件夹对话框（多个 / 整个文件夹），开一个会话
//   write    按偏移写一块（同一文件可乱序并发写，positional write）
//   mkdir    建空目录（文件夹下载时原样保留空目录）
//   end      收尾：关掉所有句柄；取消 / 失败时删掉这次写出的半成品
//   reveal   在资源管理器 / 访达里定位下载好的东西

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'

interface DownloadSession {
  mode: 'file' | 'dir'
  /** file：选中的目标文件路径；dir：选中的目标文件夹 */
  root: string
  /** 打开着的文件句柄（按清洗后的绝对路径）。存 Promise：同一个新文件的几块并发到达时只开一次，
   *  不然后开的那次 'w' 会把先写进去的块截掉 */
  handles: Map<string, Promise<FileHandle>>
  /** dir 模式：顶层名字 → 实际落盘名（同名已存在时自动加「 (2)」，不覆盖用户已有的东西）；
   *  同样存 Promise，并发的第一批写入只起一次名 */
  topNames: Map<string, Promise<string>>
  /** 这次新建出来的东西（取消时删掉）：file 模式是目标文件，dir 模式是各个顶层项 */
  created: Set<string>
}

const sessions = new Map<string, DownloadSession>()
/** 收尾后留着给「在文件夹中显示」用：会话 id → 要定位的路径 */
const finished = new Map<string, string>()

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

/** 一段文件名清洗成本机合法的名字（Windows 非法字符、保留名、结尾的点和空格） */
function cleanSegment(segment: string): string {
  let name = segment.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '')
  if (!name || name === '.' || name === '..') name = '_'
  if (RESERVED.test(name)) name = `_${name}`
  return name.slice(0, 200)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 同名已存在就加序号：报告.pdf → 报告 (2).pdf；文件夹 → 文件夹 (2) */
async function uniquePath(dir: string, name: string): Promise<string> {
  let candidate = join(dir, name)
  if (!(await exists(candidate))) return candidate
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; n < 1000; n += 1) {
    candidate = join(dir, `${stem} (${n})${ext}`)
    if (!(await exists(candidate))) return candidate
  }
  return join(dir, `${stem} (${Date.now()})${ext}`)
}

/** 相对路径 → 会话里的绝对路径；越界 / 空路径返回 null */
async function resolveTarget(session: DownloadSession, rel: unknown): Promise<string | null> {
  if (session.mode === 'file') return session.root
  if (typeof rel !== 'string') return null
  const segments = rel.split(/[\\/]+/).filter(Boolean).map(cleanSegment)
  if (segments.length === 0) return null
  const top = segments[0]!
  let pending = session.topNames.get(top)
  if (!pending) {
    pending = uniquePath(session.root, top).then((path) => {
      session.created.add(path)
      return path
    })
    session.topNames.set(top, pending)
  }
  const topPath = await pending
  const full = join(topPath, ...segments.slice(1))
  const back = relative(session.root, full)
  if (!back || back.startsWith('..') || isAbsolute(back)) return null
  return full
}

function handleFor(session: DownloadSession, path: string): Promise<FileHandle> {
  let handle = session.handles.get(path)
  if (!handle) {
    handle = mkdir(dirname(path), { recursive: true }).then(() => open(path, 'w'))
    session.handles.set(path, handle)
    // 打开失败别把坏的 Promise 留在表里（下一块还能重试）
    handle.catch(() => session.handles.delete(path))
  }
  return handle
}

async function closeAll(session: DownloadSession): Promise<void> {
  await Promise.all(
    [...session.handles.values()].map((pending) => pending.then((handle) => handle.close()).catch(() => {}))
  )
  session.handles.clear()
}

export function registerDownloadIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('download:begin', async (_event, payload: unknown): Promise<{ id: string; target: string } | null> => {
    const input = payload as { mode?: string; suggestedName?: string; count?: number } | null
    const mode = input?.mode === 'dir' ? 'dir' : 'file'
    const win = getWindow()
    const downloads = app.getPath('downloads')
    let root = ''
    if (mode === 'file') {
      const name = cleanSegment(String(input?.suggestedName ?? '下载的文件'))
      const options = { title: '下载到本地', defaultPath: join(downloads, name), buttonLabel: '下载' }
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      root = result.filePath
    } else {
      const options = {
        title: `选择保存位置（${Number(input?.count) || 1} 项）`,
        defaultPath: downloads,
        buttonLabel: '下载到这里',
        properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
      }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return null
      root = result.filePaths[0]
    }
    const id = randomUUID()
    // file 模式：只有这次新建的文件才进 created——用户在保存对话框里选了已有文件
    // （覆盖保存）时，取消/失败绝不能把人家的原文件删掉
    const created = new Set<string>()
    if (mode === 'file' && !(await exists(root))) created.add(root)
    sessions.set(id, { mode, root, handles: new Map(), topNames: new Map(), created })
    return { id, target: root }
  })

  ipcMain.handle('download:write', async (_event, payload: unknown): Promise<boolean> => {
    const input = payload as { id?: string; rel?: string; offset?: number; data?: Uint8Array } | null
    const session = sessions.get(String(input?.id ?? ''))
    if (!session || !input?.data) return false
    const path = await resolveTarget(session, input.rel)
    if (!path) return false
    const handle = await handleFor(session, path)
    const bytes = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength)
    await handle.write(bytes, 0, bytes.byteLength, Math.max(0, Number(input.offset) || 0))
    return true
  })

  /** 一个文件写完：关句柄（文件夹里成千上万个文件时不能全开着）；空文件也走这里落一个 0 字节文件 */
  ipcMain.handle('download:close-file', async (_event, payload: unknown): Promise<boolean> => {
    const input = payload as { id?: string; rel?: string } | null
    const session = sessions.get(String(input?.id ?? ''))
    if (!session) return false
    const path = await resolveTarget(session, input?.rel)
    if (!path) return false
    const handle = await handleFor(session, path)
    await handle.close().catch(() => {})
    session.handles.delete(path)
    return true
  })

  ipcMain.handle('download:mkdir', async (_event, payload: unknown): Promise<boolean> => {
    const input = payload as { id?: string; rel?: string } | null
    const session = sessions.get(String(input?.id ?? ''))
    if (!session || session.mode !== 'dir') return false
    const path = await resolveTarget(session, input?.rel)
    if (!path) return false
    await mkdir(path, { recursive: true })
    return true
  })

  ipcMain.handle('download:end', async (_event, payload: unknown): Promise<string | null> => {
    const input = payload as { id?: string; ok?: boolean } | null
    const id = String(input?.id ?? '')
    const session = sessions.get(id)
    if (!session) return null
    sessions.delete(id)
    await closeAll(session)
    if (!input?.ok) {
      // 取消 / 失败：删掉这次新建的半成品（只删本次创建的，用户原有的文件不碰）
      await Promise.all([...session.created].map((path) => rm(path, { recursive: true, force: true }).catch(() => {})))
      return null
    }
    // 定位：单个文件 / 只有一个顶层项时定位到它，多个时打开所选文件夹
    const tops = await Promise.all([...session.topNames.values()])
    const reveal = session.mode === 'file' ? session.root : tops.length === 1 ? tops[0]! : session.root
    finished.set(id, reveal)
    if (finished.size > 50) finished.delete(finished.keys().next().value!)
    return reveal
  })

  ipcMain.handle('download:reveal', async (_event, payload: unknown): Promise<boolean> => {
    const path = finished.get(String((payload as { id?: string } | null)?.id ?? ''))
    if (!path) return false
    shell.showItemInFolder(path)
    return true
  })
}
