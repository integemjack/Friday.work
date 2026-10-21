<script setup lang="ts">
// 贾维斯 HUD：桌面中央的全息雷达。多层旋转环 + 雷达扫描 + 反应堆核心 + 两侧真实遥测。
// 不是纯装饰：遥测栏和状态行显示真实数据——FPS（实测）、JS 堆内存、运行时长、CPU 核数、
// 时区、日期、机器连接状态、窗口数、待确认数、实时时钟；右侧 REMOTE 组是当前服务器的
// CPU/RAM/GPU/显存/进程数实测（Linux 走 fs.read 读 /proc+/sys，Windows 本机走主进程 IPC）。
// 随鼠标做 3D 视差倾斜（--par-x/--par-y 由 App.vue 下发，rAF 已插值）。
// 只在「贾维斯界面」下挂载（App.vue 里 v-if="jarvis"），别的主题不渲染、零开销。
import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { useAppStore } from '../stores/app.js'
import { rpc } from '../lib/host.js'
import type { FsListResult, FsReadResult } from '../../../protocol/rpc/protocol.js'
import type { SysStatsSnapshot } from '../../../shared/api.js'

const store = useAppStore()

const pad = (n: number): string => String(n).padStart(2, '0')

// ---- 心跳：每秒刷新时钟 / 运行时长 / 内存 / 日期 ----
const now = ref('')
const uptime = ref('00:00')
const memText = ref('--')
const dateText = ref('')
let timer = 0
const bootedAt = Date.now()

function readMem(): string {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  if (!memory) return 'N/A'
  return `${Math.round(memory.usedJSHeapSize / 1048576)}M`
}

function tick(): void {
  const d = new Date()
  now.value = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const up = Math.floor((Date.now() - bootedAt) / 1000)
  uptime.value = up >= 3600 ? `${Math.floor(up / 3600)}:${pad(Math.floor((up % 3600) / 60))}:${pad(up % 60)}` : `${pad(Math.floor(up / 60))}:${pad(up % 60)}`
  memText.value = readMem()
  if (!dateText.value) {
    const week = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()]
    dateText.value = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${week}`
  }
}

// ---- FPS：rAF 计帧，每 500ms 结算一次（真实测量） ----
const fps = ref(0)
let fpsRaf = 0
let fpsFrames = 0
let fpsLast = 0
function fpsLoop(now: number): void {
  fpsRaf = requestAnimationFrame(fpsLoop)
  fpsFrames += 1
  if (now - fpsLast >= 500) {
    fps.value = Math.round((fpsFrames * 1000) / (now - fpsLast))
    fpsFrames = 0
    fpsLast = now
  }
}

// ---- 装饰性 hex 数据流（HUD 味，低频刷新） ----
const hexLine = ref('')
let hexTimer = 0
function rollHex(): void {
  const bytes: string[] = []
  for (let i = 0; i < 22; i += 1) bytes.push(Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase())
  hexLine.value = bytes.join(' ')
}

// 静态遥测：CPU 核数 / 时区
const coreText = `${navigator.hardwareConcurrency || '?'}x`
const tzText = computed(() => {
  const offset = -new Date().getTimezoneOffset() / 60
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `UTC${sign}${Number.isInteger(abs) ? abs : abs.toFixed(1)}`
})

// ---- 远程服务器资源（真实数据，不是装饰）：按服务器平台分派数据源 ----
//   Linux   —— 协议 fs.read 读那台的 /proc（CPU 差值 / RAM / loadavg 进程数），
//              GPU/显存再试 /sys/class/drm/card*/device（AMD/Intel 暴露 sysfs，NVIDIA 与虚拟机没有 → N/A）；
//   Windows —— 两级：①「服务器就是本机」时走 fridayBridge.systemStats IPC（主进程 os.cpus 差值
//              + nvidia-smi + tasklist），返回 hostname 与 serverInfo.hostname 对得上才用；
//              ②从别的电脑连这台时（①的 hostname 对不上），协议 fs.read 读服务器上
//              %ProgramData%\Friday\sysstats.json——那份文件由服务器机器上跑着的 Friday Work
//              主进程每次采样写入（协议没有系统采样方法，这是纯客户端仓库内的跨机器桥）；
//              文件读不到 / 超过 10 秒没更新（那台没跑 Friday Work）→ N/A。
// 没连机器：五项显示 NO LINK（一眼知道是没连上，不是取不到）。
// 某一轮没取到（通道卡死、fs.read 报错、某个文件读不到）：每个指标各自沿用 12 秒内的
// 上次好值，过期才落 N/A，并把下一轮退避到 10 秒——不再因为一次失败就永久停轮询
//（原来 remoteDead 一旦置上，HUD 就永远空在那儿，只有换机器或断线重连才恢复）。
const hostName = ref('N/A')
const cpuText = ref('…')
const ramText = ref('…')
const gpuText = ref('…')
const vramText = ref('…')
const procText = ref('…')
let remoteTimer = 0
let polling = false // 上一轮还挂着就不并发发第二轮（通道慢时避免请求堆积）
let roundOk = false // 这一轮至少取到了一项：决定下一轮 3 秒还是退避 10 秒
let prevCpu: { idle: number; total: number } | null = null
let polledMachine = ''
let gpuCard: string | null = null // Linux 那台探到的 DRM 卡名（/sys/class/drm/card0…）；'' = 探过、没有
let gpuTries = 0 // GPU sysfs 连续读不到的轮数，够几轮就判定这台没有可用接口

function pct(n: number): string {
  return `${Math.max(0, Math.min(100, Math.round(n)))}%`
}

function fmtVram(usedMiB: number | null, totalMiB: number | null): string {
  return usedMiB != null && totalMiB != null && totalMiB > 0
    ? `${(usedMiB / 1024).toFixed(1)}/${(totalMiB / 1024).toFixed(1)}G`
    : 'N/A'
}

function parseCpu(text: string): { idle: number; total: number } | null {
  const first = text.split('\n', 1)[0] ?? ''
  const parts = first.trim().split(/\s+/).slice(1).map(Number)
  // user nice system idle iowait irq softirq steal …（至少前四列）
  if (parts.length < 4 || !parts.slice(0, 4).every(Number.isFinite)) return null
  return { idle: parts[3]! + (parts[4] ?? 0), total: parts.reduce((sum, v) => sum + v, 0) }
}

/** 五个指标一起写成同一个样子（pending = 还没起测的 …；没连上 = NO LINK） */
function resetRemote(text: string): void {
  cpuText.value = text
  ramText.value = text
  gpuText.value = text
  vramText.value = text
  procText.value = text
}

// 每个指标各自记「上次成功」：这轮没取到就沿用好值，过期才 N/A——
// 通道抖一下、某一个文件读不到，都不会把整组打回空白，也不会挂着十分钟前的数不放。
const HOLD_MS = 12_000
type MetricKey = 'cpu' | 'ram' | 'gpu' | 'vram' | 'proc'
const metricRefs: Record<MetricKey, Ref<string>> = { cpu: cpuText, ram: ramText, gpu: gpuText, vram: vramText, proc: procText }
const holds = new Map<MetricKey, { text: string; at: number }>()

/** text = null：这轮没取到（沿用上次好值，过期 N/A）；'…'：还没到出值的轮次（不记好值） */
function setMetric(key: MetricKey, text: string | null): void {
  const target = metricRefs[key]
  if (text === '…') {
    target.value = '…'
    return
  }
  if (text != null) {
    holds.set(key, { text, at: Date.now() })
    target.value = text
    roundOk = true
    return
  }
  const held = holds.get(key)
  target.value = held && Date.now() - held.at < HOLD_MS ? held.text : 'N/A'
}

/** 这一轮这一路什么也没取到：五个指标各自走「沿用好值 / 过期 N/A」 */
function missedRound(): void {
  setMetric('cpu', null)
  setMetric('ram', null)
  setMetric('gpu', null)
  setMetric('vram', null)
  setMetric('proc', null)
}

function clearHolds(): void {
  holds.clear()
  roundOk = false
}

/** 把一份 SysStats 上屏（IPC 与 json 桥共用；字段缺失按这轮没取到处理） */
function applyStats(s: Partial<SysStatsSnapshot>): void {
  // 服务器刚起的第一轮没有 CPU 差值：显示 …，下一轮才有数
  setMetric('cpu', s.cpuPct == null ? '…' : pct(s.cpuPct))
  setMetric('ram', s.ramPct == null ? null : pct(s.ramPct))
  setMetric('gpu', s.gpuPct == null ? null : pct(s.gpuPct))
  setMetric('vram', s.vramUsedMiB == null || s.vramTotalMiB == null ? null : fmtVram(s.vramUsedMiB, s.vramTotalMiB))
  setMetric('proc', s.procs == null ? null : String(s.procs))
}

/** 一次 fs.read：4 秒没回当没取到（工作通道死了会一直挂着、要 60 秒才超时，
 *  不能让它拖住整轮）；报错 / 没数据也回 null。回的是解好 base64 的文本。 */
async function readRemote(machineID: string, path: string, length: number): Promise<string | null> {
  try {
    const r = (await Promise.race([
      rpc(machineID, 'fs.read', { path, offset: 0, length }),
      new Promise((resolve) => setTimeout(() => resolve(null), 4000))
    ])) as FsReadResult | null
    return r && typeof r.data === 'string' ? atob(r.data) : null
  } catch {
    return null
  }
}

/** Windows 服务器·第二级：服务器不是本机（从别的电脑连它）——协议 fs.read 读
 *  服务器上跑着的 Friday Work 写的 %ProgramData%\Friday\sysstats.json。
 *  读不到 / JSON 坏了 / 超过 10 秒没更新（那台没跑 Friday Work 或刚断）→ 按这轮没取到处理。 */
const REMOTE_STATS_PATH = 'C:/ProgramData/Friday/sysstats.json'
const REMOTE_STATS_FRESH_MS = 10_000

async function pollWindowsViaFile(machineID: string): Promise<void> {
  const text = await readRemote(machineID, REMOTE_STATS_PATH, 2048)
  let s: Partial<SysStatsSnapshot> | null = null
  try {
    s = text ? (JSON.parse(text) as Partial<SysStatsSnapshot>) : null
  } catch {
    s = null
  }
  if (!s || typeof s.at !== 'number' || Date.now() - s.at > REMOTE_STATS_FRESH_MS) {
    missedRound()
    return
  }
  applyStats(s)
}

/** Windows 服务器：先试本机 IPC（服务器就是这台机器时最快最准），
 *  hostname 对不上（= 从别的电脑连这台服务器）就落到 fs.read 读 json 桥。 */
async function pollLocalServer(machineID: string, serverHostname: string | undefined): Promise<void> {
  const bridge = window.fridayBridge
  if (bridge?.systemStats) {
    try {
      const s = await bridge.systemStats()
      // hostname 对不上 = 连的是别的 Windows 机器：本机数据不作数，落到 json 桥
      if (s && (!serverHostname || s.hostname.toLowerCase() === serverHostname.toLowerCase())) {
        applyStats(s)
        return
      }
    } catch {
      // IPC 出错也落到 json 桥再试
    }
  }
  await pollWindowsViaFile(machineID)
}

/** Linux：fs.read 读那台的 /proc 与 /sys——五个指标各自取、各自成不成，
 *  一个读不到不连带把整组清零（原来三个 Promise.all 一起包在一个 try 里，
 *  任意一个报错 / 超时就直接 remoteDead，CPU/RAM/进程数明明能读也不显示了） */
async function pollLinuxServer(machineID: string): Promise<void> {
  const [stat, mem, load] = await Promise.all([
    readRemote(machineID, '/proc/stat', 256),
    readRemote(machineID, '/proc/meminfo', 4096),
    readRemote(machineID, '/proc/loadavg', 128)
  ])
  // CPU：和上一轮的累计时间片做差（第一轮只有基准，显示 …）
  const sample = stat ? parseCpu(stat) : null
  if (sample) {
    if (!prevCpu) {
      setMetric('cpu', '…')
    } else {
      const dTotal = sample.total - prevCpu.total
      const dIdle = sample.idle - prevCpu.idle
      setMetric('cpu', dTotal > 0 ? pct((1 - dIdle / dTotal) * 100) : null)
    }
    prevCpu = sample
  } else {
    setMetric('cpu', null)
  }
  if (mem) {
    const total = /MemTotal:\s+(\d+) kB/.exec(mem)
    const avail = /MemAvailable:\s+(\d+) kB/.exec(mem)
    setMetric('ram', total && avail && Number(total[1]) > 0 ? pct(((Number(total[1]) - Number(avail[1])) / Number(total[1])) * 100) : null)
  } else {
    setMetric('ram', null)
  }
  // loadavg 第 4 字段「运行中/进程总数」：取总数当进程数
  const m = load ? /(?:^|\s)\d+\/(\d+)\s/.exec(load) : null
  setMetric('proc', m ? m[1]! : null)
  await pollLinuxGpu(machineID)
}

/** Linux GPU：/sys/class/drm/ 下 cardN/device 里 AMD/Intel 暴露的 gpu_busy_percent 与 mem_info_vram_*
 *  （字节）；NVIDIA 闭源驱动没有内核利用率接口、虚拟机没有 GPU——连着几轮读不到就定成 NO GPU。
 *  卡列表探不到（超时 / 没权限）不算探过，下轮再探，不再一错就永久记成「没有」。 */
async function pollLinuxGpu(machineID: string): Promise<void> {
  if (gpuCard === null) {
    try {
      const listing = (await Promise.race([
        rpc(machineID, 'fs.list', { path: '/sys/class/drm' }),
        new Promise((resolve) => setTimeout(() => resolve(null), 4000))
      ])) as FsListResult | null
      if (listing?.entries) gpuCard = listing.entries.find((e) => /^card\d+$/.test(e.name))?.name ?? ''
    } catch {
      // 保持 gpuCard === null：这轮 GPU/显存沿用上次值，下轮再探
    }
  }
  if (gpuCard === null) return
  if (gpuCard && gpuTries >= 5) {
    // 有卡但连着 5 轮读不到利用率/显存文件：这台没有可用接口——记下，别再每轮白读三个文件
    gpuCard = ''
    gpuTries = 0
  }
  if (!gpuCard) {
    setMetric('gpu', 'NO GPU')
    setMetric('vram', 'NO GPU')
    return
  }
  const busy = await readRemote(machineID, `/sys/class/drm/${gpuCard}/device/gpu_busy_percent`, 128)
  const [usedText, totalText] = await Promise.all([
    readRemote(machineID, `/sys/class/drm/${gpuCard}/device/mem_info_vram_used`, 128),
    readRemote(machineID, `/sys/class/drm/${gpuCard}/device/mem_info_vram_total`, 128)
  ])
  const busyNum = busy == null ? NaN : Number(busy.trim())
  const used = usedText == null ? NaN : Number(usedText.trim())
  const total = totalText == null ? NaN : Number(totalText.trim())
  setMetric('gpu', Number.isFinite(busyNum) ? pct(busyNum) : null)
  // sysfs 值是字节，fmtVram 吃 MiB：除 1024²
  setMetric('vram', Number.isFinite(used) && Number.isFinite(total) && total > 0 ? fmtVram(used / 1048576, total / 1048576) : null)
  if (Number.isFinite(busyNum) || Number.isFinite(used)) gpuTries = 0
  else gpuTries += 1
}

async function pollRemote(): Promise<void> {
  // 先排下一次再干活：断线 / 没连时也能在恢复后自动接上
  const next = (delay: number): void => {
    remoteTimer = window.setTimeout(() => void pollRemote(), delay)
  }
  const machineID = store.currentMachine
  const info = store.currentMachineInfo
  if (!machineID || info?.state !== 'ready') {
    hostName.value = 'N/A'
    clearHolds()
    resetRemote('NO LINK')
    prevCpu = null
    gpuCard = null
    gpuTries = 0
    polledMachine = machineID
    next(3000)
    return
  }
  if (machineID !== polledMachine) {
    // 换了台机器：重新起测
    polledMachine = machineID
    clearHolds()
    prevCpu = null
    gpuCard = null
    gpuTries = 0
    resetRemote('…')
  }
  if (polling) {
    // 上一轮还挂着（通道慢）：不并发发第二轮，1 秒后再看
    next(1000)
    return
  }
  polling = true
  roundOk = false
  hostName.value = info.serverInfo?.hostname || 'REMOTE'
  const platform = info.serverInfo?.platform
  try {
    if (platform === 'windows') {
      await pollLocalServer(machineID, info.serverInfo?.hostname)
    } else if (platform === 'linux') {
      await pollLinuxServer(machineID)
    } else {
      // 平台两条路都不通（macos / 没给）：按这轮没取到处理
      missedRound()
    }
  } finally {
    polling = false
  }
  // 一件都没取到（通道卡死、fs.read 全报错）：退避到 10 秒再试，不永久停轮询
  next(roundOk ? 3000 : 10_000)
}

// 连接状态（和任务栏同一份 state，换成 HUD 味的英文短语；0.3 起只剩这几种）
const stateText: Record<string, string> = {
  disconnected: 'OFFLINE',
  connecting: 'LINKING',
  ready: 'LINK READY',
  failed: 'LINK FAILED',
  versionMismatch: 'VER MISMATCH'
}
const linkText = computed(() => {
  const info = store.currentMachineInfo
  return info ? (stateText[info.state] ?? info.state) : 'STANDBY'
})
const linkReady = computed(() => store.currentMachineInfo?.state === 'ready')
const winText = computed(() => `WIN ${String(store.windows.length).padStart(2, '0')}`)

// 外圈 60 根刻度线（每 5 根一根长的），几何在这里算好，模板只管画
const ticks = Array.from({ length: 60 }, (_, i) => {
  const a = (i * 6 * Math.PI) / 180
  const long = i % 5 === 0
  const r1 = long ? 171 : 177
  return {
    x1: 200 + r1 * Math.cos(a),
    y1: 200 + r1 * Math.sin(a),
    x2: 200 + 186 * Math.cos(a),
    y2: 200 + 186 * Math.sin(a),
    long
  }
})

// 雷达环上的三个「目标点」（相位错开的闪烁）
const blips = [20, 130, 250].map((deg) => {
  const a = (deg * Math.PI) / 180
  return { x: 200 + 150 * Math.cos(a), y: 200 + 150 * Math.sin(a) }
})

onMounted(() => {
  tick()
  timer = window.setInterval(tick, 1000)
  rollHex()
  hexTimer = window.setInterval(rollHex, 420)
  fpsLast = performance.now()
  fpsRaf = requestAnimationFrame(fpsLoop)
  void pollRemote()
})
onBeforeUnmount(() => {
  window.clearInterval(timer)
  window.clearInterval(hexTimer)
  window.clearTimeout(remoteTimer)
  cancelAnimationFrame(fpsRaf)
})
</script>

<template>
  <div class="jarvis-hud" aria-hidden="true">
    <div class="hud-top">J.A.R.V.I.S. // FRIDAY DESKTOP</div>

    <div class="hud-stage">
      <!-- 左遥测：上组 = 本机实时（实测）；下组 = 本机日期/核数/时区 -->
      <div class="telemetry">
        <div class="t-head">LOCAL</div>
        <div class="t-row"><span class="t-key">FPS</span><span class="t-val">{{ fps || '…' }}</span></div>
        <div class="t-row"><span class="t-key">MEM</span><span class="t-val">{{ memText }}</span></div>
        <div class="t-row"><span class="t-key">UPTIME</span><span class="t-val">{{ uptime }}</span></div>
        <div class="t-div">
          <div class="t-row"><span class="t-key">DATE</span><span class="t-val">{{ dateText }}</span></div>
          <div class="t-row"><span class="t-key">CORE</span><span class="t-val">{{ coreText }}</span></div>
          <div class="t-row"><span class="t-key">TZ</span><span class="t-val">{{ tzText }}</span></div>
        </div>
      </div>

      <svg viewBox="0 0 400 400">
        <defs>
          <!-- 雷达扫过的扇形：从扫描边往回渐隐（颜色走令牌，见下方 CSS） -->
          <linearGradient id="hud-sweep" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stop-opacity="0.3" />
            <stop offset="1" stop-opacity="0" />
          </linearGradient>
          <!-- 核心辉光 -->
          <radialGradient id="hud-core" cx="0.5" cy="0.5" r="0.5">
            <stop class="hi" offset="0" stop-opacity="0.9" />
            <stop offset="0.55" stop-opacity="0.35" />
            <stop offset="1" stop-opacity="0" />
          </radialGradient>
        </defs>

        <!-- 最外圈双弧（50s 反向慢转） -->
        <g class="spin-outer">
          <circle cx="200" cy="200" r="193" fill="none" stroke-width="1" stroke-dasharray="420 186.3" opacity="0.26" />
        </g>

        <!-- 外圈刻度：90s 顺时针慢转 -->
        <g class="spin-slow">
          <line
            v-for="(t, i) in ticks"
            :key="i"
            :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2"
            :stroke-width="t.long ? 2 : 1"
            :opacity="t.long ? 0.75 : 0.35"
          />
        </g>

        <!-- 四段弧环：反向转 -->
        <g class="spin-rev">
          <circle cx="200" cy="200" r="160" fill="none" stroke-width="2.5" stroke-dasharray="205 46.33" opacity="0.5" />
        </g>

        <!-- 雷达外圈 + 主扫描扇形（5s 一圈）+ 回波（相位差半圈、更淡）+ 目标点 -->
        <circle cx="200" cy="200" r="150" fill="none" stroke-width="1" opacity="0.35" />
        <g class="sweep">
          <path d="M200 200 L200 50 A150 150 0 0 1 329.9 125 Z" fill="url(#hud-sweep)" />
          <line class="mid" x1="200" y1="200" x2="200" y2="50" stroke-width="1.5" opacity="0.8" />
        </g>
        <g class="sweep echo">
          <path d="M200 200 L200 50 A150 150 0 0 1 329.9 125 Z" fill="url(#hud-sweep)" opacity="0.45" />
        </g>

        <!-- 目标点 + 目标锁定括号（方框四角虚线段），与回波同步闪烁 -->
        <g v-for="(b, i) in blips" :key="i" class="blip-g" :class="`blip-${i + 1}`">
          <rect class="lock" :x="b.x - 9" :y="b.y - 9" width="18" height="18" fill="none" stroke-width="1.4" stroke-dasharray="4 12" stroke-dashoffset="2" />
          <circle class="hi blip" :cx="b.x" :cy="b.y" r="3" />
        </g>

        <!-- 中圈虚线：反向转 -->
        <g class="spin-rev-fast">
          <circle cx="200" cy="200" r="120" fill="none" stroke-width="1" stroke-dasharray="3 9" opacity="0.4" />
        </g>

        <!-- 内圈三段弧：顺时针 -->
        <g class="spin-mid">
          <circle cx="200" cy="200" r="94" fill="none" stroke-width="2" stroke-dasharray="140 56.87" opacity="0.55" />
        </g>

        <!-- 反应堆核心：辉光 + 六边形环（反转）+ 双环 + 三角，呼吸脉冲 -->
        <circle class="core-glow" cx="200" cy="200" r="58" fill="url(#hud-core)" />
        <g class="spin-hex">
          <path d="M200 152 L241.6 176 L241.6 224 L200 248 L158.4 224 L158.4 176 Z" fill="none" stroke-width="1.2" opacity="0.5" />
        </g>
        <g class="core">
          <circle class="mid" cx="200" cy="200" r="36" fill="none" stroke-width="1.5" opacity="0.85" />
          <circle cx="200" cy="200" r="24" fill="none" stroke-width="1" opacity="0.6" />
          <path class="hi" d="M200 182 L216 212 L184 212 Z" opacity="0.9" />
        </g>
      </svg>

      <!-- 右遥测：远程服务器资源（Linux 走 fs.read 读那台的 /proc+/sys，Windows 本机走主进程 IPC；实测）。
           HOST 身份行 + 细线下资源组，与左栏（3 行 + t-div 3 行）结构对称、精确等高 -->
      <div class="telemetry align-r">
        <div class="t-head">REMOTE</div>
        <div class="t-row">
          <span class="t-key">HOST</span>
          <!-- 主机名不长就完整显示；超过 10ch 才用 .host（16ch 上限 + 左缘渐隐），短名字不会被 mask 压住首字符 -->
          <span class="t-val" :class="{ host: hostName.length > 10 }">{{ hostName }}</span>
        </div>
        <div class="t-div">
          <div class="t-row"><span class="t-key">CPU</span><span class="t-val">{{ cpuText }}</span></div>
          <div class="t-row"><span class="t-key">RAM</span><span class="t-val">{{ ramText }}</span></div>
          <div class="t-row"><span class="t-key">GPU</span><span class="t-val">{{ gpuText }}</span></div>
          <div class="t-row"><span class="t-key">VRAM</span><span class="t-val">{{ vramText }}</span></div>
          <div class="t-row"><span class="t-key">PROC</span><span class="t-val">{{ procText }}</span></div>
        </div>
      </div>
    </div>

    <div class="hud-data">
      <span class="d time">{{ now }}</span>
      <span class="d" :class="{ on: linkReady }">◈ {{ linkText }}</span>
      <span class="d">{{ winText }}</span>
      <span v-if="store.pendingApprovalCount" class="d warn">
        ⚠ {{ String(store.pendingApprovalCount).padStart(2, '0') }} PENDING
      </span>
    </div>

    <div class="hex-stream">RX {{ hexLine }}</div>
  </div>
</template>

<style scoped>
.jarvis-hud {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  pointer-events: none;
  z-index: 0;
  /* 鼠标视差：整个 HUD 随鼠标轻微倾斜 + 平移（变量由 App.vue rAF 插值下发） */
  transform: perspective(1200px) rotateY(calc(var(--par-x, 0) * 2.6deg)) rotateX(calc(var(--par-y, 0) * -2deg));
  translate: calc(var(--par-x, 0) * 9px) calc(var(--par-y, 0) * 7px);
  /* 开机物质化：从模糊过曝里凝聚出来 */
  animation: hud-boot 1.1s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes hud-boot {
  from {
    opacity: 0;
    filter: blur(16px) brightness(2.2);
    transform: perspective(1200px) scale(1.06);
  }
}

/* 子层交错浮现：各自的最终透明度用 --o 分层（keyframes 里的 var 按元素解析） */
.hud-top,
.hud-data,
.hex-stream,
.telemetry {
  opacity: 0;
  animation: hud-fade 0.8s ease-out 0.35s forwards;
  --o: 1;
}

.hud-top {
  --o: 0.6;
}

.hex-stream {
  --o: 0.4;
  animation-delay: 0.6s;
}

@keyframes hud-fade {
  to {
    opacity: var(--o, 1);
  }
}

.hud-top {
  font-size: 11px;
  letter-spacing: 5px;
  color: var(--accent);
  text-transform: uppercase;
  text-shadow: 0 0 12px var(--accent-a45);
}

.hud-stage {
  display: flex;
  align-items: center;
  gap: 4.5vmin;
}

svg {
  width: min(54vmin, 470px);
  height: auto;
  opacity: 0.55;
  filter: drop-shadow(0 0 6px var(--accent-a25));
}

/* 雷达配色全走令牌（CSS 覆盖 SVG 表现属性，改 --accent 全套跟随）：
   默认描边/渐变 = --accent；.mid = 亮一档；.hi = 最亮档填充/渐变。
   注意规则顺序：通用描边 → .mid 加亮 → .blip/.core-glow/锁定框描边恢复。 */
.jarvis-hud svg :is(line, circle) {
  stroke: var(--accent);
}

.jarvis-hud svg :is(line, circle).mid {
  stroke: var(--accent-bright);
}

.jarvis-hud svg :is(.blip, .core-glow) {
  stroke: none;
}

.jarvis-hud svg .lock {
  stroke: var(--accent-a80);
}

.jarvis-hud svg .spin-hex path {
  stroke: var(--accent-a60);
}

.jarvis-hud stop {
  stop-color: var(--accent);
}

.jarvis-hud stop.hi {
  stop-color: var(--accent-brighter);
}

.jarvis-hud svg .hi:not(stop) {
  fill: var(--accent-brighter);
}

/* ---- 两侧遥测：真实数据，HUD 等宽小字 ---- */
.telemetry {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-family: var(--font-hud);
  font-size: 10.5px;
  letter-spacing: 1.5px;
  min-width: 9ch;
  border-left: 1px solid var(--accent-a22);
  padding-left: 10px;
}

.telemetry.align-r {
  border-left: none;
  border-right: 1px solid var(--accent-a22);
  padding-left: 0;
  padding-right: 10px;
  text-align: right;
}

.t-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 遥测分组标题（LOCAL / REMOTE） */
.t-head {
  color: var(--accent);
  opacity: 0.55;
  font-size: 9px;
  letter-spacing: 2.5px;
  margin-bottom: -4px;
}

/* 遥测第二组（左遥测下方的日期/核数/时区）：细线隔开 */
.t-div {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--accent-a22);
}

.t-key {
  color: var(--accent);
  opacity: 0.55;
  font-size: 9px;
}

.telemetry.align-r .t-key {
  text-align: right;
}

.t-val {
  color: var(--text-2);
  text-shadow: 0 0 8px var(--accent-a25);
}

/* 主机名超宽时左缘渐隐（右对齐保尾端，照会话名行的渐隐偏好，不用 … 截断） */
.t-val.host {
  max-width: 16ch;
  align-self: flex-end;
  overflow: hidden;
  white-space: nowrap;
  mask-image: linear-gradient(270deg, #000 calc(100% - 14px), transparent);
  -webkit-mask-image: linear-gradient(270deg, #000 calc(100% - 14px), transparent);
}

.hud-data {
  display: flex;
  gap: 18px;
  font-family: var(--font-hud);
  font-size: 12px;
  letter-spacing: 2px;
  color: var(--text-2);
}

.d.on {
  color: var(--accent);
  text-shadow: 0 0 10px var(--accent-a50);
}

.d.warn {
  color: var(--warn);
}

.d.time {
  color: var(--accent);
  opacity: 0.8;
}

/* ---- hex 数据流：装饰性 RX 流，两端渐隐 ---- */
.hex-stream {
  font-family: var(--font-hud);
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--accent);
  opacity: 0;
  max-width: min(64vmin, 560px);
  overflow: hidden;
  white-space: nowrap;
  mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
}

/* ---- 旋转动画：transform-origin 固定在 viewBox 中心 ---- */
.spin-slow, .spin-rev, .spin-rev-fast, .spin-mid, .sweep, .spin-outer, .spin-hex {
  transform-origin: 200px 200px;
}
.spin-slow      { animation: hud-spin 90s linear infinite; }
.spin-rev       { animation: hud-spin-rev 40s linear infinite; }
.spin-rev-fast  { animation: hud-spin-rev 30s linear infinite; }
.spin-mid       { animation: hud-spin 24s linear infinite; }
.sweep          { animation: hud-spin 5s linear infinite; }
.sweep.echo     { animation-delay: -2.5s; }
.spin-outer     { animation: hud-spin-rev 50s linear infinite; }
.spin-hex       { animation: hud-spin-rev 21s linear infinite; }

@keyframes hud-spin {
  to { transform: rotate(360deg); }
}
@keyframes hud-spin-rev {
  to { transform: rotate(-360deg); }
}

/* 核心呼吸 */
.core {
  transform-origin: 200px 200px;
  animation: hud-pulse 3s ease-in-out infinite;
}
@keyframes hud-pulse {
  50% { opacity: 0.65; transform: scale(0.96); }
}

/* 目标点：相位错开，像被雷达扫到的回波；锁定括号同步 */
.blip-g { animation: hud-blip 5s linear infinite; }
.blip-2 { animation-delay: -1.7s; }
.blip-3 { animation-delay: -3.4s; }
@keyframes hud-blip {
  0%, 70% { opacity: 0.15; }
  80% { opacity: 1; }
  95%, 100% { opacity: 0.15; }
}

/* 注：装饰动画不随系统 prefers-reduced-motion 关闭——动效是主题核心体验，
   本机 Windows 关了「动画效果」，跟随 hint 会静默变纯静态（实测 matchMedia 报 reduce）。 */
</style>
