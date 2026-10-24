<script setup lang="ts">
// 选中会话的上下文背景条（2026-10）：会话列表里选中一段会话后，输入台上方以背景形式
// （无卡片壳、半透明、pointer-events:none 的纯水印，不挡底下投层气泡的点击）显示这段会话的
// 上下文（任务目标 / 步骤进度 / 在跑的子 Agent / 正在用的工具）和详细信息（模型、思考档位、
// 任务模式、工作目录、权限、排队），让「输入台里发出去的话落在哪段会话上」一眼可见。
// 没选会话（默认态，输入即开新会话）或「和助手说」时整块不出现；Esc 取消选中后同样消失（App.vue）。
import { computed } from 'vue'
import { useAppStore } from '../stores/app.js'
import { effectiveThinking, normalizeTeamMode, thinkingTitle } from '../lib/builtinCommands.js'
import { agentActivityLabel, agentTreesByConversation, liveAgentRows } from '../lib/agentTree.js'
import type { AgentRow } from '../lib/agentTree.js'
import type { ThinkingLevel } from '../../../protocol/rpc/protocol.js'

const store = useAppStore()

/** 「和助手说」开着时输入不走会话：整条背景条让位（Composer 的助手模式同款口径） */
const conversationID = computed(() => (store.assistantChat ? '' : store.activeConversationID))
const summary = computed(() => store.summaries.find((item) => item.id === conversationID.value))
/** 没连机器 / 没选中（或选中的还没出现在 summaries 里）时整块不出现 */
const show = computed(() => store.connected && !!summary.value)

const activity = computed(() => (conversationID.value ? store.activities[conversationID.value] : undefined))
const runtime = computed(() => (conversationID.value ? store.details[conversationID.value]?.runtime : undefined))

// 状态（同 SessionList / GhostSessions 的口径：在跑只给闪点不给字，等人出手的才给字）
const status = computed(() => activity.value?.status ?? 'idle')
const statusLabel: Record<string, string> = {
  running: '',
  approval: '等确认',
  question: '等你答',
  quota: '等额度',
  error: '出错'
}

/** 更新时间：当天 HH:MM，更早 M/D（同 SessionList / GhostSessions） */
function timeOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${date.getMonth() + 1}/${date.getDate()}`
}

// ---- 上下文：任务目标 / 步骤 / 正在用的工具（activity.task，update_task_state 维护的那份） ----

const task = computed(() => activity.value?.task)
const goal = computed(() => task.value?.goal?.trim() || '')
/** 步骤太多只露最后几步（焦点在当前进行到哪），前面的折成一行「已完成 N 步」 */
const STEP_WINDOW = 5
const visibleSteps = computed(() => (task.value?.steps ?? []).slice(-STEP_WINDOW))
const droppedSteps = computed(() => (task.value?.steps?.length ?? 0) - visibleSteps.value.length)
/** 步骤清单的悬停提示：完整列表带状态字（画面上折掉的部分在提示里全有） */
const stepsTip = computed(() =>
  (task.value?.steps ?? []).map((step) => `${step.status === 'done' ? '✓' : step.status === 'doing' ? '▸' : '○'} ${step.text}`).join('\n')
)
const stepGlyph: Record<string, string> = { done: '✓', doing: '▸', todo: '○' }

/** 正在用的工具（activity.currentTool；只在跑着时露，停下就不占地方） */
const currentTool = computed(() => (status.value === 'running' ? activity.value?.currentTool : undefined))

// ---- 上下文：这段会话还在跑的子 Agent（同 SessionList 的树，只留活着的分支） ----

const AGENT_WINDOW = 3
const agentRows = computed(() =>
  liveAgentRows(agentTreesByConversation(store.teamRuns).get(conversationID.value ?? '') ?? [])
)
const visibleAgents = computed<AgentRow[]>(() => agentRows.value.slice(0, AGENT_WINDOW))
const droppedAgents = computed(() => agentRows.value.length - visibleAgents.value.length)

// ---- 详细信息：模型 / 思考档位 / 任务模式 / 工作目录 / 权限 / 排队（一行带悬停全量提示） ----

/** 所有思考档位（runtime 没给能调的档位时兜底，保证 ultra 也能翻出标题来） */
const ALL_THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'ultra']
/** 任务模式短名（/mode 菜单同款口径，短一点塞得进一行） */
const TEAM_MODE_SHORT: Record<string, string> = {
  solo: '不派',
  delegatesHeavy: '需要时派',
  ultra: '极限'
}
const PERMISSION_SHORT: Record<string, string> = { auto: '自动', plan: '先方案', full: '全放行' }

const metaItems = computed<string[]>(() => {
  const out: string[] = []
  const item = summary.value
  if (!item) return out
  // 模型：会话选过的引擎，没选过跟随新对话默认（同输入框模型选择器的口径）
  const engine =
    store.engines.find((entry) => entry.id === item.engineID && !entry.disabled) ??
    store.engines.find((entry) => entry.id === store.defaultEngineID && !entry.disabled)
  out.push(`模型 ${engine ? engine.model || engine.title : '默认'}`)
  // 思考档位：会话记的档位，没记看 runtime 的当前档（同 /thinking 菜单的 effective 口径）
  const level = item.thinking ?? runtime.value?.thinkingLevel
  if (level) {
    const levels = runtime.value?.thinkingLevels?.length ? runtime.value.thinkingLevels : ALL_THINKING_LEVELS
    out.push(`思考 ${thinkingTitle(effectiveThinking(level, levels) ?? level, levels)}`)
  }
  // 任务模式：派不派子智能体（/mode 的三项）
  const modeRaw = normalizeTeamMode(item.teamMode)
  if (modeRaw) out.push(`模式 ${TEAM_MODE_SHORT[modeRaw] ?? modeRaw}`)
  // 工作目录：名字优先、路径兜底；没有的不占位
  const dir = item.workingDirectoryName || item.workingDirectory
  if (dir) out.push(`目录 ${dir}`)
  // 权限模式（auto/plan/full）
  if (item.permissionMode) out.push(`权限 ${PERMISSION_SHORT[item.permissionMode] ?? item.permissionMode}`)
  // 排着队的输入（生成中接着发会进队列）
  const queue = runtime.value?.queue?.length ?? 0
  if (queue > 0) out.push(`排队 ${queue}`)
  return out
})
</script>

<template>
  <Transition name="ctx-fade">
    <div
      v-if="show"
      class="composer-context"
      data-testid="composer-context"
      title="输入会发到这段会话 · 按 Esc 取消选中"
    >
      <!-- 头行：选中会话 · 状态点 · 标题 · 状态字 · 更新时间 -->
      <div class="ctx-head">
        <span class="ctx-label">选中会话</span>
        <span class="dot" :class="status" />
        <span class="ctx-title" :title="summary?.title">{{ summary?.title || '（无标题）' }}</span>
        <span v-if="statusLabel[status]" class="ctx-status" :class="status">{{ statusLabel[status] }}</span>
        <span class="ctx-time">{{ timeOf(summary?.updatedAt ?? '') }}</span>
      </div>

      <!-- 上下文：任务目标 → 正在用的工具 → 步骤进度 → 在跑的子 Agent（有哪样露哪样，全无则整块不出现） -->
      <template v-if="goal || visibleSteps.length || visibleAgents.length || currentTool">
        <div v-if="goal" class="ctx-goal" :title="goal">目标 · {{ goal }}</div>
        <div v-if="currentTool" class="ctx-tool" :title="currentTool.summary">正在 · {{ currentTool.title }}</div>
        <div v-if="visibleSteps.length" class="ctx-steps" :title="stepsTip">
          <div v-if="droppedSteps > 0" class="ctx-step done">⋯ 前 {{ droppedSteps }} 步已完成</div>
          <div v-for="(step, index) in visibleSteps" :key="index" class="ctx-step" :class="step.status">
            <span class="glyph">{{ stepGlyph[step.status] ?? '○' }}</span>{{ step.text }}
          </div>
        </div>
        <div v-if="visibleAgents.length" class="ctx-agents">
          <div
            v-for="agent in visibleAgents"
            :key="agent.run.id"
            class="ctx-agent"
            :style="{ '--depth': agent.depth }"
            :title="`子 Agent · ${agentActivityLabel(agent.run)}`"
          >
            <span class="aname">{{ agent.run.name }}</span>
            <span class="aact">{{ agentActivityLabel(agent.run) }}</span>
          </div>
          <div v-if="droppedAgents > 0" class="ctx-agent more">⋯ 还有 {{ droppedAgents }} 个在跑</div>
        </div>
      </template>

      <!-- 详细信息：一行排开，悬停给不了的那部分也在 title 里 -->
      <div v-if="metaItems.length" class="ctx-meta" :title="metaItems.join('\n')">{{ metaItems.join('  ·  ') }}</div>
    </div>
  </Transition>
</template>

<style scoped>
/* 背景形式（同 GhostSessions 的语言）：无卡片壳、半透明水印，融进桌面底纹。
   pointer-events 全 none——纯信息展示，底下投层气泡（可点掉）照常能点 */
.composer-context {
  flex: none;
  width: 100%;
  max-width: 760px;
  margin: 0 auto 6px;
  padding: 2px 12px 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 32vh;
  overflow: hidden;
  opacity: 0.92;
  user-select: none;
  pointer-events: none;
}

/* 出入场：淡入淡出 + 轻轻上下挪 4px（选中/取消选中时别跳） */
.ctx-fade-enter-active,
.ctx-fade-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.ctx-fade-enter-from,
.ctx-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

/* 头行 */
.ctx-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.ctx-label {
  flex: 0 0 auto;
  font-family: var(--font-hud);
  font-size: 10px;
  letter-spacing: 2.5px;
  color: var(--accent);
  opacity: 0.85;
}

.ctx-title {
  flex: 0 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  font-size: 13px;
  color: var(--text-2);
  /* 超宽向右渐隐（同会话列表行），水印不撑破桌面 */
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 26px), transparent);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 26px), transparent);
}

.ctx-time {
  flex: 1 0 auto;
  text-align: right;
  font-size: 10.5px;
  color: var(--muted);
  white-space: nowrap;
}

/* 状态点 / 状态字：同会话列表（在跑闪、等人出手的黄、出错红） */
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

.ctx-status {
  flex: 0 0 auto;
  font-size: 10px;
  font-family: var(--font-hud);
  color: var(--warn);
}

.ctx-status.error {
  color: var(--fail);
}

/* 任务目标 / 正在用的工具：一行，超宽向右渐隐 */
.ctx-goal,
.ctx-tool {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--text-2);
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 26px), transparent);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 26px), transparent);
}

.ctx-tool {
  color: var(--text-3);
}

/* 步骤进度：✓ 已完成 / ▸ 进行中 / ○ 待办，进行中的那步点亮 */
.ctx-steps {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ctx-step {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--text-3);
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 26px), transparent);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 26px), transparent);
}

.ctx-step .glyph {
  flex: 0 0 auto;
  font-size: 10px;
  width: 10px;
  text-align: center;
}

.ctx-step.done {
  color: var(--muted);
}

.ctx-step.doing {
  color: var(--text-2);
}

.ctx-step.doing .glyph {
  color: var(--accent);
}

/* 在跑的子 Agent：同树缩进（沉浸模式背景列表同款 L 形连线的简化版），活动短语走 HUD 等宽 */
.ctx-agents {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ctx-agent {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: calc(14px + var(--depth, 0) * 12px);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-3);
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 26px), transparent);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 26px), transparent);
}

.ctx-agent::before {
  content: '';
  position: absolute;
  left: calc(1px + var(--depth, 0) * 12px);
  top: -2px;
  bottom: 50%;
  width: 8px;
  border-left: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  border-bottom-left-radius: 5px;
  opacity: 0.7;
}

.ctx-agent .aname {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ctx-agent .aact {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-hud);
  font-size: 10px;
  color: var(--muted);
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 18px), transparent);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 18px), transparent);
}

/* 详细信息行：最淡的一行，点开输入台前扫一眼就知道发给谁、在哪干活 */
.ctx-meta {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--muted);
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 26px), transparent);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 26px), transparent);
}
</style>
