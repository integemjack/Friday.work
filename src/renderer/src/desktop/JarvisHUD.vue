<script setup lang="ts">
// 贾维斯 HUD（2026-10 重做：3D 全息舞台）：桌面中央一座纯 CSS 3D 的全息投影台——
// 透视地面上的投影基座（刻度环 + 环形字带 + 扩散波纹）往上打一道光锥，托起一颗斜轴自转的
// 线框地球（经线 + 纬线），两条轨道环带卫星点穿过它前后（preserve-3d 真实深度排序），中心是反应堆核。
// 内容只留真实且有用的两块，做成两侧向内斜的全息玻璃板（像座舱 HUD）：
//   左板：时钟 / 日期 / 机器连接状态；右板：当前服务器 CPU/RAM/GPU 条形仪表 + 显存/进程数
//   （Linux 走 fs.read 读 /proc+/sys，Windows 本机走主进程 IPC，异机走 sysstats.json 桥）。
// 原来的标题行、hex 流、FPS/内存/运行时长/核数/时区/窗口数全部拿掉（信息噪音）。
// 随鼠标整台 3D 转动（--par-x/--par-y 由 App.vue 直接写到带 data-parallax 的 .stage 上，rAF 已插值），
// 各层在不同深度，转起来有真实视差。动画全是 transform/opacity（合成器线程），不逐帧重绘。
// 只在「贾维斯界面」下挂载（App.vue 里 v-if="jarvis"），别的主题不渲染、零开销。
import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { useAppStore } from '../stores/app.js'
import { rpc } from '../lib/host.js'
import type { FsListResult, FsReadResult } from '../../../protocol/rpc/protocol.js'
import type { SysStatsSnapshot } from '../../../shared/api.js'

const store = useAppStore()

const pad = (n: number): string => String(n).padStart(2, '0')

// ---- 心跳：每秒刷新时钟 / 日期 ----
const clock = ref('')
const seconds = ref('')
const dateText = ref('')
let timer = 0

function tick(): void {
  const d = new Date()
  clock.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  seconds.value = pad(d.getSeconds())
  const week = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()]
  dateText.value = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${week}`
}

// ---- 远程服务器资源（真实数据，不是装饰）：按服务器平台分派数据源 ----
//   Linux   —— 协议 fs.read 读那台的 /proc（CPU 差值 / RAM / loadavg 进程数），
//              GPU/显存再试 /sys/class/drm/card*/device（AMD/Intel 暴露 sysfs，NVIDIA 与虚拟机没有 → N/A）；
//   Windows —— 两级：①「服务器就是本机」时走 fridayBridge.systemStats IPC（主进程 os.cpus 差值
//              + nvidia-smi + tasklist）。是不是本机不看 hostname（同镜像装的机器常重名、老服务端
//              不报 hostname，原来会把客户端自己的资源当成服务器的显示）：主进程在本机放一个随机名
//              探针文件，fs.read 去服务器上读同一路径，读得到才算本机；
//              ②其余情况协议 fs.read 读服务器上 %ProgramData%\Friday\sysstats.json——那份文件由
//              服务器机器上的 Friday Work 主进程或 FridaySysStats.exe 每 3 秒写入（协议没有系统采样方法，
//              这是纯客户端仓库内的跨机器桥）；新鲜度只看 at 变没变（at 是服务器的钟，不和本机的钟比：
//              两台差十几秒很常见，原来钟快的客户端永远判过期）；读不到 / 超过 10 秒没变 → N/A。
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
let disposed = false // 组件已卸载：不再排下一轮
let polling = false // 上一轮还挂着就不并发发第二轮（通道慢时避免请求堆积）
let roundOk = false // 这一轮至少取到了一项：决定下一轮 3 秒还是退避 10 秒
let prevCpu: { idle: number; total: number } | null = null
let polledMachine = ''
let gpuCard: string | null = null // Linux 那台探到的 DRM 卡名（/sys/class/drm/card0…）；'' = 探过、没有
let gpuTries = 0 // GPU sysfs 连续读不到的轮数，够几轮就判定这台没有可用接口
let selfCheck: '' | 'self' | 'other' = '' // Windows 服务器是不是本机；'' = 还没定（探针读超时，下轮再探）
// sysstats.json 新鲜度（全用本机时钟计时，不碰服务器的 at 值本身）
let snapAt: number | null = null // 上次读到的 at
let snapChangedAt = 0 // 本机时钟：上次看到 at 变化（或第一次看到它）的时刻
let snapLive = false // 见过 at 变化 = 确认那台有人在写；第一眼看到的可能是早没人写的旧文件

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

/** 换机器 / 断开：服务器相关的判定全部重来 */
function resetServerState(): void {
  clearHolds()
  prevCpu = null
  gpuCard = null
  gpuTries = 0
  selfCheck = ''
  snapAt = null
  snapChangedAt = 0
  snapLive = false
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
 *  服务器上 Friday Work / FridaySysStats.exe 写的 %ProgramData%\Friday\sysstats.json。
 *  新鲜度只看 at 变没变、用本机时钟计时：写入方每 3 秒换一次 at，10 秒没变就是那台没在写了。
 *  第一眼看到的 at 还不能信（可能是早没人写的旧文件），显示 … 等它变一次；
 *  读不到 / JSON 坏了 / 10 秒没变 → 按这轮没取到处理。 */
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
  if (!s || typeof s.at !== 'number') {
    missedRound()
    return
  }
  const now = Date.now()
  if (s.at !== snapAt) {
    if (snapAt !== null) snapLive = true
    snapAt = s.at
    snapChangedAt = now
  }
  if (now - snapChangedAt > REMOTE_STATS_FRESH_MS) {
    // 10 秒没变：那台没在写（没跑采集 / 刚断），等它再变才重新采信
    snapLive = false
    missedRound()
    return
  }
  if (!snapLive) {
    // 还没见过它变：先显示 …（读是通的，下一轮照常 3 秒）
    for (const key of Object.keys(metricRefs) as MetricKey[]) if (!holds.has(key)) setMetric(key, '…')
    roundOk = true
    return
  }
  applyStats(s)
}

/** 服务器是不是本机：fs.read 去服务器上读本机主进程放的随机名探针文件。
 *  读到 = 本机；服务器回错误码（没这个文件 / 不让读）= 不是；
 *  超时或本地传输层报错（没有错误码）不下结论，回 ''，下轮再探。 */
async function checkSelf(machineID: string): Promise<'' | 'self' | 'other'> {
  const bridge = window.fridayBridge
  let path: string | null = null
  try {
    path = bridge?.selfProbePath ? await bridge.selfProbePath() : null
  } catch {
    path = null
  }
  if (!path) return 'other'
  try {
    const r = await Promise.race([
      rpc(machineID, 'fs.read', { path, offset: 0, length: 64 }),
      new Promise((resolve) => setTimeout(() => resolve(null), 4000))
    ])
    return r ? 'self' : ''
  } catch (error) {
    return typeof (error as { code?: unknown }).code === 'number' ? 'other' : ''
  }
}

/** Windows 服务器：探针确认是本机才用本机 IPC（最快最准），其余都走 fs.read 读 json 桥。 */
async function pollWindowsServer(machineID: string): Promise<void> {
  if (!selfCheck) {
    const result = await checkSelf(machineID)
    // 探的过程中换了机器 / 断了：结果作废
    if (polledMachine === machineID) selfCheck = result
  }
  const bridge = window.fridayBridge
  if (selfCheck === 'self' && bridge?.systemStats) {
    try {
      applyStats(await bridge.systemStats())
      return
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
  // 卸载时这一轮可能还挂在 await 上：clearTimeout 清不到它待会儿排的下一轮，靠 disposed 拦住，
  // 不然卸掉的 HUD（切主题、热更新）会在后台一直轮询下去
  const next = (delay: number): void => {
    if (disposed) return
    // 一次只留一个排程：不清的话两条链并存（下面的 polling 分支就出过这事）
    window.clearTimeout(remoteTimer)
    remoteTimer = window.setTimeout(() => void pollRemote(), delay)
  }
  const machineID = store.currentMachine
  const info = store.currentMachineInfo
  if (!machineID || info?.state !== 'ready') {
    hostName.value = 'N/A'
    resetServerState()
    resetRemote('NO LINK')
    polledMachine = machineID
    next(3000)
    return
  }
  if (machineID !== polledMachine) {
    // 换了台机器：重新起测
    polledMachine = machineID
    resetServerState()
    resetRemote('…')
  }
  if (polling) {
    // 上一轮还挂着（通道慢）：不并发发第二轮。这里不排下一轮——在飞的那轮结束时
    // 必然自己排（下面两个分支都排），这里再排就是第二条链，从此 1 秒 3 秒各走各的、
    // 对远端的 fs.read 探测频率翻倍且永不恢复
    return
  }
  polling = true
  roundOk = false
  hostName.value = info.serverInfo?.hostname || 'REMOTE'
  const platform = info.serverInfo?.platform
  try {
    if (platform === 'windows') {
      await pollWindowsServer(machineID)
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
// 连接状态的色调：就绪青、失败红、其它（连接中 / 版本不符 / 未连）琥珀
const linkTone = computed(() => {
  const state = store.currentMachineInfo?.state
  if (state === 'ready') return 'on'
  if (state === 'failed' || state === 'disconnected') return 'bad'
  return 'mid'
})

// 右板仪表：只有「NN%」能画条，其它（… / N/A / NO LINK / NO GPU）条归零、只显示文字
function ratioOf(text: string): number {
  const m = /^(\d+)%$/.exec(text)
  return m ? Math.min(1, Number(m[1]) / 100) : 0
}
const gauges = computed(() => [
  { key: 'CPU', text: cpuText.value, ratio: ratioOf(cpuText.value) },
  { key: 'RAM', text: ramText.value, ratio: ratioOf(ramText.value) },
  { key: 'GPU', text: gpuText.value, ratio: ratioOf(gpuText.value) }
])

// 地球纬线：纬度 φ 处的圈半径 = cosφ、离赤道高度 = sinφ（都按球半径归一）
const latitudes = [0, 35, -35, 65, -65].map((deg) => {
  const a = (deg * Math.PI) / 180
  return { k: Math.cos(a).toFixed(3), y: (-Math.sin(a)).toFixed(3) }
})

// 基座刻度环：72 根（每 6 根一根长的），几何在这里算好，模板只管画
const ticks = Array.from({ length: 72 }, (_, i) => {
  const a = (i * 5 * Math.PI) / 180
  const long = i % 6 === 0
  const r1 = long ? 176 : 182
  return {
    x1: 200 + r1 * Math.cos(a),
    y1: 200 + r1 * Math.sin(a),
    x2: 200 + 190 * Math.cos(a),
    y2: 200 + 190 * Math.sin(a),
    long
  }
})

onMounted(() => {
  tick()
  timer = window.setInterval(tick, 1000)
  void pollRemote()
})
onBeforeUnmount(() => {
  disposed = true
  window.clearInterval(timer)
  window.clearTimeout(remoteTimer)
})
</script>

<template>
  <div class="jarvis-hud" aria-hidden="true">
    <!-- 3D 舞台：所有层都在同一个 preserve-3d 空间里，鼠标视差转的是整台 -->
    <div class="stage" data-parallax>
      <!-- 透视地面：投影基座（网格 + 刻度/字带环 + 扩散波纹），压平成地板 -->
      <div class="floor">
        <div class="floor-grid" />
        <svg class="pad spin-slow" viewBox="0 0 400 400">
          <defs>
            <!-- 逆时针走：转到近处（下半圈）的字是正的，远处被压扁的上半圈才倒着 -->
            <path id="hud-ring-path" d="M40,200 a160,160 0 1,0 320,0 a160,160 0 1,0 -320,0" />
          </defs>
          <circle cx="200" cy="200" r="192" fill="none" stroke-width="1" opacity="0.5" />
          <line
            v-for="(t, i) in ticks"
            :key="i"
            :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2"
            :stroke-width="t.long ? 2 : 1"
            :opacity="t.long ? 0.85 : 0.4"
          />
          <text class="ring-text">
            <textPath href="#hud-ring-path" textLength="1000" lengthAdjust="spacing">
              FRIDAY · HOLOGRAPHIC INTERFACE · SYSTEM ONLINE · FRIDAY · HOLOGRAPHIC INTERFACE · SYSTEM ONLINE ·
            </textPath>
          </text>
        </svg>
        <svg class="pad spin-rev" viewBox="0 0 400 400">
          <circle cx="200" cy="200" r="140" fill="none" stroke-width="3" stroke-dasharray="160 59.9" opacity="0.6" />
          <circle cx="200" cy="200" r="118" fill="none" stroke-width="1" stroke-dasharray="2 8" opacity="0.55" />
          <circle class="mid" cx="200" cy="200" r="44" fill="none" stroke-width="2" opacity="0.8" />
        </svg>
        <div class="ripple" />
        <div class="ripple r2" />
      </div>

      <!-- 光锥：从基座往上打到地球，竖向光纹 + 轻微闪烁 -->
      <div class="beam" />

      <!-- 线框地球（斜轴自转）+ 两条轨道环：同一 3D 空间里互相穿插，前后遮挡由浏览器深度排序 -->
      <div class="globe-wrap">
        <div class="globe">
          <i v-for="n in 6" :key="`lon${n}`" class="lon" :class="{ dash: n % 2 === 0 }" :style="{ '--i': n }" />
          <i v-for="(l, n) in latitudes" :key="`lat${n}`" class="lat" :style="{ '--k': l.k, '--y': l.y }" />
        </div>
        <div class="orbit o1"><div class="orbit-spin"><span class="sat" /></div></div>
        <div class="orbit o2"><div class="orbit-spin"><span class="sat" /></div></div>
      </div>

      <!-- 反应堆核：球心的光核 + 三角徽记（始终正对观察者） -->
      <div class="nucleus" />
      <svg class="reactor" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="30" fill="none" stroke-width="1.5" stroke-dasharray="14 5.7" />
        <path d="M50 34 L64 58 L36 58 Z" />
      </svg>

      <!-- 全息扫描纹：盖在地球前面（离观察者更近的一层），细横纹 + 一道上下扫的亮带 -->
      <div class="holo-scan" />

      <!-- 左板：时间 / 连接（向内斜的全息玻璃） -->
      <div class="panel left">
        <div class="p-head">SYS · TIME</div>
        <div class="clock">{{ clock }}<span class="sec">{{ seconds }}</span></div>
        <div class="p-sub">{{ dateText }}</div>
        <div class="link" :class="linkTone"><i class="led" />{{ linkText }}</div>
      </div>

      <!-- 右板：远程服务器资源（实测） -->
      <div class="panel right">
        <div class="p-head">
          <span>REMOTE</span>
          <span class="host" :class="{ long: hostName.length > 12 }">{{ hostName }}</span>
        </div>
        <div v-for="g in gauges" :key="g.key" class="gauge">
          <span class="g-key">{{ g.key }}</span>
          <span class="g-bar"><i :style="{ transform: `scaleX(${g.ratio})` }" /></span>
          <span class="g-val">{{ g.text }}</span>
        </div>
        <div class="p-foot">VRAM {{ vramText }} · PROC {{ procText }}</div>
      </div>
    </div>

    <!-- 窄主区（两侧板收起）时的状态行；待确认数两种宽度都显示 -->
    <div class="hud-status">
      <span class="s-time">{{ clock }}:{{ seconds }}</span>
      <span class="s-link" :class="{ on: linkReady }">◈ {{ linkText }}</span>
      <span v-if="store.pendingApprovalCount" class="s-warn">
        ⚠ {{ String(store.pendingApprovalCount).padStart(2, '0') }} PENDING
      </span>
    </div>
  </div>
</template>

<style scoped>
/* ============ 舞台尺寸 ============
   --s：舞台边长（地球直径 = 0.5s、基座直径 = 1.3s），跟主区容器走（App.vue .main-area 是 size 容器）：
   上让出语音波形屏、下让出输入台；宽主区再让出两侧玻璃板。--R = 地球半径。 */
.jarvis-hud {
  position: absolute;
  inset: 0;
  padding: 70px 0 118px;
  --s: clamp(150px, min(100cqw - 56px, (100cqh - 236px) / 1.14, 400px), 400px);
  --R: calc(var(--s) * 0.25);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  pointer-events: none;
  z-index: 0;
  perspective: 1100px;
  perspective-origin: 50% 40%;
  /* 开机物质化：从模糊过曝里凝聚出来（滤镜只在这 1.2 秒里有，之后不留） */
  animation: hud-boot 1.2s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes hud-boot {
  from {
    opacity: 0;
    filter: blur(14px) brightness(2.4);
  }
}

/* 舞台：整台 3D。基础仰视角 + 鼠标视差（Y 轴 ±9°、X 轴 ±6°，各层深度不同所以转起来有真实错位） */
.stage {
  position: relative;
  flex: none;
  width: var(--s);
  height: var(--s);
  transform-style: preserve-3d;
  transform: rotateX(calc(4deg + var(--par-y, 0) * -6deg)) rotateY(calc(var(--par-x, 0) * 9deg));
  translate: calc(var(--par-x, 0) * 8px) calc(var(--par-y, 0) * 6px);
}

.stage > * {
  position: absolute;
}

/* ============ SVG 配色：全走令牌（CSS 覆盖表现属性，改 --accent 全套跟随） ============ */
.jarvis-hud svg :is(line, circle) {
  stroke: var(--accent);
}

.jarvis-hud svg circle.mid {
  stroke: var(--accent-bright);
}

/* ============ 地面：投影基座 ============ */
.floor {
  left: 50%;
  top: 80%;
  width: calc(var(--s) * 1.3);
  aspect-ratio: 1;
  translate: -50% -50%;
  transform: rotateX(78deg);
}

.floor > * {
  position: absolute;
  inset: 0;
}

/* 地面网格：圆形渐隐，只在基座周围一圈 */
.floor-grid {
  inset: -30%;
  background-image:
    linear-gradient(var(--accent-a22) 1px, transparent 1px),
    linear-gradient(90deg, var(--accent-a22) 1px, transparent 1px);
  background-size: calc(var(--s) / 9) calc(var(--s) / 9);
  background-position: center;
  -webkit-mask-image: radial-gradient(circle closest-side, #000 18%, transparent 100%);
  mask-image: radial-gradient(circle closest-side, #000 18%, transparent 100%);
}

.pad {
  width: 100%;
  height: 100%;
  overflow: visible;
  filter: drop-shadow(0 0 4px var(--accent-a45));
  will-change: transform;
}

.ring-text {
  fill: var(--accent);
  font-family: var(--font-hud);
  font-size: 11px;
  letter-spacing: 1px;
  opacity: 0.75;
}

/* 扩散波纹：从基座中心往外扩、渐隐（scale + opacity，合成器线程） */
.ripple {
  border-radius: 50%;
  border: 1.5px solid var(--accent-a70);
  box-shadow:
    0 0 14px var(--accent-a40),
    inset 0 0 14px var(--accent-a25);
  opacity: 0;
  animation: hud-ripple 5s ease-out infinite;
  will-change: transform, opacity;
}

.ripple.r2 {
  animation-delay: -2.5s;
}

@keyframes hud-ripple {
  0% {
    transform: scale(0.12);
    opacity: 0;
  }
  12% {
    opacity: 0.9;
  }
  100% {
    transform: scale(1);
    opacity: 0;
  }
}

/* ============ 光锥 ============
   基座中心（80%）→ 球心（40%）。下窄上宽的梯形，竖向光纹叠在渐变上 */
.beam {
  left: 50%;
  top: 40%;
  width: calc(var(--s) * 0.62);
  height: 40%;
  translate: -50% 0;
  background:
    repeating-linear-gradient(90deg, transparent 0 7px, var(--accent-a10) 7px 8px),
    linear-gradient(0deg, var(--accent-a35), var(--accent-a10) 55%, transparent);
  clip-path: polygon(45% 100%, 55% 100%, 100% 0, 0 0);
  -webkit-mask-image: linear-gradient(0deg, #000 30%, transparent);
  mask-image: linear-gradient(0deg, #000 30%, transparent);
  animation: hud-flicker 6s steps(1, end) infinite;
}

@keyframes hud-flicker {
  0%, 100% { opacity: 0.85; }
  41% { opacity: 0.55; }
  43% { opacity: 0.9; }
  71% { opacity: 0.7; }
  73% { opacity: 0.85; }
}

/* ============ 线框地球 ============ */
.globe-wrap {
  left: 50%;
  top: 40%;
  width: calc(var(--R) * 2);
  height: calc(var(--R) * 2);
  translate: -50% -50%;
  transform-style: preserve-3d;
  /* 斜轴 + 略俯视：北极朝观察者倾一点，纬线圈看得出椭圆 */
  transform: rotateX(-16deg) rotateZ(-14deg);
}

.globe {
  position: absolute;
  inset: 0;
  transform-style: preserve-3d;
  animation: hud-spin-y 32s linear infinite;
}

.globe > i {
  position: absolute;
  border-radius: 50%;
  border: 1px solid var(--accent-a50);
  box-shadow: 0 0 6px var(--accent-a25);
}

/* 经线：6 个大圆绕竖轴每 30° 一个（12 条经线） */
.lon {
  inset: 0;
  transform: rotateY(calc(var(--i) * 30deg));
}

.lon.dash {
  border-style: dashed;
  border-color: var(--accent-a35);
}

/* 纬线：半径 cosφ、高度 sinφ，放平（rotateX 90°）再抬到对应高度 */
.lat {
  left: 50%;
  top: 50%;
  width: calc(var(--k) * 100%);
  aspect-ratio: 1;
  translate: -50% -50%;
  transform: translateY(calc(var(--y) * var(--R))) rotateX(90deg);
  border-color: var(--accent-a35);
}

/* 轨道环：两条不同倾角的环带一颗卫星点，环在自己平面里转 */
.orbit {
  position: absolute;
  border-radius: 50%;
  border: 1px solid var(--accent-a30);
}

.orbit.o1 {
  inset: -24%;
  transform: rotateX(76deg) rotateY(-12deg);
}

.orbit.o2 {
  inset: -42%;
  border-style: dashed;
  border-color: var(--accent-a22);
  transform: rotateX(68deg) rotateY(24deg);
}

.orbit-spin {
  position: absolute;
  inset: 0;
  animation: hud-spin 10s linear infinite;
  will-change: transform;
}

.o2 .orbit-spin {
  animation: hud-spin-rev 17s linear infinite;
}

.sat {
  position: absolute;
  left: 50%;
  top: -3px;
  width: 6px;
  height: 6px;
  margin-left: -3px;
  border-radius: 50%;
  background: var(--accent-brighter);
  box-shadow: 0 0 10px var(--accent), 0 0 3px #fff;
}

/* ============ 反应堆核 ============ */
.nucleus {
  left: 50%;
  top: 40%;
  width: calc(var(--s) * 0.22);
  aspect-ratio: 1;
  translate: -50% -50%;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    #fff 0,
    var(--accent-brighter) 12%,
    var(--accent-a55) 30%,
    var(--accent-a12) 52%,
    transparent 70%
  );
  animation: hud-pulse 3.2s ease-in-out infinite;
  will-change: transform, opacity;
}

.reactor {
  left: 50%;
  top: 40%;
  width: calc(var(--s) * 0.13);
  height: calc(var(--s) * 0.13);
  translate: -50% -50%;
  overflow: visible;
  filter: drop-shadow(0 0 3px var(--accent));
  animation: hud-spin-rev 14s linear infinite;
  will-change: transform;
}

.reactor circle {
  stroke: var(--accent-brighter);
  opacity: 0.9;
}

.reactor path {
  fill: none;
  stroke: #fff;
  stroke-width: 2;
  opacity: 0.85;
}

@keyframes hud-pulse {
  50% {
    opacity: 0.7;
    transform: scale(0.88);
  }
}

/* ============ 全息扫描纹 ============
   放在地球前方（translateZ 一个半径多），细横纹压暗出全息质感，亮带每 4.5 秒从上扫到下 */
.holo-scan {
  left: 50%;
  top: 40%;
  width: calc(var(--R) * 2.9);
  height: calc(var(--R) * 2.9);
  translate: -50% -50%;
  transform: translateZ(calc(var(--R) * 1.3));
  border-radius: 50%;
  overflow: hidden;
  background: repeating-linear-gradient(0deg, transparent 0 2px, rgba(3, 8, 16, 0.32) 2px 3px);
  -webkit-mask-image: radial-gradient(circle closest-side, #000 55%, transparent);
  mask-image: radial-gradient(circle closest-side, #000 55%, transparent);
}

.holo-scan::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -30%;
  height: 30%;
  background: linear-gradient(180deg, transparent, var(--accent-a14) 85%, var(--accent-a30));
  animation: hud-scan 4.5s cubic-bezier(0.45, 0, 0.55, 1) infinite;
  will-change: transform;
}

@keyframes hud-scan {
  to {
    transform: translateY(433%);
  }
}

/* ============ 两侧全息玻璃板（座舱式向内斜：外缘朝观察者） ============ */
.panel {
  top: 40%;
  width: 200px;
  translate: 0 -50%;
  display: none; /* 宽主区才出（见文末 @container） */
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  font-family: var(--font-hud);
  color: var(--text-2);
  background:
    /* 四角括号 */
    linear-gradient(var(--accent) 0 0) left top / 10px 1px,
    linear-gradient(var(--accent) 0 0) left top / 1px 10px,
    linear-gradient(var(--accent) 0 0) right top / 10px 1px,
    linear-gradient(var(--accent) 0 0) right top / 1px 10px,
    linear-gradient(var(--accent) 0 0) left bottom / 10px 1px,
    linear-gradient(var(--accent) 0 0) left bottom / 1px 10px,
    linear-gradient(var(--accent) 0 0) right bottom / 10px 1px,
    linear-gradient(var(--accent) 0 0) right bottom / 1px 10px,
    /* 细横纹 + 玻璃底 */
    repeating-linear-gradient(0deg, transparent 0 3px, var(--accent-a4) 3px 4px),
    linear-gradient(135deg, var(--accent-a10), var(--accent-a4) 60%, transparent);
  background-repeat: no-repeat;
  border: 1px solid var(--accent-a18);
  box-shadow: 0 0 24px var(--accent-a8), inset 0 0 18px var(--accent-a8);
  opacity: 0;
  animation: hud-fade 0.8s ease-out 0.45s forwards;
}

.panel.left {
  right: calc(100% + 40px);
  transform-origin: right center;
  transform: rotateY(26deg);
}

.panel.right {
  left: calc(100% + 40px);
  transform-origin: left center;
  transform: rotateY(-26deg);
}

@keyframes hud-fade {
  to {
    opacity: 1;
  }
}

.p-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--accent-a22);
  font-size: 9px;
  letter-spacing: 2.5px;
  color: var(--accent);
  opacity: 0.75;
}

.p-head .host {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  letter-spacing: 1px;
  color: var(--text-2);
}

/* 主机名超长才左缘渐隐（短名字不被 mask 压住首字符；不用 … 截断） */
.p-head .host.long {
  display: flex;
  justify-content: flex-end;
  -webkit-mask-image: linear-gradient(270deg, #000 calc(100% - 12px), transparent);
  mask-image: linear-gradient(270deg, #000 calc(100% - 12px), transparent);
}

.clock {
  font-size: 34px;
  line-height: 1;
  letter-spacing: 1px;
  color: var(--heading-bright);
  text-shadow: 0 0 14px var(--accent-a60);
}

.clock .sec {
  margin-left: 4px;
  font-size: 14px;
  color: var(--accent);
}

.p-sub {
  font-size: 10.5px;
  letter-spacing: 2px;
  color: var(--text-2);
}

.link {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 2px;
  font-size: 10.5px;
  letter-spacing: 2px;
  color: var(--warn);
}

.link .led {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 8px currentColor;
}

.link.on {
  color: var(--accent);
}

.link.bad {
  color: var(--fail);
}

.gauge {
  display: grid;
  grid-template-columns: 28px 1fr 44px;
  align-items: center;
  gap: 8px;
  font-size: 10.5px;
  letter-spacing: 1px;
}

.g-key {
  font-size: 9px;
  color: var(--accent);
  opacity: 0.7;
}

/* 分段能量条：底槽 + 按比例 scaleX 的填充（transform 过渡，不重排） */
.g-bar {
  position: relative;
  height: 6px;
  background: var(--accent-a10);
  -webkit-mask-image: repeating-linear-gradient(90deg, #000 0 4px, transparent 4px 6px);
  mask-image: repeating-linear-gradient(90deg, #000 0 4px, transparent 4px 6px);
}

.g-bar > i {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, var(--accent-a60), var(--accent-brighter));
  transform-origin: left center;
  transition: transform 0.6s ease;
}

.g-val {
  text-align: right;
  white-space: nowrap;
  color: var(--text);
  text-shadow: 0 0 8px var(--accent-a30);
}

.p-foot {
  padding-top: 6px;
  border-top: 1px solid var(--accent-a22);
  font-size: 9px;
  letter-spacing: 1px;
  white-space: nowrap;
  color: var(--text-3);
}

/* ============ 状态行（窄主区） ============ */
.hud-status {
  /* 基座投影后的近端会伸出舞台框下沿：状态行往下让开，不压在字带环上（--s 的高度项已按 1.14 留出这段） */
  margin-top: calc(var(--s) * 0.14);
  display: flex;
  gap: 14px;
  font-family: var(--font-hud);
  font-size: 11.5px;
  letter-spacing: 2px;
  color: var(--text-2);
  opacity: 0;
  animation: hud-fade 0.8s ease-out 0.45s forwards;
}

.s-time {
  color: var(--accent);
  opacity: 0.8;
}

.s-link.on {
  color: var(--accent);
  text-shadow: 0 0 10px var(--accent-a50);
}

.s-warn {
  color: var(--warn);
}

/* ============ 动画 ============ */
.spin-slow {
  animation: hud-spin 80s linear infinite;
}

.spin-rev {
  animation: hud-spin-rev 36s linear infinite;
}

@keyframes hud-spin {
  to { transform: rotate(360deg); }
}
@keyframes hud-spin-rev {
  to { transform: rotate(-360deg); }
}
@keyframes hud-spin-y {
  to { transform: rotateY(360deg); }
}

/* 注：装饰动画不随系统 prefers-reduced-motion 关闭——动效是主题核心体验，
   本机 Windows 关了「动画效果」，跟随 hint 会静默变纯静态（实测 matchMedia 报 reduce）。 */

/* ============ 响应式（放在最后：压过上面同优先级的基础规则） ============ */
/* 宽主区：两侧玻璃板出来，舞台让出两板的宽度；时间/连接挪进左板，状态行只留待确认数 */
/* 窄主区：左下角的媒体叠会和状态行重叠，下边让得更多（让过媒体叠） */
@container main (max-width: 600px) {
  .jarvis-hud {
    padding-bottom: 196px;
    --s: clamp(130px, min(100cqw - 96px, (100cqh - 314px) / 1.14, 400px), 400px); /* 基座 1.3s 宽，别压到两侧栏 */
  }

  .hud-status {
    gap: 10px;
    letter-spacing: 1px;
  }
}

@container main (min-width: 760px) {
  .jarvis-hud {
    --s: clamp(200px, min(100cqw - 580px, (100cqh - 236px) / 1.14, 420px), 420px);
  }

  .panel {
    display: flex;
  }

  .s-time,
  .s-link {
    display: none;
  }
}
</style>
