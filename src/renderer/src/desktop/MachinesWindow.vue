<script setup lang="ts">
// 「机器与会话」窗口：上半是机器（点一下切当前机器、可连/断/删），下半是会话列表。
import { onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'
import AddMachineDialog from '../components/AddMachineDialog.vue'

const store = useAppStore()
const addDialogOpen = ref(false)
const showAdd = ref(false)

const stateText: Record<string, string> = {
  disconnected: '未连接',
  probing: '探测远端',
  connecting: '连接中',
  ready: '已连接',
  failed: '失败',
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

onMounted(() => {
  if (showAdd.value) addDialogOpen.value = true
})

function timeText(iso?: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = Date.now()
  const diff = now - date.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${date.getMonth() + 1}-${date.getDate()}`
}

function openConversation(id: string): void {
  void store.openConversation(id)
}

async function toggleConnect(): Promise<void> {
  const machine = store.currentMachineInfo
  if (!machine) return
  if (machine.state === 'ready') await store.disconnectMachine(machine.id)
  else await store.connectMachine(machine.id)
}
</script>

<template>
  <div class="machines-window">
    <div class="section">
      <div class="section-head">
        <span>机器</span>
        <button class="small-btn" @click="addDialogOpen = true">＋ 添加</button>
      </div>

      <button
        v-for="machine in store.machines"
        :key="machine.id"
        class="machine-row"
        :class="{ active: machine.id === store.currentMachine }"
        @click="store.selectMachine(machine.id)"
      >
        <span class="dot" :class="stateDot[machine.state]" />
        <span class="machine-name">{{ machine.name }}</span>
        <span class="machine-state">{{ stateText[machine.state] }}</span>
        <span v-if="machine.hasPendingApproval" class="dot warn" title="有调用等着确认" />
      </button>

      <div v-if="!store.machines.length" class="empty">
        还没有机器。点「＋ 添加」连上跑着 Friday 的那台。
      </div>

      <div v-if="store.currentMachineInfo" class="machine-actions">
        <button class="small-btn" @click="toggleConnect">
          {{ store.currentMachineInfo.state === 'ready' ? '断开' : '连接' }}
        </button>
        <button class="small-btn danger" @click="store.removeMachine(store.currentMachineInfo.id)">删除这台</button>
        <span v-if="store.currentMachineInfo.detail" class="detail">{{ store.currentMachineInfo.detail }}</span>
      </div>
    </div>

    <div class="divider" />

    <div class="section list">
      <div class="section-head">
        <span>会话</span>
        <button class="small-btn" :disabled="!store.connected" @click="store.createConversation()">＋ 新建</button>
      </div>

      <button
        v-for="summary in store.summaries"
        :key="summary.id"
        class="conv-row"
        :class="{
          active: store.activeConversationID === summary.id,
          open: store.windows.some((item) => item.conversationID === summary.id)
        }"
        @click="openConversation(summary.id)"
      >
        <span class="conv-title">{{ summary.title || '新对话' }}</span>
        <span class="conv-time">{{ timeText(summary.updatedAt) }}</span>
        <span v-if="(store.approvals[summary.id]?.length ?? 0) > 0" class="dot warn" title="待确认" />
        <span
          v-else-if="store.activities[summary.id]?.status === 'running'"
          class="dot run"
          title="正在生成"
        />
      </button>

      <div v-if="!store.summaries.length" class="empty">
        {{ store.connected ? '这台机器还没有会话，点「＋ 新建」开始第一段。' : '先连上一台机器。' }}
      </div>
    </div>

    <AddMachineDialog v-if="addDialogOpen" @close="addDialogOpen = false" />
  </div>
</template>

<style scoped>
.machines-window {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
}

.section {
  padding: 8px 10px;
}

.section.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-2);
  padding: 2px 2px 6px;
}

.small-btn {
  font-size: 12px;
  color: var(--text-2);
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--panel);
}

.small-btn:hover:not(:disabled) {
  background: var(--panel-2);
  color: var(--text);
}

.small-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.small-btn.danger {
  color: var(--fail);
}

.machine-row,
.conv-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.machine-row:hover,
.conv-row:hover {
  background: var(--hover);
}

.machine-row.active,
.conv-row.open {
  background: var(--accent-weak);
}

.conv-row.active {
  border-color: var(--accent);
}

.machine-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.machine-state {
  margin-left: auto;
  flex: none;
  font-size: 11.5px;
  color: var(--text-2);
}

.machine-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 2px 2px;
  flex-wrap: wrap;
}

.detail {
  font-size: 11.5px;
  color: var(--text-2);
  word-break: break-all;
}

.conv-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-time {
  flex: none;
  font-size: 11px;
  color: var(--text-3);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
  flex: none;
}

.dot.ok { background: var(--ok); }
.dot.run { background: var(--run); animation: pulse 1.4s ease-in-out infinite; }
.dot.warn { background: var(--warn); }
.dot.fail { background: var(--fail); }

@keyframes pulse {
  50% { opacity: 0.35; }
}

.divider {
  height: 1px;
  background: var(--border);
}

.empty {
  color: var(--text-3);
  font-size: 12.5px;
  padding: 8px 4px;
  line-height: 1.6;
}
</style>
