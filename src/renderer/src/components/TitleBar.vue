<script setup lang="ts">
// 标题栏：应用名 │ 当前机器（点开机器列表）│ 连接状态点
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { WindowKind } from '../stores/app.js'
import { useAppStore } from '../stores/app.js'
import { wallpaperMode } from '../lib/wallpaperMode.js'
import AttachmentsPop from './AttachmentsPop.vue'

const store = useAppStore()

const stateDot = computed(() => {
  switch (store.currentMachineInfo?.state) {
    case 'ready': return 'ok'
    case 'connecting': return 'run'
    case 'failed': case 'versionMismatch': return 'fail'
    default: return 'off'
  }
})

const stateText = computed(() => {
  switch (store.currentMachineInfo?.state) {
    case 'ready': return '已连接'
    case 'connecting': return '连接中'
    case 'failed': return '连接失败'
    case 'versionMismatch': return '版本不匹配'
    default: return '未连接'
  }
})

const machineMenuOpen = ref(false)

function toggleMachineMenu() {
  machineMenuOpen.value = !machineMenuOpen.value
}

// 机器菜单开着时 Esc 收起（遮罩点一下也收）
function onMenuKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault() // 这次 Esc 已用来收菜单，别再取消选中会话（App.vue）
    machineMenuOpen.value = false
  }
}
watch(machineMenuOpen, (open) => {
  if (open) window.addEventListener('keydown', onMenuKey)
  else window.removeEventListener('keydown', onMenuKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onMenuKey))

async function pickMachine(id: string) {
  machineMenuOpen.value = false
  await store.selectMachine(id)
}

const hasNoMachine = computed(() => store.machines.length === 0)

// 实时运行指示（右上角）：运行中的智能体数 + token 速度（runner 事件实时推，REMOTE.md §5）
const agentCount = computed(() => store.runnerState?.liveAgents ?? 0)
const speedText = computed(() => {
  const speed = store.runnerState?.liveSpeed ?? 0
  return speed >= 100 ? speed.toFixed(0) : speed.toFixed(1)
})

// 窗口启动器：终端 / 浏览器 / 文件（会话用到时自动弹，但受设置「接受远程打开/关闭窗口」管；
// 手动最小化的不会被远程弹回，只在这里点图标恢复）+ 子 Agent / 设置；
// 会话列表 / 聊天 / 通话是常驻面板，不在这里
const launchers: Array<{ kind: WindowKind; label: string }> = [
  { kind: 'terminals', label: '终端' },
  { kind: 'browser', label: '浏览器' },
  { kind: 'files', label: '文件' },
  { kind: 'agents', label: '子 Agent' },
  { kind: 'devices', label: '设备（这台电脑上能给远端用的串口、摄像头、手机）' },
  { kind: 'settings', label: '设置' }
]

/** 终端数角标（有在跑的终端时显示） */
function badgeOf(kind: WindowKind): number {
  if (kind === 'terminals') return store.terminals.length
  if (kind === 'browser') return store.browserTabs.length
  return 0
}

function launch(kind: WindowKind) {
  // 终端 / 浏览器：窗口里一个标签都没有时顺手开一个（不然打开的是个空窗口，还得再点 ＋）
  if (kind === 'terminals' || kind === 'browser') store.launchToolWindow(kind)
  else store.openWindow(kind)
}

function kindOpen(kind: WindowKind): boolean {
  return store.windows.some((item) => item.kind === kind)
}

// 无边框窗口的窗控（preload 暴露的 IPC；模板里拿不到 window 全局，setup 里取一次）
const bridge = window.fridayBridge

/** 退出桌面背景模式（标题栏窗控在壁纸模式下换成的那个钮） */
async function exitWallpaper(): Promise<void> {
  await window.fridayBridge.wallpaperSetEnabled(false)
}
</script>

<template>
  <header class="titlebar" :class="{ fullscreen: wallpaperMode }">
    <div class="brand">Friday</div>

    <!-- 窗口启动器：点亮=已开；点击开/置顶/还原最小化（没有任务栏后的唯一入口）。
         「文件」后面插附件钮（看图/看视频/听录音的归档，点开弹标签浮窗）——
         和内容类工具一组，随启动器一起摆 -->
    <nav class="launcher">
      <template v-for="entry in launchers" :key="entry.kind">
        <button
          class="launch-btn"
          :class="{ open: kindOpen(entry.kind) }"
          :title="entry.label"
          :disabled="entry.kind !== 'settings' && entry.kind !== 'devices' && !store.connected"
          @click="launch(entry.kind)"
        >
        <svg v-if="entry.kind === 'terminals'" class="ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" stroke="currentColor" stroke-width="1.3" />
          <path d="m4.6 6.2 2 1.8-2 1.8M8.4 10.2h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else-if="entry.kind === 'browser'" class="ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.3" />
          <path d="M1.8 8h12.4M8 1.8c1.8 1.7 2.7 3.8 2.7 6.2S9.8 12.5 8 14.2M8 1.8C6.2 3.5 5.3 5.6 5.3 8s.9 4.5 2.7 6.2" stroke="currentColor" stroke-width="1.2" />
        </svg>
        <svg v-else-if="entry.kind === 'files'" class="ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M1.8 4.3c0-.7.5-1.2 1.2-1.2h3.1l1.5 1.6H13c.7 0 1.2.5 1.2 1.2v6.3c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          <path d="M1.8 7h12.4" stroke="currentColor" stroke-width="1.2" />
        </svg>
        <svg v-else-if="entry.kind === 'agents'" class="ico" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 1.6 12.4 7 7 12.4 1.6 7Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
          <path d="M7 4.8 9.2 7 7 9.2 4.8 7Z" fill="currentColor" />
        </svg>
        <svg v-else-if="entry.kind === 'devices'" class="ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M5.6 1.8v3M10.4 1.8v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          <path d="M3.6 4.8h8.8v2.4a4.4 4.4 0 0 1-8.8 0z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          <path d="M8 11.6v2.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        <svg v-else class="ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
          <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" />
        </svg>
        <span v-if="badgeOf(entry.kind)" class="launch-badge">{{ badgeOf(entry.kind) }}</span>
        </button>
        <AttachmentsPop v-if="entry.kind === 'files'" />
      </template>
    </nav>

    <!-- 沉浸开关：收起左栏会话列表和右栏聊天栏（通话面板除外），
         收起后左上角以背景形式显示在跑会话、右上角显示最近完成的会话（行可点选中并恢复两栏）；点亮 = 沉浸中 -->
    <button
      class="launch-btn view-toggle"
      :class="{ open: store.panelsHidden }"
      :title="store.panelsHidden ? '显示会话列表与聊天栏' : '收起会话列表与聊天栏（沉浸模式，左上角背景式显示在跑会话、右上角显示最近完成的会话，点行选中）'"
      @click="store.togglePanelsHidden()"
    >
      <svg class="ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M1.6 8C2.8 5.1 5.1 3.6 8 3.6s5.2 1.5 6.4 4.4c-1.2 2.9-3.5 4.4-6.4 4.4S2.8 10.9 1.6 8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
        <circle cx="8" cy="8" r="1.9" stroke="currentColor" stroke-width="1.3" />
        <path v-if="store.panelsHidden" d="M13.6 2.4 2.4 13.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
    </button>

    <div class="machine" @click="toggleMachineMenu">
      <span class="dot" :class="stateDot" />
      <span class="machine-name">{{ store.currentMachineInfo?.name ?? (hasNoMachine ? '还没有机器' : '选一台机器') }}</span>
      <span class="machine-state">{{ stateText }}</span>
      <svg class="chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M2.8 4.6 6 7.8l3.2-3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>
    <div class="spacer" />
    <!-- 实时运行指示（右上角）：智能体数 + token 速度；点击开子 Agent 窗口看详情 -->
    <button
      v-if="store.connected && store.runnerState"
      class="live-chip"
      :class="{ busy: agentCount > 0 }"
      :title="`运行中的智能体：${agentCount} 个 · Token 速度：${speedText} tok/s（点击打开子 Agent 窗口）`"
      @click="launch('agents')"
    >
      <span class="dot" :class="agentCount > 0 ? 'run' : 'off'" />
      <span class="live-agents">
        <svg class="ico" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 1.6 12.4 7 7 12.4 1.6 7Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          <path d="M7 4.8 9.2 7 7 9.2 4.8 7Z" fill="currentColor" />
        </svg>
        {{ agentCount }} 智能体
      </span>
      <span class="live-sep">·</span>
      <span class="live-speed">{{ speedText }} tok/s</span>
    </button>
    <!-- SChat 登录状态：未登录时给一条回登录页的入口（工作台里没别的地方能重新扫码） -->
    <button v-if="store.schat.phase !== 'online'" class="schat-entry" title="扫码登录 SChat（连机器人用）" @click="store.openLogin()">
      <span class="dot off" />
      未登录 · 扫码
    </button>
    <!-- 无边框窗口的窗控钮（frame:false；整个标题栏是拖拽区，全屏桌面模式下禁拖）——三个图标
         同 viewBox/同尺寸/同描边，大小严格一致。全屏桌面模式下最小化/关闭都没意义，
         换成一个「退出桌面」钮；被别的窗口盖住点不到时，输入浮层（Ctrl+Alt+F）上还有保底退出 -->
    <div class="win-controls">
      <button v-if="wallpaperMode" class="win-btn wallpaper-exit" title="退出全屏桌面模式（回到普通窗口）" @click="exitWallpaper()">
        退出桌面
      </button>
      <template v-else>
        <button class="win-btn" title="最小化" @click="bridge.winMinimize()">
          <svg class="ico" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2.2 6h7.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
        <button class="win-btn" title="最大化 / 还原" @click="bridge.winMaximizeToggle()">
          <svg class="ico" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1" stroke="currentColor" stroke-width="1.3" />
          </svg>
        </button>
        <button class="win-btn close" title="关闭" @click="bridge.winClose()">
          <svg class="ico" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3.1 3.1l5.8 5.8M8.9 3.1 3.1 8.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
      </template>
    </div>

    <teleport to="body">
      <div v-if="machineMenuOpen" class="menu-mask" @click="machineMenuOpen = false">
        <div class="menu" @click.stop>
          <div class="menu-title">机器</div>
          <button
            v-for="machine in store.machines"
            :key="machine.id"
            class="menu-item"
            :class="{ active: machine.id === store.currentMachine }"
            @click="pickMachine(machine.id)"
          >
            <span class="dot" :class="machine.state === 'ready' ? 'ok' : machine.state === 'disconnected' ? 'off' : 'run'" />
            <span class="menu-item-name">{{ machine.name }}</span>
            <span class="menu-item-detail">{{ machine.detail ?? machine.targetText }}</span>
          </button>
          <div v-if="hasNoMachine" class="menu-empty">还没有机器：在左边「添加机器」里连第一台</div>
        </div>
      </div>
    </teleport>
  </header>
</template>

<style scoped>
.titlebar {
  height: 44px;
  flex: none;
  display: flex;
  align-items: center;
  line-height: 1;
  gap: 14px;
  padding: 0 14px;
  background: var(--panel);
  /* 下缘发丝线用 box-shadow 画（不占布局高）：border-bottom 会在 44px 的 height（border-box）里吃掉 1px，
     flex 内容区只剩 43px，整行内容全都偏上 0.5px（CDP 实测 .machine top 9.5、中心 21.5 ≠ 可视中线 22） */
  box-shadow: inset 0 -1px 0 var(--border);
  -webkit-app-region: drag;
  user-select: none;
}

.titlebar button,
.titlebar .machine {
  -webkit-app-region: no-drag;
}

/* 全屏桌面模式下整条标题栏禁拖：无边框铺满整屏的「桌面」被拖出一块就穿帮了，
   退出靠窗控位置的「退出桌面」钮 / 设置页 / 输入条保底钮 */
.titlebar.fullscreen {
  -webkit-app-region: no-drag;
}

.launcher {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 2px;
}

.launch-btn {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  opacity: 0.62;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s, box-shadow 0.12s;
}

.launch-btn .ico {
  width: 15px;
  height: 15px;
  display: block;
}

.launch-btn:hover {
  background: var(--hover);
  opacity: 1;
}

.launch-btn {
  position: relative;
}

.launch-btn:disabled {
  opacity: 0.25;
  cursor: default;
}

.launch-btn:disabled:hover {
  background: transparent;
}

/* 数量角标（在跑的终端数 / 浏览器标签数） */
.launch-badge {
  position: absolute;
  top: 1px;
  right: 0;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--accent);
  color: var(--accent-foreground);
  font-size: 9px;
  font-weight: 700;
  line-height: 13px;
  text-align: center;
}

/* 内容工具组（终端/浏览器/文件/附件）和设置类之间留一道细分隔
   （附件钮是 AttachmentsPop 渲染的第 4 个 child，插在文件后面） */
.launch-btn:nth-child(4) {
  margin-right: 6px;
}

.launch-btn:nth-child(4)::after {
  content: '';
  position: absolute;
  right: -5px;
  top: 7px;
  bottom: 7px;
  width: 1px;
  background: var(--border);
}

/* 沉浸开关：和窗口启动器之间留一道同款细分隔（视图开关，不属于启动器组） */
.view-toggle {
  margin-left: 12px;
}

.view-toggle::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 7px;
  bottom: 7px;
  width: 1px;
  background: var(--border);
}

.launch-btn.open {
  opacity: 1;
  background: var(--accent-weak);
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--accent) 65%, transparent);
}

.win-controls {
  display: flex;
  gap: 2px;
  margin-left: 6px;
}

.win-btn {
  width: 36px;
  height: 30px;
  display: grid;
  place-items: center;
  border: none;
  padding: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}

/* 桌面背景模式下的「退出桌面」文本钮：沿用窗控高度，青色亮字提示这是回到普通窗口的出口 */
.win-btn.wallpaper-exit {
  width: auto;
  padding: 0 10px;
  font-size: 11px;
  color: var(--accent, #7fd8ec);
}

/* 窗控图标：同一 viewBox、同一渲染尺寸、同一描边粗细——三个一样大，grid 精确居中 */
.win-btn .ico {
  width: 10px;
  height: 10px;
  display: block;
}

.win-btn:hover {
  background: var(--hover);
  color: var(--text);
}

.win-btn.close:hover {
  background: rgba(251, 95, 125, 0.85);
  color: #fff;
}

.brand {
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0.5px;
}

.machine {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 10px;
  border-radius: 8px;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.machine:hover {
  background: var(--panel-2);
}

.machine-name {
  font-weight: 500;
  /* 中文字形在行框里偏下约 1px（MiSans/雅黑：inkAscent 11 / inkDescent 3，墨迹中心比行盒中心低 1，
     CDP canvas 实测），往上提 1，才和旁边的状态字、圆点、箭头落在同一条中线上（同 Qt 版 MachineBar 的做法） */
  transform: translateY(-1px);
}

.machine-state {
  color: var(--text-2);
  font-size: 12.5px;
}

.chevron {
  width: 10px;
  height: 10px;
  flex: none;
  color: var(--text-3);
}

.spacer {
  flex: 1;
}

.schat-entry {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: 8px;
  padding: 4px 10px;
  border: 1px solid color-mix(in srgb, var(--warn, #e3b341) 45%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--warn, #e3b341) 10%, transparent);
  color: var(--warn, #e3b341);
  font-size: 11px;
  cursor: pointer;
}

.schat-entry:hover {
  border-color: var(--warn, #e3b341);
}

.schat-entry .dot {
  width: 7px;
  height: 7px;
}

/* 实时运行指示：空闲时安静，有智能体在跑时点亮（run 色）+ 呼吸点 */
.live-chip {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-right: 8px;
  padding: 4px 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: border-color 0.15s, background 0.15s;
}

.live-chip:hover {
  border-color: var(--accent-a40);
  background: var(--hover);
}

.live-chip.busy {
  border-color: color-mix(in srgb, var(--run) 45%, transparent);
  background: color-mix(in srgb, var(--run) 10%, transparent);
  color: var(--text);
}

.live-chip .dot {
  width: 7px;
  height: 7px;
}

.live-chip.busy .dot {
  animation: live-pulse 1.4s ease-in-out infinite;
}

@keyframes live-pulse {
  50% {
    opacity: 0.35;
  }
}

.live-agents {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.live-agents .ico {
  width: 10px;
  height: 10px;
}

.live-sep {
  color: var(--text-3);
}

.live-speed {
  font-weight: 500;
}

.menu-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
}

.menu {
  position: absolute;
  top: 48px;
  left: 120px;
  min-width: 320px;
  max-width: 460px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.14);
  padding: 6px;
}

.menu-title {
  font-size: 12px;
  color: var(--text-2);
  padding: 6px 10px 4px;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border-radius: 8px;
}

.menu-item:hover {
  background: var(--panel-2);
}

.menu-item.active {
  background: var(--accent-weak);
}

.menu-item-name {
  font-weight: 500;
  flex: none;
}

.menu-item-detail {
  color: var(--text-3);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-empty {
  padding: 10px;
  color: var(--text-2);
  font-size: 13px;
}

/* 贾维斯界面：顶部标题栏变成 HUD 主控条——几乎全透（只留 blur 和两端青色辉光），不像一块盖在上面的板 */
[data-theme='jarvis'] .titlebar {
  position: relative;
  /* 发丝线改用 box-shadow（不占高，见 .titlebar 注释）；border 方案会让内容区剩 43px、整行偏上 0.5px */
  box-shadow: inset 0 -1px 0 var(--accent-a28);
  background:
    linear-gradient(90deg, var(--accent-a9), transparent 28%, transparent 72%, var(--accent-a9)),
    var(--panel-a22);
}

/* 下缘能量扫掠光：一段亮带周期性从左到右扫过发丝线 */
[data-theme='jarvis'] .titlebar::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 0;
  width: 24%;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--accent) 35%,
    var(--accent-bright) 50%,
    var(--accent) 65%,
    transparent
  );
  animation: titlebar-sweep 9s linear infinite;
  opacity: 0.65;
  pointer-events: none;
}

@keyframes titlebar-sweep {
  from {
    transform: translateX(-110%);
  }
  to {
    transform: translateX(520%);
  }
}

[data-theme='jarvis'] .brand {
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 5px;
  text-shadow: 0 0 12px var(--accent-a50);
}

/* 品牌名后面的终端光标块：硬闪烁 */
[data-theme='jarvis'] .brand::after {
  content: '';
  display: inline-block;
  width: 7px;
  height: 12px;
  margin-left: 7px;
  vertical-align: -1px;
  background: var(--accent);
  box-shadow: 0 0 9px var(--accent-a60);
  animation: brand-blink 1.1s linear infinite;
}

@keyframes brand-blink {
  0%, 49% {
    opacity: 1;
  }
  50%, 100% {
    opacity: 0;
  }
}

/* 状态点脉冲：一圈同色光环周期性扩散（颜色用 currentColor，状态色在下面补） */
[data-theme='jarvis'] .titlebar .dot {
  position: relative;
}

[data-theme='jarvis'] .titlebar .dot::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid currentColor;
  animation: dot-ring 2.4s ease-out infinite;
  opacity: 0;
}

[data-theme='jarvis'] .titlebar .dot.ok { color: var(--ok); }
[data-theme='jarvis'] .titlebar .dot.run { color: var(--run); }
[data-theme='jarvis'] .titlebar .dot.warn { color: var(--warn); }
[data-theme='jarvis'] .titlebar .dot.fail { color: var(--fail); }
[data-theme='jarvis'] .titlebar .dot.off { color: var(--text-3); }

@keyframes dot-ring {
  0% {
    transform: scale(1);
    opacity: 0.75;
  }
  70%, 100% {
    transform: scale(2.5);
    opacity: 0;
  }
}

/* 注：装饰动画不随系统 prefers-reduced-motion 关闭——动效是主题核心体验，
   本机 Windows 关了「动画效果」，跟随 hint 会静默变纯静态。 */

[data-theme='jarvis'] .machine {
  border: 1px solid transparent;
  border-radius: 8px;
  transition: border-color 0.15s, background 0.15s;
}

[data-theme='jarvis'] .machine:hover {
  border-color: var(--accent-a30);
}

[data-theme='jarvis'] .machine-state,
[data-theme='jarvis'] .menu-item-detail {
  font-family: var(--font-hud);
  letter-spacing: 1px;
}

/* 贾维斯界面：实时指示变成 HUD 遥测徽章——青色发丝边、等宽字；在跑时点亮发光 */
[data-theme='jarvis'] .live-chip {
  border-color: var(--accent-a28);
  background: var(--accent-a5);
  font-family: var(--font-hud);
  letter-spacing: 1px;
}

[data-theme='jarvis'] .live-chip.busy {
  border-color: var(--accent-a45);
  background: var(--accent-a10);
  color: var(--accent);
  box-shadow: 0 0 10px var(--accent-a12);
}

[data-theme='jarvis'] .live-chip.busy .dot {
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent-a70);
}
</style>
