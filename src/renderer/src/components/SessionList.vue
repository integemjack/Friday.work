<script setup lang="ts">
// 桌面左侧常驻会话列表（2026-10 布局改版）：
// 全部会话一列，点一下选中（右下聊天面板切到它）；运行中的会话带状态点。
// 新建 / 添加机器在表头；行尾 ✕ 只关掉本地订阅（不删服务端会话）。
import { computed, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'
import AddMachineDialog from './AddMachineDialog.vue'

const store = useAppStore()
const addingMachine = ref(false)

const sessions = computed(() =>
  [...store.summaries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt.localeCompare(a.updatedAt)
  })
)

function statusOf(id: string): string {
  return store.activities[id]?.status ?? 'idle'
}

const statusLabel: Record<string, string> = {
  idle: '',
  running: '在跑',
  approval: '等确认',
  question: '等你答',
  quota: '等额度',
  error: '出错'
}

function timeOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function open(id: string): void {
  void store.openConversation(id)
}

function close(event: MouseEvent, id: string): void {
  event.stopPropagation()
  void store.closeConversation(id)
}

function create(): void {
  void store.createConversation()
}

onMounted(() => {
  // 列表是常驻入口：进工作台就拉一次会话列表（机器事件也会推，这里兑底）
  if (store.connected && !store.summaries.length) void store.refreshSummaries()
})
</script>

<template>
  <section class="session-list" data-testid="session-list">
    <header class="head">
      <span class="head-title">会话</span>
      <span class="spacer" />
      <button class="hbtn" title="新建会话" @click="create">＋ 新建</button>
      <button class="hbtn" title="扫码连接一台新机器" @click="addingMachine = true">＋ 机器</button>
    </header>

    <div class="rows">
      <div
        v-for="item in sessions"
        :key="item.id"
        class="row"
        :class="{ active: item.id === store.activeConversationID, idle: statusOf(item.id) === 'idle' }"
        @click="open(item.id)"
      >
        <span class="dot" :class="statusOf(item.id)" />
        <span class="title" :title="item.title">{{ item.title || '（无标题）' }}</span>
        <span v-if="statusLabel[statusOf(item.id)]" class="status" :class="statusOf(item.id)">
          {{ statusLabel[statusOf(item.id)] }}
        </span>
        <span class="time">{{ timeOf(item.updatedAt) }}</span>
        <button class="x" title="关掉这个会话的本地订阅" @click="close($event, item.id)">✕</button>
      </div>
      <div v-if="!sessions.length" class="empty">
        {{ store.connected ? '还没有会话，点上面「＋ 新建」开一段' : '先连上机器' }}
      </div>
    </div>

    <AddMachineDialog v-if="addingMachine" @close="addingMachine = false" />
  </section>
</template>

<style scoped>
.session-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  /* 常驻元素融在桌面上：无卡片壳（透明、无边框、无阴影） */
  background: transparent;
  border: none;
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 8px;
}

.head-title {
  font-family: var(--font-hud);
  font-size: 11px;
  letter-spacing: 3px;
  color: var(--accent);
  opacity: 0.85;
}

.spacer {
  flex: 1 1 auto;
}

.hbtn {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--fg-2, var(--fg));
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 6px;
  cursor: pointer;
}

.hbtn:hover {
  background: var(--hover);
  border-color: var(--accent-a35);
}

.rows {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px;
}

.row {
  display: grid;
  grid-template-columns: auto 1fr auto auto auto;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12.5px;
}

.row:hover {
  background: var(--hover);
}

.row.active {
  background: var(--accent-a10);
  box-shadow: inset 2px 0 0 var(--accent);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
}

.dot.running {
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent-a70);
  animation: pulse 1.4s ease-in-out infinite;
}

.dot.approval,
.dot.question {
  background: var(--warn);
}

.dot.error {
  background: var(--fail);
}

.dot.quota {
  background: var(--warn);
  opacity: 0.7;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status {
  font-size: 10px;
  color: var(--accent);
  font-family: var(--font-hud);
}

.status.approval,
.status.question,
.status.quota {
  color: var(--warn);
}

.status.error {
  color: var(--fail);
}

.time {
  font-size: 10.5px;
  color: var(--muted);
}

.x {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 4px;
  opacity: 0;
}

.row:hover .x {
  opacity: 1;
}

.x:hover {
  color: var(--fail);
  background: var(--hover);
}

.empty {
  padding: 16px 10px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}
</style>
