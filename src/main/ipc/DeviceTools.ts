// 客户端设备在主进程的两件事（方案-客户端设备 §5.7 / §5.8）：
//   UF2 盘：树莓派 Pico 等按住 BOOTSEL 插上会出现一个 U 盘（根目录有 INFO_UF2.TXT），把 .uf2 拷进去就烧好、自动重启。
//           只往带 INFO_UF2.TXT 的盘写、只写真的 UF2 镜像（每 512 字节一块、块头块尾的魔数都对），文件名固定 firmware.uf2；
//   本机工具：服务端要在这台电脑上跑烧录 / 调试工具（avrdude、openocd……）。只认白名单里的程序（在 PATH 里找），
//           不经 shell，参数原样给；传来的文件放进这次专用的临时目录，参数里 {file:名字} 换成它的路径、{dir} 换成目录。
//           每次都由渲染进程先问过人（授权弹窗）才会调到这里。

import { BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs, readdirSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, delimiter, join } from 'node:path'

// MARK: UF2

export interface Uf2Drive {
  id: string
  root: string
  label: string
  model: string
  boardId: string
}

const UF2_MAGIC_START0 = 0x0a324655
const UF2_MAGIC_START1 = 0x9e5d5157
const UF2_MAGIC_END = 0x0ab16f30

/** 可能是 UF2 盘的根目录（各系统挂 U 盘的地方） */
function candidateRoots(): string[] {
  if (process.platform === 'win32') {
    const roots: string[] = []
    for (let code = 'D'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) roots.push(`${String.fromCharCode(code)}:\\`)
    return roots
  }
  const parents = process.platform === 'darwin' ? ['/Volumes'] : [`/media/${userInfo().username}`, `/run/media/${userInfo().username}`, '/media']
  const roots: string[] = []
  for (const parent of parents) {
    try {
      for (const name of readdirSync(parent)) roots.push(join(parent, name))
    } catch {
      /* 没这个目录 */
    }
  }
  return roots
}

export async function listUf2Drives(): Promise<Uf2Drive[]> {
  const drives: Uf2Drive[] = []
  for (const root of candidateRoots()) {
    const info = join(root, 'INFO_UF2.TXT')
    if (!existsSync(info)) continue
    let text = ''
    try {
      text = await fs.readFile(info, 'utf8')
    } catch {
      continue
    }
    const model = /^Model:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? 'UF2 设备'
    const boardId = /^Board-ID:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
    drives.push({ id: `uf2:${root}`, root, label: `${model}（${root.replace(/\\$/, '')}）`, model, boardId })
  }
  return drives
}

/** 是不是 UF2 镜像：长度是 512 的倍数、每块的三个魔数都对 */
export function isUf2Image(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.length % 512 !== 0) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset < bytes.length; offset += 512) {
    if (view.getUint32(offset, true) !== UF2_MAGIC_START0) return false
    if (view.getUint32(offset + 4, true) !== UF2_MAGIC_START1) return false
    if (view.getUint32(offset + 508, true) !== UF2_MAGIC_END) return false
  }
  return true
}

export async function writeUf2(root: string, bytes: Uint8Array): Promise<{ bytes: number; blocks: number }> {
  const drive = (await listUf2Drives()).find((item) => item.root === root)
  if (!drive) throw new Error('这个 UF2 盘不在了（板子重启了？按住 BOOTSEL 再插一次）')
  if (!isUf2Image(bytes)) throw new Error('不是 UF2 镜像（.uf2 文件每 512 字节一块、带魔数）')
  await fs.writeFile(join(root, 'firmware.uf2'), bytes)
  return { bytes: bytes.length, blocks: bytes.length / 512 }
}

// MARK: 本机工具

/** 白名单：烧录 / 调试工具（小写、不带 .exe） */
export const ALLOWED_TOOLS = [
  'avrdude',
  'openocd',
  'st-flash',
  'st-info',
  'stm32flash',
  'stm32_programmer_cli',
  'picotool',
  'dfu-util',
  'nrfjprog',
  'jlinkexe',
  'jlink',
  'esptool',
  'esptool.py'
]

const OUTPUT_LIMIT = 64 * 1024

export function isAllowedTool(tool: string): boolean {
  return ALLOWED_TOOLS.includes(tool.toLowerCase().replace(/\.exe$/, ''))
}

/** 在 PATH 里找；找不到为 null。Windows 只认 .exe：.cmd / .bat 得经 shell 跑，参数会被 cmd 再解释一遍，不跑 */
export function findExecutable(tool: string): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
  const extensions = process.platform === 'win32' ? (tool.toLowerCase().endsWith('.exe') ? [''] : ['.exe']) : ['']
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, tool + ext)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        /* 没有 */
      }
    }
  }
  return null
}

/** 参数里的 {file:名字} 换成临时目录里的路径、{dir} 换成目录 */
export function expandArgs(args: string[], dir: string, names: string[]): string[] {
  return args.map((arg) =>
    arg
      .replace(/\{file:([^}]+)\}/g, (whole, name: string) => {
        const safe = basename(name)
        if (!names.includes(safe)) throw new Error(`参数里的 ${whole} 没有对应的文件`)
        return join(dir, safe)
      })
      .replace(/\{dir\}/g, dir)
  )
}

export interface ToolRunRequest {
  tool: string
  args: string[]
  files: Array<{ name: string; data: ArrayBuffer }>
  background: boolean
  timeoutMs: number
}

export interface ToolRunResult {
  exitCode?: number
  output?: string
  elapsedMs?: number
  command: string
  runId?: string
}

class ToolRuns {
  private readonly running = new Map<string, { child: ChildProcess; dir: string }>()

  constructor(private readonly onExited: (runId: string, exitCode: number, output: string) => void) {}

  async run(request: ToolRunRequest): Promise<ToolRunResult> {
    if (!isAllowedTool(request.tool)) throw new Error(`${request.tool} 不在白名单里（${ALLOWED_TOOLS.join('、')}）`)
    const executable = findExecutable(request.tool)
    if (!executable) throw new Error(`这台电脑上找不到 ${request.tool}（要装好并加进 PATH）`)
    const dir = join(tmpdir(), `friday-tool-${randomUUID()}`)
    await fs.mkdir(dir, { recursive: true })
    const names: string[] = []
    for (const file of request.files) {
      const name = basename(file.name)
      if (!name || name === '.' || name === '..') throw new Error(`文件名不对：${file.name}`)
      await fs.writeFile(join(dir, name), new Uint8Array(file.data))
      names.push(name)
    }
    const args = expandArgs(request.args, dir, names)
    const command = [request.tool, ...args].join(' ')
    const startedAt = Date.now()
    let output = ''
    const child = spawn(executable, args, { cwd: dir, shell: false, windowsHide: true })
    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (output.length > OUTPUT_LIMIT * 2) output = output.slice(-OUTPUT_LIMIT)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const exited = new Promise<number>((resolve) => {
      child.on('error', (error) => {
        output += `\n${error.message}`
        resolve(-1)
      })
      child.on('close', (code) => resolve(code ?? -1))
    })
    const cleanup = (): void => {
      void fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    if (request.background) {
      const runId = randomUUID().slice(0, 8)
      this.running.set(runId, { child, dir })
      void exited.then((code) => {
        this.running.delete(runId)
        cleanup()
        this.onExited(runId, code, output.slice(-OUTPUT_LIMIT))
      })
      return { runId, command }
    }
    const timer = setTimeout(() => {
      output += `\n（超过 ${Math.round(request.timeoutMs / 1000)} 秒，结束了它）`
      child.kill()
    }, request.timeoutMs)
    const exitCode = await exited
    clearTimeout(timer)
    cleanup()
    return { exitCode, output: output.slice(-OUTPUT_LIMIT), elapsedMs: Date.now() - startedAt, command }
  }

  stop(runId: string): boolean {
    const entry = this.running.get(runId)
    if (!entry) return false
    entry.child.kill()
    return true
  }

  stopAll(): void {
    for (const entry of this.running.values()) entry.child.kill()
  }
}

let runs: ToolRuns | null = null

export function registerDeviceTools(window: () => BrowserWindow | null): void {
  runs = new ToolRuns((runId, exitCode, output) => {
    window()?.webContents.send('tool:exited', { runId, exitCode, output })
  })
  ipcMain.handle('uf2:list', () => listUf2Drives())
  ipcMain.handle('uf2:write', (_event, root: string, bytes: Uint8Array) => writeUf2(root, bytes))
  ipcMain.handle('tool:run', (_event, request: ToolRunRequest) => runs!.run(request))
  ipcMain.handle('tool:stop', (_event, runId: string) => runs!.stop(runId))
}

export function stopDeviceTools(): void {
  runs?.stopAll()
}
