<script setup lang="ts">
// 贾维斯桌面遥测层：把「正在跑的会话 / 子 Agent / 系统日志」直接投在桌面上实时显示，
// 不用开窗口——这就是贾维斯的用法：环境信息常驻桌面，要点开细节才进窗口。
// 数据源和对应窗口（ActivityOverview / AgentsCard / TimelineWindow）完全同源：
// store.activities、store.teamRuns、store.assistantEntries，零协议改动。
// 只在「贾维斯界面」下挂载（App.vue v-if="jarvis"）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AssistantEntry, SessionActivity, TeamRun } from '../../../protocol/rpc/protocol.js'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()

// 本地时钟（每秒跳，给「已运行 X」用）
const now = ref(Date.now())
let timer = 0
onMounted(() => {
  timer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => window.clearInterval(timer))

// ---- 左上：正在跑的会话（活动总览同款筛选：非 idle，按状态优先级排） ----
const statusText: Record<string, string> = {
  idle: '闲着',
  running: '在干',
  approval: '等确认',
  question: '等你回答',
  quota: '等额度',
  error: '出错'
}

const activeTasks = computed<SessionActivity[]>(() => {
  const rank: Record<string, number> = { approval: 0, question: 1, quota: 2, error: 3, running: 4, idle: 5 }
  return Object.values(store.activities)
    .filter((activity) => activity.status !== 'idle')
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))
})

function briefOf(activity: SessionActivity): string {
  if (activity.task?.goal) return activity.task.goal
  if (activity.currentTool?.title) return `正在：${activity.currentTool.title}`
  if (activity.approvals?.length) return `等你确认：${activity.approvals[0]!.title}`
  return ''
}

function openTask(conversationID: string): void {
  void store.openConversation(conversationID)
}

// ---- 右上：子 Agent（在跑的排前，最多 6 个，细节去窗口） ----
const agentRuns = computed<TeamRun[]>(() =>
  [...store.teamRuns]
    .sort((a, b) => (a.running === b.running ? a.started.localeCompare(b.started) : a.running ? -1 : 1))
    .slice(0, 6)
)

function since(iso?: string): string {
  if (!iso) return ''
  const seconds = Math.max(0, Math.round((now.value - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
}

function agentLine(run: TeamRun): string {
  if (!run.activity) return '在想'
  const kind = run.activity.kind
  if (kind === 'generating') return '在生成'
  if (kind === 'tool') return `在执行「${run.activity.title}」`
  if (kind === 'waitingChildren') return '在等子 Agent'
  if (kind === 'waitingApproval') return `在等确认：${run.activity.title}`
  return '排队中'
}

function openAgents(): void {
  store.openWindow('agents')
}

// ---- 左下：系统日志 ticker（最近 4 条，点开时间线窗口看全） ----
const logTail = computed<AssistantEntry[]>(() => store.assistantEntries.slice(-4).reverse())

function clockOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function briefText(entry: AssistantEntry): string {
  return entry.text.replace(/\s+/g, ' ').trim().slice(0, 90)
}

function openTimeline(): void {
  store.openWindow('timeline')
}
</script>

<template>
  <div class="jarvis-telemetry">
    <!-- 左上：正在跑的会话 -->
    <section class="panel left" :class="{ populated: activeTasks.length }">
      <div class="panel-head">ACTIVE TASKS // 正在跑</div>
      <button v-for="item in activeTasks" :key="item.id" class="row" @click="openTask(item.id)">
        <span class="dot" :class="item.status" />
        <span class="row-title">{{ item.title }}</span>
        <span class="row-status" :class="item.status">{{ statusText[item.status] ?? item.status }}</span>
        <span v-if="briefOf(item)" class="row-brief">{{ briefOf(item) }}</span>
        <span v-if="item.task?.steps?.length" class="row-steps">
          <span
            v-for="(step, index) in item.task.steps"
            :key="index"
            class="step"
            :class="step.status"
            :title="step.text"
          />
        </span>
      </button>
      <div v-if="!activeTasks.length" class="panel-empty">NO ACTIVE TASKS</div>
    </section>

    <!-- 右上：子 Agent -->
    <section class="panel right">
      <div class="panel-head">AGENTS // 子任务单元</div>
      <button v-for="run in agentRuns" :key="run.id" class="row" @click="openAgents">
        <span class="dot" :class="run.running ? 'run' : 'idle'" />
        <span class="row-title">{{ run.name }}</span>
        <span class="row-status mono">第{{ run.steps }}步 · {{ since(run.started) }}</span>
        <span class="row-brief">{{ agentLine(run) }}</span>
      </button>
      <div v-if="!agentRuns.length" class="panel-empty">NO AGENTS ACTIVE</div>
    </section>

    <!-- 左下：系统日志 -->
    <section v-if="logTail.length" class="panel ticker" @click="openTimeline">
      <div class="panel-head">SYS LOG // 时间线</div>
      <div v-for="entry in logTail" :key="entry.id" class="log-line">
        <span class="log-time">{{ clockOf(entry.at) }}</span>
        <span class="log-kind" :class="entry.kind">{{ entry.kind }}</span>
        <span class="log-text">{{ briefText(entry) }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.jarvis-telemetry {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
}

.panel {
  position: absolute;
  pointer-events: auto;
  width: 300px;
  max-height: 44vh;
  overflow-y: auto;
  padding: 8px 10px 10px;
  background: rgba(10, 25, 45, 0.55);
  border: 1px solid rgba(34, 211, 238, 0.22);
  border-radius: 10px;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow:
    0 0 18px rgba(34, 211, 238, 0.08),
    0 10px 28px rgba(0, 0, 0, 0.4);
  /* 全息角括号 */
  background-image:
    linear-gradient(rgba(34, 211, 238, 0.8) 0 0) left top / 10px 1.5px,
    linear-gradient(rgba(34, 211, 238, 0.8) 0 0) left top / 1.5px 10px,
    linear-gradient(rgba(34, 211, 238, 0.8) 0 0) right top / 10px 1.5px,
    linear-gradient(rgba(34, 211, 238, 0.8) 0 0) right top / 1.5px 10px,
    linear-gradient(rgba(34, 211, 238, 0.8) 0 0) left bottom / 10px 1.5px,
    linear-gradient(rgba(34, 211, 238, 0.8) 0 0) left bottom / 1.5px 10px,
    linear-gradient(rgba(34, 211, 238, 0.8) 0 0) right bottom / 10px 1.5px,
    linear-gradient(rgba(34, 211, 238, 0.8) 0 0) right bottom / 1.5px 10px;
  background-repeat: no-repeat;
}

.panel.left {
  left: 18px;
  top: 62px;
}

.panel.right {
  right: 18px;
  top: 62px;
  width: 280px;
}

.panel.ticker {
  left: 18px;
  bottom: 58px;
  top: auto;
  width: 360px;
  max-height: 150px;
  cursor: pointer;
}

.panel-head {
  font-family: var(--font-hud);
  font-size: 10.5px;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: var(--accent);
  opacity: 0.7;
  border-bottom: 1px solid rgba(34, 211, 238, 0.2);
  padding-bottom: 4px;
  margin-bottom: 4px;
}

.panel-empty {
  font-family: var(--font-hud);
  font-size: 11px;
  letter-spacing: 2px;
  color: var(--text-3);
  padding: 10px 2px 4px;
  text-align: center;
}

/* ---- 行 ---- */
.row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 4px 6px;
  width: 100%;
  border: none;
  border-left: 2px solid transparent;
  background: transparent;
  text-align: left;
  padding: 5px 6px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text);
  font-size: 12px;
}

.row:hover {
  border-left-color: rgba(34, 211, 238, 0.55);
  background: rgba(34, 211, 238, 0.06);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
}

.dot.running,
.dot.run {
  background: var(--accent);
  box-shadow: 0 0 8px rgba(34, 211, 238, 0.7);
  animation: jt-pulse 1.4s ease-in-out infinite;
}

.dot.approval,
.dot.question,
.dot.quota {
  background: var(--warn);
  box-shadow: 0 0 8px rgba(251, 191, 36, 0.6);
}

.dot.error {
  background: var(--fail);
  box-shadow: 0 0 8px rgba(251, 95, 125, 0.6);
}

@keyframes jt-pulse {
  50% {
    opacity: 0.35;
  }
}

.row-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}

.row-status {
  font-family: var(--font-hud);
  font-size: 10.5px;
  letter-spacing: 1px;
  color: var(--text-2);
}

.row-status.approval,
.row-status.question,
.row-status.quota {
  color: var(--warn);
}

.row-status.error {
  color: var(--fail);
}

.row-status.mono {
  color: var(--accent);
  opacity: 0.75;
}

.row-brief {
  grid-column: 2 / 4;
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-steps {
  grid-column: 2 / 4;
  display: flex;
  gap: 3px;
}

.step {
  width: 14px;
  height: 3px;
  border-radius: 2px;
  background: var(--border);
}

.step.done {
  background: var(--ok);
  box-shadow: 0 0 5px rgba(45, 212, 167, 0.5);
}

.step.doing {
  background: var(--run);
  box-shadow: 0 0 5px rgba(56, 189, 248, 0.5);
}

/* ---- 日志 ticker ---- */
.log-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 2px;
  font-size: 11.5px;
  min-width: 0;
}

.log-time {
  font-family: var(--font-hud);
  font-size: 10.5px;
  color: rgba(34, 211, 238, 0.55);
  flex: none;
}

.log-kind {
  font-family: var(--font-hud);
  font-size: 10px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--text-3);
  flex: none;
  width: 62px;
}

.log-kind.assistant {
  color: var(--accent);
}

.log-kind.user {
  color: var(--text-2);
}

.log-kind.tool {
  color: #7dd3fc;
}

.log-kind.notice {
  color: var(--warn);
}

.log-text {
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* 窗口少的时候（桌面空）面板就是主角，稍微亮一点 */
.panel.populated {
  box-shadow:
    0 0 24px rgba(34, 211, 238, 0.12),
    0 10px 28px rgba(0, 0, 0, 0.4);
}
</style>
