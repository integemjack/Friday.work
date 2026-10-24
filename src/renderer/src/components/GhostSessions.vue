<script setup lang="ts">
// 沉浸模式（左右两栏收起，标题栏开关切换）时左上角的背景式在跑会话列表：
// 无卡片壳、半透明、不接交互（pointer-events:none，点击穿到桌面），像水印一样融在桌面底纹上——
// 只是让人收起两栏后还看得见谁在跑；要选中/操作会话就按标题栏开关把两栏放回来。
// 只列「在工作的」会话（跑着 / 等确认 / 等你答），全空闲时整块不出现，桌面全净。
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

/** 每个会话的子 Agent 树（同 SessionList）：背景水印里只留还在跑的分支 */
const agentRows = computed(() => agentTreesByConversation(store.teamRuns))

const statusLabel: Record<string, string> = {
  running: '',
  approval: '等确认',
  question: '等你答'
}
</script>

<template>
  <div v-if="busySessions.length" class="ghost-sessions" data-testid="ghost-sessions">
    <div class="ghost-head">在跑 {{ busySessions.length }}</div>
    <div v-for="item in busySessions" :key="item.id" class="ghost-item">
      <div class="ghost-row">
        <span class="dot" :class="statusOf(item.id)" />
        <span class="ghost-title" :title="item.title">{{ item.title || '（无标题）' }}</span>
        <span v-if="statusLabel[statusOf(item.id)]" class="ghost-status">{{ statusLabel[statusOf(item.id)] }}</span>
      </div>
      <!-- 这个会话还在跑的子 Agent，同树缩进（活着的分支；背景水印要低噪音） -->
      <div
        v-for="agent in liveAgentRows(agentRows.get(item.id) ?? [])"
        :key="`agent-${agent.run.id}`"
        class="ghost-agent"
        :style="{ '--depth': agent.depth }"
      >
        <span class="aname">{{ agent.run.name }}</span>
        <span class="aact">{{ agentActivityLabel(agent.run) }}</span>
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
  /* 背景形式：低存在感、完全不可交互 */
  opacity: 0.5;
  pointer-events: none;
  user-select: none;
}

.ghost-head {
  font-family: var(--font-hud);
  font-size: 10px;
  letter-spacing: 3px;
  color: var(--accent);
  opacity: 0.85;
}

/* 一个会话条目：行 + 它的子 Agent 树（竖排；外层 .ghost-sessions 的 gap 隔开各条目） */
.ghost-item {
  display: flex;
  flex-direction: column;
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

/* 会话还在跑的子 Agent：同树缩进，更小更淡，融进水印 */
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
</style>
