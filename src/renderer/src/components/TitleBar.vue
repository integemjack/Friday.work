<script setup lang="ts">
// 标题栏：应用名 │ 当前机器（点开机器列表）│ 连接状态点
import { computed, ref } from 'vue'
import type { WindowKind } from '../stores/app.js'
import { useAppStore } from '../stores/app.js'

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

async function pickMachine(id: string) {
  machineMenuOpen.value = false
  await store.selectMachine(id)
}

const hasNoMachine = computed(() => store.machines.length === 0)

// 窗口启动器（底部任务栏去掉后唯一的窗口入口）：终端/文件/浏览器是桌面面板不在这里；通话是右下角挂件
const launchers: Array<{ kind: WindowKind; label: string; icon: string }> = [
  { kind: 'conversation', label: '会话', icon: '💬' },
  { kind: 'machines', label: '机器与会话', icon: '⛁' },
  { kind: 'agents', label: '子 Agent', icon: '◈' },
  { kind: 'activity', label: '活动总览', icon: '◎' },
  { kind: 'timeline', label: '助手时间线', icon: '🗒' },
  { kind: 'schat', label: '机器人聊天', icon: '🤖' },
  { kind: 'voice', label: '语音', icon: '🎙' },
  { kind: 'settings', label: '设置', icon: '⚙' }
]

function launch(kind: WindowKind) {
  store.openWindow(kind)
}

function kindOpen(kind: WindowKind): boolean {
  return store.windows.some((item) => item.kind === kind)
}

// 无边框窗口的窗控（preload 暴露的 IPC；模板里拿不到 window 全局，setup 里取一次）
const bridge = window.fridayBridge
</script>

<template>
  <header class="titlebar">
    <div class="brand">Friday</div>

    <!-- 窗口启动器：点亮=已开；点击开/置顶/还原最小化（没有任务栏后的唯一入口） -->
    <nav class="launcher">
      <button
        v-for="entry in launchers"
        :key="entry.kind"
        class="launch-btn"
        :class="{ open: kindOpen(entry.kind) }"
        :title="entry.label"
        @click="launch(entry.kind)"
      >
        {{ entry.icon }}
      </button>
    </nav>

    <div class="machine" @click="toggleMachineMenu">
      <span class="dot" :class="stateDot" />
      <span class="machine-name">{{ store.currentMachineInfo?.name ?? (hasNoMachine ? '还没有机器' : '选一台机器') }}</span>
      <span class="machine-state">{{ stateText }}</span>
      <span class="chevron">▾</span>
    </div>
    <div class="spacer" />
    <!-- SChat 登录状态：未登录时给一条回登录页的入口（工作台里没别的地方能重新扫码） -->
    <button v-if="store.schat.phase !== 'online'" class="schat-entry" title="扫码登录 SChat（连机器人用）" @click="store.openLogin()">
      <span class="dot off" />
      未登录 · 扫码
    </button>
    <!-- 无边框窗口的窗控钮（frame:false；整个标题栏是拖拽区） -->
    <div class="win-controls">
      <button class="win-btn" title="最小化" @click="bridge.winMinimize()">─</button>
      <button class="win-btn" title="最大化 / 还原" @click="bridge.winMaximizeToggle()">▢</button>
      <button class="win-btn close" title="关闭" @click="bridge.winClose()">×</button>
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
  gap: 14px;
  padding: 0 14px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
  user-select: none;
}

.titlebar button,
.titlebar .machine {
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
  font-size: 13px;
  opacity: 0.62;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s, box-shadow 0.12s;
}

.launch-btn:hover {
  background: var(--hover);
  opacity: 1;
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
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
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
}

.machine-state {
  color: var(--text-2);
  font-size: 12.5px;
}

.chevron {
  color: var(--text-3);
  font-size: 11px;
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
  border-bottom-color: var(--accent-a28);
  background:
    linear-gradient(90deg, var(--accent-a9), transparent 28%, transparent 72%, var(--accent-a9)),
    var(--panel-a22);
}

[data-theme='jarvis'] .brand {
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 5px;
  text-shadow: 0 0 12px var(--accent-a50);
}

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
</style>
