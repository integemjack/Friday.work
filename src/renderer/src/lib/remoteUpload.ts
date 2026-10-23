// 文件管理器「拖进来上传到当前目录」。
// 协议只有 file.upload（服务端 2.75：文件一律落在它自己的 Uploads/<uuid>/ 下，不认目标目录参数），没有 move / write。
// 所以分两步：①每个文件照附件那样 file.upload 上去；②在服务端跑一条一次性命令（term.open 带 command，
// 后台终端，不进终端列表不弹窗）把它们挪进当前目录、建好目录结构，顺手删掉 Uploads 里的空壳。
// 本模块只管编排与命令拼装（纯逻辑，单测 test/remoteupload.test.cjs）；真正的上传 / 跑命令由调用方注入（UploadIO）。
import { reactive } from 'vue'

/** 拖进来的一项（主进程 upload:register-tree 展开的清单） */
export interface DropTree {
  name: string
  files: Array<{ handle: string; rel: string; size: number }>
  dirs: string[]
  truncated: boolean
}

export type UploadPhase = 'uploading' | 'placing' | 'done' | 'failed' | 'canceled'

export interface UploadJob {
  id: number
  title: string
  /** 目标目录（服务端路径） */
  target: string
  phase: UploadPhase
  bytesDone: number
  bytesTotal: number
  filesDone: number
  filesTotal: number
  current: string
  error: string
  /** 落到目标目录里的顶层名字（重名时已改成「名字 (2)」）：完成后文件管理器据此选中它们 */
  placed: string[]
  /** 有文件夹太大被截断（只上传了前一部分） */
  truncated: boolean
}

export interface UploadIO {
  /** 上传一个句柄，返回服务端上的路径（Uploads/<uuid>/名字） */
  upload(handle: string): Promise<string>
  /** 在服务端跑一条命令，等它结束；exitCode 拿不到时为 undefined */
  run(command: string): Promise<{ exitCode: number | undefined; output: string }>
}

export type ShellFlavor = 'powershell' | 'posix'

export const uploadJobs = reactive<UploadJob[]>([])
const cancelFlags = new Map<number, boolean>()
let nextJobID = 1

/** 一条命令最长多少字符（Windows 命令行上限 32K，留足余量；类 Unix 宽松得多） */
const MAX_COMMAND = { powershell: 7000, posix: 60_000 }

function joinRemote(base: string, rel: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  const cleanRel = rel.split(/[\\/]+/).filter(Boolean).join(sep)
  return base.endsWith('/') || base.endsWith('\\') ? `${base}${cleanRel}` : `${base}${sep}${cleanRel}`
}

function parentOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '')
}

/** 同名已存在就加序号：报告.pdf → 报告 (2).pdf；文件夹 → 文件夹 (2)。Windows 不分大小写 */
export function uniqueName(name: string, taken: Set<string>, caseInsensitive: boolean): string {
  const key = (value: string): string => (caseInsensitive ? value.toLowerCase() : value)
  let candidate = name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; taken.has(key(candidate)); n += 1) candidate = `${stem} (${n})${ext}`
  taken.add(key(candidate))
  return candidate
}

function quote(flavor: ShellFlavor, value: string): string {
  return flavor === 'powershell' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'\\''`)}'`
}

/** Uploads/<uuid> 这一层（file.upload 每个文件一个随机目录）：只删长得像这样的，别的路径一律不碰 */
export function uploadShellDir(uploadedPath: string): string | null {
  const dir = parentOf(uploadedPath)
  const last = dir.split(/[\\/]/).pop() ?? ''
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(last) ? dir : null
}

/** 拼「建目录 + 挪文件 + 删 Uploads 空壳」的命令，按长度切成几条（每条单独可执行、出错即停） */
export function buildPlaceCommands(
  flavor: ShellFlavor,
  moves: Array<{ from: string; to: string }>,
  dirs: string[]
): string[] {
  const q = (value: string): string => quote(flavor, value)
  const prologue = flavor === 'powershell' ? "$ErrorActionPreference='Stop'" : 'set -e'
  const steps: string[] = []
  // 目录先建（空目录 + 每个文件的父目录，去重；父目录在前）
  const needDirs = [...new Set([...dirs, ...moves.map((move) => parentOf(move.to))])].sort((a, b) => a.length - b.length)
  for (const dir of needDirs) {
    steps.push(flavor === 'powershell' ? `New-Item -ItemType Directory -Force -Path ${q(dir)} | Out-Null` : `mkdir -p -- ${q(dir)}`)
  }
  for (const move of moves) {
    steps.push(flavor === 'powershell' ? `Move-Item -LiteralPath ${q(move.from)} -Destination ${q(move.to)}` : `mv -f -- ${q(move.from)} ${q(move.to)}`)
    const shell = uploadShellDir(move.from)
    if (shell) {
      steps.push(
        flavor === 'powershell'
          ? `Remove-Item -LiteralPath ${q(shell)} -Recurse -Force -ErrorAction SilentlyContinue`
          : `rm -rf -- ${q(shell)}`
      )
    }
  }
  const commands: string[] = []
  let current = prologue
  for (const step of steps) {
    if (current.length + step.length + 2 > MAX_COMMAND[flavor] && current !== prologue) {
      commands.push(current)
      current = prologue
    }
    current += `; ${step}`
  }
  if (current !== prologue) commands.push(current)
  return commands
}

/** 只删 Uploads 空壳（取消 / 失败时把已经传上去的清掉） */
export function buildCleanupCommand(flavor: ShellFlavor, uploaded: string[]): string | null {
  const shells = [...new Set(uploaded.map(uploadShellDir).filter((dir): dir is string => !!dir))]
  if (!shells.length) return null
  const q = (value: string): string => quote(flavor, value)
  return flavor === 'powershell'
    ? `${shells.map((dir) => `Remove-Item -LiteralPath ${q(dir)} -Recurse -Force -ErrorAction SilentlyContinue`).join('; ')}`
    : `rm -rf -- ${shells.map(q).join(' ')}`
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 把拖进来的几项上传到服务端的 targetDir；existing 是目标目录里已有的名字（重名时新来的加序号，不覆盖） */
export async function uploadToRemote(options: {
  targetDir: string
  flavor: ShellFlavor
  existing: string[]
  trees: DropTree[]
  io: UploadIO
}): Promise<UploadJob> {
  const { targetDir, flavor, trees, io } = options
  const caseInsensitive = flavor === 'powershell'
  const taken = new Set(options.existing.map((name) => (caseInsensitive ? name.toLowerCase() : name)))

  const plan: Array<{ handle: string; rel: string; size: number }> = []
  const emptyDirs: string[] = []
  const placed: string[] = []
  for (const tree of trees) {
    const top = uniqueName(tree.name, taken, caseInsensitive)
    placed.push(top)
    const rename = (rel: string): string => top + rel.slice(tree.name.length)
    for (const file of tree.files) plan.push({ ...file, rel: rename(file.rel) })
    for (const dir of tree.dirs) emptyDirs.push(rename(dir))
  }

  const job: UploadJob = reactive({
    id: nextJobID++,
    title: trees.length === 1 ? trees[0]!.name : `${trees[0]?.name ?? ''} 等 ${trees.length} 项`,
    target: targetDir,
    phase: 'uploading',
    bytesDone: 0,
    bytesTotal: plan.reduce((sum, file) => sum + file.size, 0),
    filesDone: 0,
    filesTotal: plan.length,
    current: '',
    error: '',
    placed,
    truncated: trees.some((tree) => tree.truncated)
  })
  uploadJobs.unshift(job)
  if (uploadJobs.length > 8) uploadJobs.splice(8)

  const moves: Array<{ from: string; to: string }> = []
  const cleanup = async (): Promise<void> => {
    const command = buildCleanupCommand(flavor, moves.map((move) => move.from))
    if (command) await io.run(command).catch(() => null)
  }
  try {
    for (const file of plan) {
      if (cancelFlags.get(job.id)) break
      job.current = file.rel.split('/').pop() ?? file.rel
      const remote = await io.upload(file.handle)
      moves.push({ from: remote, to: joinRemote(targetDir, file.rel) })
      job.bytesDone += file.size
      job.filesDone += 1
    }
    if (cancelFlags.get(job.id)) {
      await cleanup()
      job.phase = 'canceled'
      return job
    }
    job.phase = 'placing'
    job.current = ''
    const commands = buildPlaceCommands(
      flavor,
      moves,
      emptyDirs.map((dir) => joinRemote(targetDir, dir))
    )
    for (const command of commands) {
      const result = await io.run(command)
      if (result.exitCode !== undefined && result.exitCode !== 0) {
        throw new Error(`挪进目录时出错（退出码 ${result.exitCode}）：${stripAnsi(result.output).slice(-240) || '没有输出'}`)
      }
    }
    job.phase = 'done'
  } catch (error) {
    job.error = error instanceof Error ? error.message : String(error)
    job.phase = 'failed'
    await cleanup()
  } finally {
    cancelFlags.delete(job.id)
    job.current = ''
  }
  return job
}

export function cancelUpload(job: UploadJob): void {
  if (job.phase === 'uploading') cancelFlags.set(job.id, true)
}

export function dismissUpload(job: UploadJob): void {
  const index = uploadJobs.indexOf(job)
  if (index >= 0) uploadJobs.splice(index, 1)
}
