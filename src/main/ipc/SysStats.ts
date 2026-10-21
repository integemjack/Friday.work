// 主进程的系统资源采样：贾维斯 HUD 的 REMOTE 遥测在「当前连接的服务器就是本机」时走这里
// （Linux 服务器不走 IPC——渲染层用协议的 fs.read 读那台的 /proc 与 /sys，两路互不干扰）。
// CPU：os.cpus() 与上次采样的差值（首次没有基准返回 null，3 秒轮询下第二轮起有值）；
// RAM：os.totalmem / os.freemem；GPU 与显存：nvidia-smi（本机没有 NVIDIA 时为 null，HUD 显示 N/A）；
// 进程数：Windows 用 tasklist 数行，类 Unix 用 ps 数行。
// 每次采样还把快照发布到 %ProgramData%\Friday\sysstats.json——别的电脑连这台机器当
// 服务器时，渲染层用协议 fs.read 读它（协议没有系统采样方法，这是纯客户端侧的跨机器桥）。
// 结果缓存 2.5 秒：HUD 每 3 秒问一次刚好逐轮刷新，多个窗口同问也不会重复开子进程。

import { execFile } from 'node:child_process'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ipcMain } from 'electron'
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
async function sampleGpu(): Promise<Pick<SysStats, 'gpuPct' | 'vramUsedMiB' | 'vramTotalMiB'>> {
  const out = await run('nvidia-smi', [
    '--query-gpu=utilization.gpu,memory.used,memory.total',
    '--format=csv,noheader,nounits'
  ])
  const nums = out?.trim().split(/\s*,\s*/).map(Number)
  // " 34, 3416, 6144"（第一块卡）；列缺失或非数字视为没有
  if (!nums || nums.length < 3 || nums.slice(0, 3).some((n) => !Number.isFinite(n))) {
    return { gpuPct: null, vramUsedMiB: null, vramTotalMiB: null }
  }
  return { gpuPct: nums[0]!, vramUsedMiB: nums[1]!, vramTotalMiB: nums[2]! }
}

// ---- 进程数：Windows tasklist 数行 / 类 Unix ps 数行 ----
async function sampleProcCount(): Promise<number | null> {
  let out: string | null
  if (process.platform === 'win32') out = await run('tasklist', ['/fo', 'csv', '/nh'])
  else out = await run('sh', ['-c', 'ps -A -o pid= | wc -l'])
  if (!out) return null
  const count = process.platform === 'win32' ? out.split('\n').filter((l) => l.trim() && l.includes('"')).length : Number(out.trim())
  return Number.isFinite(count) && count > 0 ? count : null
}

// ---- 采样 + 缓存（inFlight 让同一轮的并发请求共享一次采样） ----
const CACHE_MS = 2500
let cached: { at: number; stats: SysStats } | null = null
let inFlight: Promise<SysStats> | null = null

// ---- 跨机器桥：把快照发布到 %ProgramData%\Friday\sysstats.json ----
// 协议没有系统采样方法，别的电脑连这台 Windows 机器当服务器时，渲染层只能用 fs.read
// 读这份文件（由这台机器上跑着的 Friday Work 每次采样顺手写）。Linux 服务器不需要
//（fs.read 直接读 /proc+/sys）。写失败静默：尽力而为，不影响本机 HUD。
const SNAPSHOT_PATH = join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Friday', 'sysstats.json')

async function publishSnapshot(stats: SysStats): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    const payload = JSON.stringify({ ...stats, at: Date.now() })
    await mkdir(dirname(SNAPSHOT_PATH), { recursive: true })
    await writeFile(SNAPSHOT_PATH + '.tmp', payload, 'utf8')
    await rename(SNAPSHOT_PATH + '.tmp', SNAPSHOT_PATH)
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

export function registerSysStatsIpc(): void {
  ipcMain.handle('sys:stats', (): Promise<SysStats> => systemStats())
}
