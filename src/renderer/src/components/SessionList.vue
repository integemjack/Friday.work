<script setup lang="ts">
// 桌面左侧常驻会话列表（2026-10 布局改版）：
// 全部会话一列，点一下选中（右下聊天面板切到它）；运行中的会话带状态点。
// 新建 / 添加机器在表头；行尾 ✕ 只关掉本地订阅（不删服务端会话）。
// 排序：在跑的（含等确认/等你答）整体顶到最上面（「在跑」段），手动置顶其次，
// 其余按更新时间；默认只露最近 10 条 + 活动中的（选中的 / 在跑的），
// 末尾「显示更多会话」每次再放 10 条；
// 按更新时间分段插日期标签：置顶 / 最近 / 3天前 / 7天前 / 1个月前。
import { computed, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'
import type { ConversationSummary } from '../../../protocol/rpc/protocol.js'
import { agentActivityLabel, agentTreesByConversation } from '../lib/agentTree.js'
import AddMachineDialog from './AddMachineDialog.vue'

const store = useAppStore()
const addingMachine = ref(false)

/** 点子 Agent 行：打开所属会话并把右栏切到它的运行记录（openConversation 的第二参） */
function openAgent(conversationID: string, runID: string): void {
  void store.openConversation(conversationID, runID)
}

/** 一页放几条（默认 10，点「显示更多」再放 10） */
const PAGE_SIZE = 10
const visibleCount = ref(PAGE_SIZE)

function statusOf(id: string): string {
  return store.activities[id]?.status ?? 'idle'
}

/** 在跑中的会话：running，或跑着等人出手的（等确认/等你答）——整体顶到列表最上面 */
function isBusy(id: string): boolean {
  const status = statusOf(id)
  return status === 'running' || status === 'approval' || status === 'question'
}

const sessions = computed(() =>
  [...store.summaries].sort((a, b) => {
    const aBusy = isBusy(a.id)
    const bBusy = isBusy(b.id)
    if (aBusy !== bBusy) return aBusy ? -1 : 1
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt.localeCompare(a.updatedAt)
  })
)

/** 活动中的会话：选中的那段，或在跑 / 等确认 / 等你答的——永远展示，不被折叠进「更多」 */
function isLive(id: string): boolean {
  return id === store.activeConversationID || isBusy(id)
}

/** 实际展示的：排序后前 visibleCount 条，加上漏在后面但正活动着的（仍按原位插入，不打乱分组） */
const visibleSessions = computed(() =>
  sessions.value.filter((item, index) => index < visibleCount.value || isLive(item.id))
)

const hiddenCount = computed(() => sessions.value.length - visibleSessions.value.length)

/** 每个会话的子 Agent，按 parentKey 排成树、拍平成带层级的行序：在会话行下面树状展开 */
const agentRowsByConv = computed(() => agentTreesByConversation(store.teamRuns))

function showMore(): void {
  visibleCount.value += PAGE_SIZE
}

// —— 分段标签：在跑 / 置顶 / 最近 / 3天前 / 7天前 / 1个月前 ——
type GroupKey = 'live' | 'pinned' | 'recent' | 'd3' | 'd7' | 'm1'

const groupLabel: Record<GroupKey, string> = {
  live: '在跑',
  pinned: '置顶',
  recent: '最近',
  d3: '3天前',
  d7: '7天前',
  m1: '1个月前'
}

function groupOf(updatedAt: string, pinned: boolean, busy: boolean): GroupKey {
  if (busy) return 'live'
  if (pinned) return 'pinned'
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) return 'recent'
  const age = Date.now() - date.getTime()
  if (age < 3 * 86400000) return 'recent'
  if (age < 7 * 86400000) return 'd3'
  if (age < 30 * 86400000) return 'd7'
  return 'm1'
}

/** 展示的行按日期分段：标签只在每段第一行前出现一次 */
const groups = computed(() => {
  const out: Array<{ key: GroupKey; label: string; items: ConversationSummary[] }> = []
  for (const item of visibleSessions.value) {
    const key = groupOf(item.updatedAt, item.pinned, isBusy(item.id))
    const last = out[out.length - 1]
    if (last && last.key === key) last.items.push(item)
    else out.push({ key, label: groupLabel[key], items: [item] })
  }
  return out
})

const statusLabel: Record<string, string> = {
  idle: '',
  // 在跑不给文字（状态点在闪就够了）；要用户出手的（等确认/等你答等）才给字
  running: '',
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
      <template v-for="group in groups" :key="group.key">
        <div class="group-label">{{ group.label }}</div>
        <template v-for="item in group.items" :key="item.id">
          <div
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
          <!-- 这个会话的子 Agent，树状缩在会话行下（点它右栏改显这个子 Agent 的运行记录） -->
          <div
            v-for="agent in agentRowsByConv.get(item.id) ?? []"
            :key="`agent-${agent.run.id}`"
            class="agent-row"
            :class="{ done: !agent.run.running, active: store.agentFocus?.runID === agent.run.id }"
            :style="{ '--depth': agent.depth }"
            :title="`子 Agent · ${agentActivityLabel(agent.run)}：看它的全部聊天内容`"
            @click="openAgent(item.id, agent.run.id)"
          >
            <span class="aname" :title="agent.run.name">{{ agent.run.name }}</span>
            <span class="aact">{{ agentActivityLabel(agent.run) }}</span>
          </div>
        </template>
      </template>
      <div v-if="!sessions.length" class="empty">
        {{ store.connected ? '还没有会话，点上面「＋ 新建」开一段' : '先连上机器' }}
      </div>
      <button v-if="hiddenCount > 0" class="more" title="再显示 10 条" @click="showMore">
        显示更多会话（{{ hiddenCount }}）
      </button>
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

.group-label {
  margin: 10px 6px 3px;
  font-family: var(--font-hud);
  font-size: 10px;
  letter-spacing: 2px;
  color: var(--muted);
}

.group-label:first-child {
  margin-top: 2px;
}

.more {
  display: block;
  width: calc(100% - 8px);
  margin: 8px 4px 2px;
  padding: 6px 0;
  border: 1px dashed var(--line);
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
}

.more:hover {
  background: var(--hover);
  color: var(--fg-2, var(--fg));
  border-color: var(--accent-a35);
}

.row {
  position: relative;
  display: flex;
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
  /* 占满剩余宽度、超出的部分向右渐隐，不用省略号占位（min-width:0 允许收缩） */
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 24px), transparent);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 24px), transparent);
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
  flex: 0 0 auto;
  font-size: 10.5px;
  color: var(--muted);
  /* 悬停时 ✕ 顶上来，时间让位避免叠字 */
  transition: opacity 0.12s ease;
}

.x {
  position: absolute;
  right: 2px;
  top: 50%;
  transform: translateY(-50%);
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 4px;
  opacity: 0;
}

.row:hover .time {
  opacity: 0;
}

.row:hover .x {
  opacity: 1;
}

.x:hover {
  color: var(--fail);
  background: var(--hover);
}

/* —— 会话的子 Agent 树（行下缩进 + L 形连线，层级越深缩越多） —— */
.agent-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 4px;
  padding: 2.5px 8px 2.5px calc(18px + var(--depth, 0) * 14px);
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--fg-2, var(--fg));
  cursor: pointer;
  white-space: nowrap;
}

/* L 形连线：从上面（父）连下来拐进本行，深度即缩进层级 */
.agent-row::before {
  content: '';
  position: absolute;
  left: calc(6px + var(--depth, 0) * 14px);
  top: -3px;
  bottom: 50%;
  width: 9px;
  border-left: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  border-bottom-left-radius: 6px;
}

.agent-row:hover {
  background: var(--hover);
}

/* 点中的子 Agent：右栏正显示它的运行记录（与会话行的选中态同语言：淡底 + 左缘实线） */
.agent-row.active {
  background: var(--accent-a10);
  box-shadow: inset 2px 0 0 var(--accent);
}

.agent-row.active::after {
  content: '◈';
  flex: none;
  font-size: 10px;
  color: var(--accent);
  opacity: 0.8;
}

.agent-row.done {
  opacity: 0.55;
}

.aname {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.aact {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 10px;
  font-family: var(--font-hud);
  color: var(--muted);
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 20px), transparent);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 20px), transparent);
}

/* 贾维斯：连线换成发丝青线、活动短语走 HUD 等宽（报文口味） */
[data-theme='jarvis'] .agent-row::before {
  border-color: var(--accent-a35);
}

.empty {
  padding: 16px 10px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

/* 贾维斯：悬停行左缘先亮一道淡青线（选中态是实色线，悬停是它的预告） */
[data-theme='jarvis'] .row:not(.active):hover {
  box-shadow: inset 2px 0 0 var(--accent-a35);
}

/* 贾维斯：表头标题后拉一道渐隐发丝线（HUD 报文头，和消息头的分隔线同一语言） */
[data-theme='jarvis'] .head .spacer {
  align-self: center;
  height: 1px;
  margin: 0 4px;
  background: linear-gradient(90deg, var(--accent-a35), transparent);
}
</style>
