<script setup lang="ts">
// 沉浸模式（左右两栏收起，标题栏开关切换）时的背景式会话列表：
// 左上角「在跑」：跑着 / 等确认 / 等你答的会话 + 它们还在跑的子 Agent；
// 右上角「最近」：不在跑的会话按更新时间倒序，最近完成的 10 条。
// 仍是无卡片壳、半透明的背景形式，但行可点：点一下选中那段会话并恢复两栏
// （右下聊天面板切到它——两栏收着时选中看不见效果，就把「按标题栏开关放回来」合并成这一步）。
// 左上只列「在工作的」会话，全空闲时整块不出现；右上没有完成的会话时同样不出现，桌面全净。
import { computed } from 'vue'
import { useAppStore } from '../stores/app.js'
import { agentActivityLabel, agentTreesByConversation, liveAgentRows } from '../lib/agentTree.js'

const store = useAppStore()

function statusOf(id: string): string {
  return store.activities[id]?.status ?? 'idle'
}

/** 在跑中的会话：running，或跑着等人出手的（等确认/等你答）——和 SessionList 的口径一致 */
function isBusy(id: string): boolean {
  const status = statusOf(id)
  return status === 'running' || status === 'approval' || status === 'question'
}

/** 在工作的会话：置顶优先，其余按更新时间倒序（同 SessionList 的段内排序） */
const busySessions = computed(() =>
  store.summaries
    .filter((item) => isBusy(item.id))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt.localeCompare(a.updatedAt)
    })
)

/** 右上角「最近」：不在跑的（跑完停着的，含出错 / 等额度）按更新时间倒序，最近完成的 10 条 */
const recentSessions = computed(() =>
  store.summaries
    .filter((item) => !isBusy(item.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 10)
)

/** 每个会话的子 Agent 树（同 SessionList）：背景水印里只留还在跑的分支 */
const agentRows = computed(() => agentTreesByConversation(store.teamRuns))

/** 选中一段会话并退出沉浸：两栏放回来，右下聊天面板切到它（原来要按标题栏开关，合并成一步） */
function open(id: string): void {
  store.panelsHidden = false
  void store.openConversation(id)
}

/** 更新时间：当天给 HH:MM，更早给 M/D（同 SessionList） */
function timeOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${date.getMonth() + 1}/${date.getDate()}`
}

const statusLabel: Record<string, string> = {
  running: '',
  approval: '等确认',
  question: '等你答',
  quota: '等额度',
  error: '出错'
}
</script>

<template>
  <div v-if="busySessions.length" class="ghost-sessions" data-testid="ghost-sessions">
    <div class="ghost-head">在跑 {{ busySessions.length }}</div>
    <div
      v-for="item in busySessions"
      :key="item.id"
      class="ghost-item"
      :class="{ active: item.id === store.activeConversationID }"
      title="点一下选中这段会话（恢复两栏）"
      @click="open(item.id)"
    >
      <div class="ghost-row">
        <span class="dot" :class="statusOf(item.id)" />
        <span class="ghost-title" :title="item.title">{{ item.title || '（无标题）' }}</span>
        <span v-if="statusLabel[statusOf(item.id)]" class="ghost-status">{{ statusLabel[statusOf(item.id)] }}</span>
      </div>
      <!-- 这个会话还在跑的子 Agent，同树缩进（活着的分支；背景水印要低噪音）——点它同样选中这段会话 -->
      <div
        v-for="agent in liveAgentRows(agentRows.get(item.id) ?? [])"
        :key="`agent-${agent.run.id}`"
        class="ghost-agent"
        :style="{ '--depth': agent.depth }"
        @click="open(item.id)"
      >
        <span class="aname">{{ agent.run.name }}</span>
        <span class="aact">{{ agentActivityLabel(agent.run) }}</span>
      </div>
    </div>
  </div>

  <!-- 右上角「最近」：不在跑的会话，最近完成的 10 条（背景式同左上，行可点选中并恢复两栏） -->
  <div v-if="recentSessions.length" class="ghost-sessions ghost-recent" data-testid="ghost-recent-sessions">
    <div class="ghost-head">最近 {{ recentSessions.length }}</div>
    <div
      v-for="item in recentSessions"
      :key="item.id"
      class="ghost-item"
      :class="{ active: item.id === store.activeConversationID }"
      title="点一下选中这段会话（恢复两栏）"
      @click="open(item.id)"
    >
      <div class="ghost-row">
        <span class="dot" :class="statusOf(item.id)" />
        <span class="ghost-title" :title="item.title">{{ item.title || '（无标题）' }}</span>
        <span v-if="statusLabel[statusOf(item.id)]" class="ghost-status">{{ statusLabel[statusOf(item.id)] }}</span>
        <span class="ghost-time">{{ timeOf(item.updatedAt) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ghost-sessions {
  position: absolute;
  left: 18px;
  top: 16px;
  z-index: 20; /* 压在桌面底纹上、在投层气泡（40）/浮动窗口（50）下面 */
  display: flex;
  flex-direction: column;
  gap: 7px;
  max-width: min(380px, 40vw);
  /* 背景形式：低存在感；行可点选，鼠标移进整块提亮看清楚再点 */
  opacity: 0.5;
  transition: opacity 0.15s ease;
  user-select: none;
}

.ghost-sessions:hover {
  opacity: 0.9;
}

.ghost-head {
  font-family: var(--font-hud);
  font-size: 10px;
  letter-spacing: 3px;
  color: var(--accent);
  opacity: 0.85;
}

/* 一个会话条目：行 + 它的子 Agent 树（竖排；外层 .ghost-sessions 的 gap 隔开各条目）；点一下选中并恢复两栏 */
.ghost-item {
  display: flex;
  flex-direction: column;
  cursor: pointer;
}

.ghost-item:hover .ghost-title {
  color: var(--fg);
}

/* 选中的会话（进沉浸前就选着的）：标题点亮主色，和会话列表的选中语义对齐 */
.ghost-item.active .ghost-title {
  color: var(--accent);
}

.ghost-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 1.35;
  color: var(--text-2);
  white-space: nowrap;
}

/* 会话还在跑的子 Agent：同树缩进，更小更淡，融进水印；点它同样选中这段会话 */
.ghost-agent {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 1px 0 1px 15px;
  padding-left: calc(4px + var(--depth, 0) * 12px);
  font-size: 10.5px;
  line-height: 1.3;
  color: var(--text-3);
  white-space: nowrap;
  cursor: pointer;
}

.ghost-agent:hover .aname {
  color: var(--text-2);
}

/* L 形连线：同会话列表的树线，更淡 */
.ghost-agent::before {
  content: '';
  position: absolute;
  left: calc(-8px + var(--depth, 0) * 12px);
  top: -3px;
  bottom: 50%;
  width: 8px;
  border-left: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  border-bottom-left-radius: 5px;
  opacity: 0.7;
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
  font-family: var(--font-hud);
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 18px), transparent);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 18px), transparent);
}

.ghost-title {
  min-width: 0;
  overflow: hidden;
  /* 超宽向右渐隐（和会话列表行同款），背景水印不撑破桌面 */
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 26px), transparent);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 26px), transparent);
}

.ghost-status {
  flex: 0 0 auto;
  font-size: 10px;
  font-family: var(--font-hud);
  color: var(--warn);
}

.ghost-status.error {
  color: var(--fail);
}

/* 右上角「最近」：与左上对角的背景块，行靠右对齐（标题超宽向左渐隐） */
.ghost-recent {
  left: auto;
  right: 18px;
  align-items: flex-end;
}

.ghost-recent .ghost-item {
  align-items: flex-end;
}

.ghost-recent .ghost-title {
  -webkit-mask-image: linear-gradient(270deg, #000 0, #000 calc(100% - 26px), transparent);
  mask-image: linear-gradient(270deg, #000 0, #000 calc(100% - 26px), transparent);
}

/* 更新时间：最近完成的行给个时间参考（停着的会话看它是什么时候的） */
.ghost-time {
  flex: 0 0 auto;
  font-size: 10.5px;
  font-family: var(--font-hud);
  color: var(--text-3);
}

/* 状态点：同会话列表的语义配色（running 呼吸、等人出手警告色） */
.dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
}

.dot.running {
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent-a70);
  animation: ghost-pulse 1.4s ease-in-out infinite;
}

.dot.approval,
.dot.question {
  background: var(--warn);
}

@keyframes ghost-pulse {
  50% {
    opacity: 0.35;
  }
}

/* 贾维斯：背景列表顺着 HUD 语言——报文头后拉一道渐隐发丝线，标题带一点青色辉光 */
[data-theme='jarvis'] .ghost-head::after {
  content: '';
  display: inline-block;
  vertical-align: middle;
  width: 90px;
  height: 1px;
  margin-left: 8px;
  background: linear-gradient(90deg, var(--accent-a35), transparent);
}

[data-theme='jarvis'] .ghost-title {
  color: var(--text-2);
  text-shadow: 0 0 12px var(--accent-a10);
}

/* 贾维斯：子 Agent 连线也换发丝青线 */
[data-theme='jarvis'] .ghost-agent::before {
  border-color: var(--accent-a35);
}

/* 贾维斯：右上角「最近」的发丝线对称放到标题左侧（贴着文字亮、往左渐隐） */
[data-theme='jarvis'] .ghost-recent .ghost-head::after {
  display: none;
}

[data-theme='jarvis'] .ghost-recent .ghost-head::before {
  content: '';
  display: inline-block;
  vertical-align: middle;
  width: 90px;
  height: 1px;
  margin-right: 8px;
  background: linear-gradient(270deg, var(--accent-a35), transparent);
}
</style>
