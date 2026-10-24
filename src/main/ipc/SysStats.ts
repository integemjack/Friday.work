// 主进程的系统资源采样：贾维斯 HUD 的 REMOTE 遥测在「当前连接的服务器就是本机」时走这里
// （Linux 服务器不走 IPC——渲染层用协议的 fs.read 读那台的 /proc 与 /sys，两路互不干扰）。
// CPU：os.cpus() 与上次采样的差值（首次没有基准返回 null，3 秒轮询下第二轮起有值）；
// RAM：os.totalmem / os.freemem；GPU 与显存：nvidia-smi（本机没有 NVIDIA 时为 null，HUD 显示 N/A）；
// 进程数：Windows 用 tasklist 数行，类 Unix 用 ps 数行。
// 每次采样还把快照发布到 %ProgramData%\Friday\sysstats.json——别的电脑连这台机器当
// 服务器时，渲染层用协议 fs.read 读它（协议没有系统采样方法，这是纯客户端侧的跨机器桥）。
// 结果缓存 2.5 秒：HUD 每 3 秒问一次刚好逐轮刷新，多个窗口同问也不会重复开子进程。
// 「服务器是不是本机」不靠 hostname 判（同镜像装出来的机器常重名、老服务端不报 hostname）：
// 主进程在 %ProgramData%\Friday 下放一个随机名的探针文件，渲染层用协议 fs.read 去服务器上读同一路径，
// 读得到 = 服务器就是这台（selfProbePath）。

import { exec, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, ipcMain } from 'electron'
import os from 'node:os'
import type { SysStats } from '../../shared/api.js'

/** 跑一条命令拿 stdout；失败/超时一律 null（采样是尽力而为，不抛错） */
function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout))
  })
}

// ---- CPU：os.cpus() 时间片差值（模块级保存上次采样；两次采样至少隔一个轮询周期差值才有意义） ----
let prevCpuTimes: { idle: number; total: number } | null = null

function sampleCpuPct(): number | null {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  const before = prevCpuTimes
  prevCpuTimes = { idle, total }
  if (!before) return null
  const dTotal = total - before.total
  const dIdle = idle - before.idle
  if (dTotal <= 0) return null
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)))
}

// ---- GPU / 显存：nvidia-smi（一次查询拿利用率与显存用/总量；没有 nvidia-smi 就没有 GPU 数据） ----
// 结果缓存 15 秒：主进程常驻快照循环（见下）每 3 秒采一轮，nvidia-smi 单次要几百 ms，
// 不能让它 3 秒一跑——GPU 数值 15 秒一跳完全够用（进程数也是 15 秒一采）
const GPU_CACHE_MS = 15_000
let gpuCache: { at: number; gpu: Pick<SysStats, 'gpuPct' | 'vramUsedMiB' | 'vramTotalMiB'> } | null = null

async function sampleGpu(): Promise<Pick<SysStats, 'gpuPct' | 'vramUsedMiB' | 'vramTotalMiB'>> {
  if (gpuCache && Date.now() - gpuCache.at < GPU_CACHE_MS) return gpuCache.gpu
  const out = await run('nvidia-smi', [
    '--query-gpu=utilization.gpu,memory.used,memory.total',
    '--format=csv,noheader,nounits'
  ])
  // 多卡时 nvidia-smi 一行一块：只取第一块卡——跨行切逗号会把「本卡总量\n下一卡的值」
  // 切进同一列，Number 出 NaN 被当成「没有 GPU」
  const nums = out?.trim().split(/\r?\n/)[0]?.split(/\s*,\s*/).map(Number)
  // " 34, 3416, 6144"（第一块卡）；列缺失或非数字视为没有
  const gpu: Pick<SysStats, 'gpuPct' | 'vramUsedMiB' | 'vramTotalMiB'> =
    !nums || nums.length < 3 || nums.slice(0, 3).some((n) => !Number.isFinite(n))
      ? { gpuPct: null, vramUsedMiB: null, vramTotalMiB: null }
      : { gpuPct: nums[0]!, vramUsedMiB: nums[1]!, vramTotalMiB: nums[2]! }
  gpuCache = { at: Date.now(), gpu }
  return gpu
}

// ---- 进程数：Windows tasklist 数行 / 类 Unix ps 数行 ----
// Windows 上让 cmd 管道里的 find /c 数行，主进程只读回一个数字：tasklist 往管道里是一个 CSV 字段一个字段地写，
// 直接读它的 stdout 主进程每秒要被唤醒 ~850 次（每次一轮 stream push + nextTick），而且一次 tasklist 要跑 2 秒多，
// 3 秒一采几乎一直在跑——实测空闲时主进程常驻 20%+ CPU 就是它。进程总数变化慢，15 秒取一次足够。
// 两个程序都写全路径：PATH 里排在前面的 Git usr/bin 也有个 find（GNU 版，语义完全不同）
const WIN_PROC_COUNT_CMD = '"%SystemRoot%\\System32\\tasklist.exe" /fo csv /nh | "%SystemRoot%\\System32\\find.exe" /c /v ""'
const PROC_CACHE_MS = 15_000
let procCache: { at: number; count: number | null } | null = null

function runShell(command: string, timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout))
  })
}

async function sampleProcCount(): Promise<number | null> {
  if (procCache && Date.now() - procCache.at < PROC_CACHE_MS) return procCache.count
  const out = process.platform === 'win32' ? await runShell(WIN_PROC_COUNT_CMD) : await run('sh', ['-c', 'ps -A -o pid= | wc -l'])
  const count = out == null ? NaN : Number(out.trim())
  const value = Number.isFinite(count) && count > 0 ? count : null
  procCache = { at: Date.now(), count: value }
  return value
}

// ---- 采样 + 缓存（inFlight 让同一轮的并发请求共享一次采样） ----
const CACHE_MS = 2500
let cached: { at: number; stats: SysStats } | null = null
let inFlight: Promise<SysStats> | null = null

// ---- 跨机器桥：把快照发布到 %ProgramData%\Friday\sysstats.json ----
// 协议没有系统采样方法，别的电脑连这台 Windows 机器当服务器时，渲染层只能用 fs.read
// 读这份文件。Linux 服务器不需要（fs.read 直接读 /proc+/sys）。写失败静默：尽力而为，不影响本机 HUD。
// tmp 名带 PID：这台机器可能有多个写者（本进程、另一 Friday Work 实例、FridaySysStats.exe），
// 大家都用固定名 .tmp 会互踩（Collector 日志里「文件正由另一进程使用」十几次，全部丢轮）——
// rename 的目标（sysstats.json）原子替换，最后写者赢，内容都是这台机器的新鲜快照，谁赢都一样。
const FRIDAY_DATA_DIR = join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Friday')
const SNAPSHOT_PATH = join(FRIDAY_DATA_DIR, 'sysstats.json')

async function publishSnapshot(stats: SysStats): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    const payload = JSON.stringify({ ...stats, at: Date.now() })
    const tmpPath = `${SNAPSHOT_PATH}.${process.pid}.tmp`
    await mkdir(dirname(SNAPSHOT_PATH), { recursive: true })
    await writeFile(tmpPath, payload, 'utf8')
    await rename(tmpPath, SNAPSHOT_PATH)
  } catch {
    // 权限/磁盘问题：跳过这次，下轮采样再试
  }
}

async function collect(): Promise<SysStats> {
  const cpuPct = sampleCpuPct()
  const total = os.totalmem()
  const ramPct = total > 0 ? Math.round(((total - os.freemem()) / total) * 100) : null
  const [gpu, procs] = await Promise.all([sampleGpu(), sampleProcCount()])
  const stats: SysStats = { hostname: os.hostname(), cpuPct, ramPct, ...gpu, procs }
  await publishSnapshot(stats)
  return stats
}

/** IPC 'sys:stats' 的实现（带缓存；HUD 3 秒轮询一次，缓存防止更密的调用反复开子进程） */
export function systemStats(): Promise<SysStats> {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.stats)
  if (inFlight) return inFlight
  inFlight = collect()
    .then((stats) => {
      cached = { at: Date.now(), stats }
      return stats
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

// ---- 本机探针：每个进程一个随机名文件（同机多开各用各的，互不覆盖），退出时删掉 ----
// 只在 Windows 上做（服务器在 Linux/mac 上时本机 IPC 采的是客户端自己，本来就不该用）；
// 建不出来（权限）返回 null，渲染层就一律当「不是本机」走 json 桥。
let probePath: Promise<string | null> | null = null

async function createSelfProbe(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const file = join(FRIDAY_DATA_DIR, `self-${randomBytes(16).toString('hex')}.probe`)
  try {
    await mkdir(FRIDAY_DATA_DIR, { recursive: true })
    await writeFile(file, 'friday-work self probe\n', 'utf8')
  } catch {
    return null
  }
  app.once('will-quit', () => {
    try {
      unlinkSync(file)
    } catch {
      // 删不掉就留着（几十字节，不影响判定：别的机器读不到这一路径）
    }
  })
  // fs.read 走的是服务器的路径语法：用正斜杠，和 sysstats.json 的读法一致
  return file.replace(/\\/g, '/')
}

/** IPC 'sys:self-probe'：本机探针文件路径（进程内只建一次）；null = 本机不提供探针 */
export function selfProbePath(): Promise<string | null> {
  probePath ??= createSelfProbe()
  return probePath
}

// ---- 常驻快照循环（Windows）：只要 Friday Work 在跑，sysstats.json 就一直新鲜 ----
// 原来采样只在「有人开着贾维斯 HUD」时被 sys:stats IPC 拖着跑——HUD 一切走（v-if 卸载）
// 快照就停更，别的电脑连这台读到的 at 超 10 秒不变，资源全部 N/A。现在主进程自己每 3 秒
// 采一轮：CPU/RAM 是纯内存计算，GPU 和进程数各带 15 秒缓存，常驻开销可忽略。目标机上
// 没开 Friday Work 的场景仍由独立采集器 FridaySysStats.exe 覆盖（两者写法兼容：同一路径、
// 各自的 PID tmp，最后写者赢）。
let snapshotTimer: NodeJS.Timeout | null = null

function startSnapshotLoop(): void {
  if (process.platform !== 'win32' || snapshotTimer) return
  snapshotTimer = setInterval(() => {
    void systemStats().catch(() => {})
  }, 3000)
  snapshotTimer.unref?.() // 不因这个定时器拖住退出
}

export function registerSysStatsIpc(): void {
  ipcMain.handle('sys:stats', (): Promise<SysStats> => systemStats())
  ipcMain.handle('sys:self-probe', (): Promise<string | null> => selfProbePath())
  startSnapshotLoop()
}
