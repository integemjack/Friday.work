<script setup lang="ts">
// 任务栏（桌面范式）：左边是能打开的窗口入口，中间是已开窗口（点一下切/最小化），
// 右边显示当前机器与连接状态。
import { computed } from 'vue'
import type { WindowKind } from '../stores/app.js'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()

const entries: Array<{ kind: WindowKind; label: string; icon: string }> = [
  { kind: 'machines', label: '机器与会话', icon: '⛁' },
  { kind: 'activity', label: '活动总览', icon: '◎' },
  { kind: 'voice', label: '语音', icon: '🎙' },
  { kind: 'terminals', label: '终端', icon: '⌨' },
  { kind: 'files', label: '文件', icon: '🗂' },
  { kind: 'browser', label: '浏览器', icon: '🌐' },
  { kind: 'agents', label: '子 Agent', icon: '◈' },
  { kind: 'settings', label: '设置', icon: '⚙' }
]

/** 已开的非会话窗口（会话窗口在工作台列表里） */
const openOthers = computed(() => store.windows.filter((item) => item.kind !== 'conversation'))
const conversationWindows = computed(() => store.windows.filter((item) => item.kind === 'conversation'))

const topZ = computed(() => Math.max(0, ...store.windows.map((item) => item.z)))

function openEntry(kind: WindowKind): void {
  const existing = store.windows.find((item) => item.kind === kind)
  if (existing) {
    store.focusWindow(existing.id)
    return
  }
  store.openWindow(kind)
  if (kind === 'browser') void store.watchBrowser()
}

function badge(kind: WindowKind): string {
  if (kind === 'terminals' && store.terminals.length) return String(store.terminals.length)
  if (kind === 'agents' && store.teamRuns.length) return String(store.teamRuns.length)
  if (kind === 'browser' && store.browserTabs.length) return String(store.browserTabs.length)
  return ''
}

const stateText: Record<string, string> = {
  disconnected: '未连接',
  probing: '探测中',
  connecting: '连接中',
  ready: '已连接',
  failed: '连接失败',
  unpaired: '未配对',
  versionMismatch: '版本不匹配'
}

const stateDot: Record<string, string> = {
  disconnected: 'off',
  probing: 'run',
  connecting: 'run',
  ready: 'ok',
  failed: 'fail',
  unpaired: 'warn',
  versionMismatch: 'fail'
}
</script>

<template>
  <footer class="taskbar">
    <div class="group">
      <button
        v-for="entry in entries"
        :key="entry.kind"
        class="task-entry"
        :class="{ active: store.windows.some((item) => item.kind === entry.kind) }"
        :title="entry.label"
        @click="openEntry(entry.kind)"
      >
        <span class="icon">{{ entry.icon }}</span>
        <span class="label">{{ entry.label }}</span>
        <span v-if="badge(entry.kind)" class="badge">{{ badge(entry.kind) }}</span>
      </button>
    </div>

    <div class="group windows">
      <button
        v-for="item in [...openOthers.filter((w) => w.kind !== 'machines' && w.kind !== 'activity'), ...conversationWindows]"
        :key="item.id"
        class="task-chip"
        :class="{ current: item.z === topZ && !item.minimized, minimized: item.minimized }"
        :title="item.title"
        @click="store.toggleTaskbar(item.id)"
        @dblclick="store.closeWindow(item.id)"
      >
        <span class="icon">{{ item.icon }}</span>
        <span class="label">{{ item.title }}</span>
      </button>
    </div>

    <div class="group right">
      <button
        v-if="store.currentMachineInfo"
        class="machine"
        title="机器与会话"
        @click="openEntry('machines')"
      >
        <span class="dot" :class="stateDot[store.currentMachineInfo.state]" />
        <span class="machine-name">{{ store.currentMachineInfo.name }}</span>
        <span class="machine-state">{{ stateText[store.currentMachineInfo.state] }}</span>
      </button>
      <span v-if="store.pendingApprovalCount" class="approval-count">
        {{ store.pendingApprovalCount }} 个待确认
      </span>
    </div>
  </footer>
</template>

<style scoped>
.taskbar {
  flex: none;
  height: 42px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  background: var(--panel);
  border-top: 1px solid var(--border);
}

.group {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.group.windows {
  flex: 1;
  overflow: hidden;
}

.group.right {
  margin-left: auto;
  gap: 8px;
}

.task-entry,
.task-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 9px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
}

.task-entry:hover,
.task-chip:hover {
  background: var(--hover);
  color: var(--text);
}

.task-entry.active {
  color: var(--text);
}

.task-chip {
  max-width: 190px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  color: var(--text);
}

.task-chip.current {
  border-color: var(--accent);
  background: var(--accent-weak);
}

.task-chip.minimized {
  opacity: 0.62;
}

.task-chip .label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.icon {
  font-size: 12.5px;
}

.label {
  font-size: 12.5px;
}

.badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--chip);
  color: var(--text-2);
  font-size: 10.5px;
  line-height: 16px;
  text-align: center;
}

.machine {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  font-size: 12.5px;
  cursor: pointer;
}

.machine:hover {
  background: var(--hover);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
}

.dot.ok { background: var(--ok); }
.dot.run { background: var(--run); animation: pulse 1.4s ease-in-out infinite; }
.dot.warn { background: var(--warn); }
.dot.fail { background: var(--fail); }

@keyframes pulse {
  50% { opacity: 0.35; }
}

.machine-name {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.machine-state {
  color: var(--text-2);
  font-size: 12px;
}

.approval-count {
  font-size: 12px;
  color: var(--warn);
}
</style>
