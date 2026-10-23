// 文件管理器「下载到本地」的渲染层一侧：远端文件经协议 fs.read 分块读回（base64），交给主进程落盘。
// 单个文件弹「另存为」；多个 / 含文件夹时选一个保存位置，文件夹按原结构递归下载（空目录也保留）。
// 一个文件按 1 MB 分块、最多 3 块并发读（主进程按偏移写，块可以乱序到）；任务状态是响应式的，
// 文件管理器底部的下载条直接展示。取消 / 失败时主进程删掉这次写出的半成品。
import { reactive } from 'vue'
import type { FsListResult, FsReadResult } from '../../../protocol/rpc/protocol.js'
import { rpc } from './host.js'

export interface RemoteItem {
  name: string
  path: string
  dir?: boolean
  size?: number
}

export type DownloadPhase = 'scanning' | 'downloading' | 'done' | 'failed' | 'canceled'

export interface DownloadJob {
  id: number
  title: string
  phase: DownloadPhase
  bytesDone: number
  bytesTotal: number
  filesDone: number
  filesTotal: number
  /** 正在下的文件名 */
  current: string
  error: string
  /** 目录太大被服务端截断（只列了前一部分）的个数 */
  truncatedDirs: number
  /** 主进程会话 id（完成后「在文件夹中显示」用） */
  sessionID: string
  startedAt: number
}

/** 下载用到的两头：远端怎么读（协议 fs.list / fs.read）、本地往哪写（主进程的下载会话）。
 *  默认就是真的 rpc + preload 桥；单测换成假的（test/remotedownload.test.cjs） */
export interface DownloadIO {
  list(machineID: string, path: string): Promise<FsListResult>
  read(machineID: string, path: string, offset: number, length: number): Promise<FsReadResult>
  sink: Pick<
    Window['fridayBridge'],
    'downloadBegin' | 'downloadWrite' | 'downloadCloseFile' | 'downloadMkdir' | 'downloadEnd'
  >
}

const defaultIO: DownloadIO = {
  list: async (machineID, path) => (await rpc(machineID, 'fs.list', { path, files: true })) as FsListResult,
  read: async (machineID, path, offset, length) => (await rpc(machineID, 'fs.read', { path, offset, length })) as FsReadResult,
  get sink() {
    return window.fridayBridge
  }
}

const CHUNK = 1024 * 1024
const PARALLEL = 3
/** 一次下载最多多少个文件：防止误点下载整个盘根目录 */
const MAX_FILES = 20_000

export const downloadJobs = reactive<DownloadJob[]>([])
const cancelFlags = new Map<number, boolean>()
let nextJobID = 1

function decodeBase64(base64: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64
  if (native) return native(base64)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

interface PlannedFile {
  remote: string
  rel: string
  size: number
}

/** 递归列出一个远端目录下的全部文件（rel 以目录名开头），空目录记进 dirs */
async function scanDir(
  io: DownloadIO,
  machineID: string,
  job: DownloadJob,
  path: string,
  rel: string,
  files: PlannedFile[],
  dirs: string[]
): Promise<void> {
  if (cancelFlags.get(job.id)) return
  const result = await io.list(machineID, path)
  if (result.truncated) job.truncatedDirs += 1
  const entries = result.entries ?? []
  if (entries.length === 0) dirs.push(rel)
  for (const entry of entries) {
    if (cancelFlags.get(job.id)) return
    const childRel = `${rel}/${entry.name}`
    if (entry.dir) {
      await scanDir(io, machineID, job, entry.path, childRel, files, dirs)
    } else {
      files.push({ remote: entry.path, rel: childRel, size: entry.size ?? 0 })
      job.filesTotal = files.length
      job.bytesTotal += entry.size ?? 0
      if (files.length > MAX_FILES) throw new Error(`文件太多（超过 ${MAX_FILES} 个），换个小一点的文件夹`)
    }
  }
}

/** 下载一个文件。大小已知时按 1 MB 切块、最多 PARALLEL 块并发读（主进程按偏移写，乱序到也对）；
 *  每块自己循环读到填满或 eof（服务端单次回得比要的少也不会留洞）。列表里的大小过时（文件还在长）时，
 *  并发段读完后再从末尾顺序往下读到 eof；大小未知（0）就从头顺序读。 */
async function downloadFile(io: DownloadIO, machineID: string, job: DownloadJob, file: PlannedFile, rel: string): Promise<void> {
  const bridge = io.sink
  job.current = file.remote.split(/[\\/]/).pop() ?? file.remote
  let reachedEof = false

  /** 读满 [offset, offset + CHUNK) 这一块；返回这块读到的字节数 */
  const readChunk = async (offset: number): Promise<number> => {
    let at = offset
    const end = offset + CHUNK
    while (at < end && !cancelFlags.get(job.id)) {
      const result = await io.read(machineID, file.remote, at, end - at)
      const bytes = decodeBase64(result.data ?? '')
      if (bytes.byteLength > 0) {
        if (!(await bridge.downloadWrite(job.sessionID, rel, at, bytes))) throw new Error('写不进本地文件')
        job.bytesDone += bytes.byteLength
        at += bytes.byteLength
      }
      if (result.eof || bytes.byteLength === 0) {
        reachedEof = true
        break
      }
    }
    return at - offset
  }

  let tail = 0
  if (file.size > 0) {
    const offsets: number[] = []
    for (let offset = 0; offset < file.size; offset += CHUNK) offsets.push(offset)
    let index = 0
    const worker = async (): Promise<void> => {
      while (index < offsets.length && !cancelFlags.get(job.id)) await readChunk(offsets[index++]!)
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, offsets.length) }, () => worker()))
    tail = offsets.length * CHUNK
  }
  // 大小未知 / 文件比列表里的大：顺序读到 eof
  while (!reachedEof && !cancelFlags.get(job.id)) {
    const got = await readChunk(tail)
    tail += CHUNK
    if (got === 0) break
  }
  // 收尾：关句柄（0 字节文件也会在这里落成一个空文件）
  await bridge.downloadCloseFile(job.sessionID, rel)
}

async function run(io: DownloadIO, machineID: string, job: DownloadJob, items: RemoteItem[], mode: 'file' | 'dir'): Promise<void> {
  const bridge = io.sink
  const files: PlannedFile[] = []
  const dirs: string[] = []
  for (const item of items) {
    if (item.dir) await scanDir(io, machineID, job, item.path, item.name, files, dirs)
    else {
      files.push({ remote: item.path, rel: item.name, size: item.size ?? 0 })
      job.filesTotal = files.length
      job.bytesTotal += item.size ?? 0
    }
    if (cancelFlags.get(job.id)) return
  }
  job.phase = 'downloading'
  for (const rel of dirs) await bridge.downloadMkdir(job.sessionID, rel)
  for (const file of files) {
    if (cancelFlags.get(job.id)) return
    await downloadFile(io, machineID, job, file, mode === 'file' ? '' : file.rel)
    job.filesDone += 1
  }
}

/** 下载远端的一批文件 / 文件夹到本地；用户在对话框里取消时返回 null */
export async function downloadToLocal(machineID: string, items: RemoteItem[], io: DownloadIO = defaultIO): Promise<DownloadJob | null> {
  if (!machineID || items.length === 0) return null
  const bridge = io.sink
  const single = items.length === 1 && !items[0]!.dir
  const mode = single ? 'file' : 'dir'
  const session = await bridge.downloadBegin(mode, items[0]!.name, items.length)
  if (!session) return null
  const job: DownloadJob = reactive({
    id: nextJobID++,
    title: items.length === 1 ? items[0]!.name : `${items[0]!.name} 等 ${items.length} 项`,
    phase: 'scanning',
    bytesDone: 0,
    bytesTotal: 0,
    filesDone: 0,
    filesTotal: 0,
    current: '',
    error: '',
    truncatedDirs: 0,
    sessionID: session.id,
    startedAt: Date.now()
  })
  downloadJobs.unshift(job)
  if (downloadJobs.length > 8) downloadJobs.splice(8)
  try {
    await run(io, machineID, job, items, mode)
    const canceled = !!cancelFlags.get(job.id)
    await bridge.downloadEnd(job.sessionID, !canceled)
    job.phase = canceled ? 'canceled' : 'done'
  } catch (error) {
    job.error = error instanceof Error ? error.message : String(error)
    job.phase = 'failed'
    await bridge.downloadEnd(job.sessionID, false).catch(() => null)
  } finally {
    cancelFlags.delete(job.id)
    job.current = ''
  }
  return job
}

export function cancelDownload(job: DownloadJob): void {
  if (job.phase === 'scanning' || job.phase === 'downloading') cancelFlags.set(job.id, true)
}

export function revealDownload(job: DownloadJob): void {
  void window.fridayBridge.downloadReveal(job.sessionID)
}

export function dismissDownload(job: DownloadJob): void {
  const index = downloadJobs.indexOf(job)
  if (index >= 0) downloadJobs.splice(index, 1)
}
