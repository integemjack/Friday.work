<script setup lang="ts">
// 选中会话的上下文背景条（2026-10）：会话列表里选中一段会话后，输入台上方以背景形式
// （无卡片壳、半透明、pointer-events:none 的纯水印，不挡底下投层气泡的点击）显示这段会话的
// 上下文（任务目标 / 步骤进度 / 在跑的子 Agent / 正在用的工具）和详细信息（模型、思考档位、
// 任务模式、工作目录、权限、排队，末尾追加实时的上下文长度与占比），让「输入台里发出去的话
// 落在哪段会话上」一眼可见。
// 没选会话（默认态，输入即开新会话）或「和助手说」时整块不出现；Esc 取消选中后同样消失（App.vue）。
import { computed } from 'vue'
import { useAppStore } from '../stores/app.js'
import { effectiveThinking, normalizeTeamMode, thinkingTitle } from '../lib/builtinCommands.js'
import { agentActivityLabel, agentTreesByConversation, liveAgentRows } from '../lib/agentTree.js'
import type { AgentRow } from '../lib/agentTree.js'
import { contextMixOf, contextPercent, contextWindowNote, formatTokenCount } from '../lib/contextWindow.js'
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

// ---- 实时上下文长度：当前分支上最后一条带 stats.contextTokenCount 的助手消息（生成中流式原地更新，
//      MessagePatcher 的 fields 补丁直接写回消息节点，这里跟着实时变）；老服务端没这字段就不显示 ----

const contextStats = computed(() => {
  const messages = conversationID.value ? store.details[conversationID.value]?.messages : undefined
  if (!messages) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const stats = messages[i]!.message.stats
    const count = stats?.contextTokenCount
    if (typeof count === 'number' && count > 0) return { tokens: count, live: !!stats?.live }
  }
  return undefined
})

// ---- 上下文构成：各个工具（及文本 / 思考）各占多少，按块内容估算（媒体不计入）。
//      堆叠条 + 图例：前几个工具各自一段，其余合进「其他」；文本 / 思考用灰阶，工具用色板 ----

const MIX_NON_TOOL_LABEL: Record<string, string> = { text: '文本', thinking: '思考' }

/** 段的颜色：非工具类灰阶；工具按出现顺序在色板上轮转（同一次会话里同一工具尽量同色） */
function mixColor(key: string, order: number): string {
  if (key === 'text') return 'var(--fg-3, #9a9aa5)'
  if (key === 'thinking') return 'var(--muted, #6f6f7a)'
  if (key === '__other') return 'var(--border, #4a4a55)'
  return `hsl(${(order * 53 + 190) % 360} 55% 52%)`
}

const contextMixRows = computed(() => {
  const messages = conversationID.value ? store.details[conversationID.value]?.messages : undefined
  if (!messages || messages.length === 0) return []
  const mix = contextMixOf(messages)
  const total = mix.reduce((sum, seg) => sum + seg.tokens, 0)
  if (total <= 0) return []
  // 降序已由 contextMixOf 给出：前 5 工具 + 文本/思考各自成段；剩下的合进「其他」
  const kept: Array<{ key: string; label: string; color: string; percent: number }> = []
  let other = 0
  const otherKeys = new Set<string>()
  let toolOrder = 0
  for (const seg of mix) {
    const isTool = seg.key.startsWith('tool:')
    const label = isTool ? seg.key.slice(5) : MIX_NON_TOOL_LABEL[seg.key]
    if (!label) continue
    const percent = Math.round((seg.tokens / total) * 100)
    if (percent <= 0) continue
    const keep = !isTool || toolOrder < 5
    if (keep) {
      kept.push({ key: seg.key, label, color: mixColor(seg.key, toolOrder), percent })
      if (isTool) toolOrder += 1
    } else {
      other += seg.tokens
      otherKeys.add(seg.key)
    }
  }
  if (other > 0) {
    kept.push({ key: '__other', label: `其他 ${otherKeys.size}`, color: mixColor('__other', 0), percent: Math.round((other / total) * 100) })
  }
  return kept
})

// ---- 详细信息：模型 / 思考档位 / 任务模式 / 工作目录 / 权限 / 排队 / 上下文长度占比（末尾追加，
//      每项带悬停提示；占比的分母按模型认窗口估算，认不出只显长度） ----

/** 所有思考档位（runtime 没给能调的档位时兜底，保证 ultra 也能翻出标题来） */
const ALL_THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'ultra']
/** 任务模式短名（/mode 菜单同款口径，短一点塞得进一行；ultra 2026-10-23 起叫「工作流」） */
const TEAM_MODE_SHORT: Record<string, string> = {
  solo: '不派',
  delegatesHeavy: '需要时派',
  ultra: '工作流'
}
/** 权限短名（== Qt PermissionMode.title：自动 / 计划 / 完全，与输入框的权限选择器同一口径） */
const PERMISSION_SHORT: Record<string, string> = { auto: '自动', plan: '计划', full: '完全' }

/** 详细信息行的一项：正文 + 悬停提示 + 高亮色（占比高时警示） */
interface MetaItem {
  text: string
  tip?: string
  warn?: boolean
}

/** 这段会话实际在用的引擎（选过的，没选过跟随新对话默认；模型选择器同款口径） */
const engineOf = computed(
  () =>
    store.engines.find((entry) => entry.id === summary.value?.engineID && !entry.disabled) ??
    store.engines.find((entry) => entry.id === store.defaultEngineID && !entry.disabled)
)

const metaItems = computed<MetaItem[]>(() => {
  const out: MetaItem[] = []
  const item = summary.value
  if (!item) return out
  // 模型：会话选过的引擎，没选过跟随新对话默认（同输入框模型选择器的口径）
  const engine = engineOf.value
  out.push({ text: `模型 ${engine ? engine.model || engine.title : '默认'}` })
  // 思考档位：会话记的档位，没记看 runtime 的当前档（同 /thinking 菜单的 effective 口径）
  const level = item.thinking ?? runtime.value?.thinkingLevel
  if (level) {
    const levels = runtime.value?.thinkingLevels?.length ? runtime.value.thinkingLevels : ALL_THINKING_LEVELS
    out.push({ text: `思考 ${thinkingTitle(effectiveThinking(level, levels) ?? level, levels)}` })
  }
  // 任务模式：派不派子智能体（/mode 的三项）
  const modeRaw = normalizeTeamMode(item.teamMode)
  if (modeRaw) out.push({ text: `模式 ${TEAM_MODE_SHORT[modeRaw] ?? modeRaw}` })
  // 工作目录：名字优先、路径兜底；没有的不占位
  const dir = item.workingDirectoryName || item.workingDirectory
  if (dir) out.push({ text: `目录 ${dir}`, tip: dir === item.workingDirectoryName ? item.workingDirectory : undefined })
  // 权限模式（auto/plan/full）
  if (item.permissionMode) out.push({ text: `权限 ${PERMISSION_SHORT[item.permissionMode] ?? item.permissionMode}` })
  // 排着队的输入（生成中接着发会进队列）
  const queue = runtime.value?.queue?.length ?? 0
  if (queue > 0) out.push({ text: `排队 ${queue}` })
  // 上下文长度与占比（实时，末尾追加）：长度来自最近一次生成的 stats；占比的分母协议里没有，
  // 按在用模型认窗口估算，认不出的只显示长度不给误导性的百分比
  const context = contextStats.value
  if (context) {
    const window = contextWindowNote(engine ? engine.model || engine.title : undefined)
    if (window) {
      const percent = contextPercent(context.tokens, window.tokens)
      out.push({
        text: `上下文 ${formatTokenCount(context.tokens)} · ${percent}%`,
        tip: `最近一次生成时模型带着 ${context.tokens.toLocaleString()} tokens 的上下文；窗口按 ${window.note}（约 ${formatTokenCount(window.tokens)}）估算`,
        warn: percent >= 80
      })
    } else {
      out.push({
        text: `上下文 ${formatTokenCount(context.tokens)}`,
        tip: `最近一次生成时模型带着 ${context.tokens.toLocaleString()} tokens 的上下文；这个模型的窗口大小认不出，只显示长度`
      })
    }
  }
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

      <!-- 上下文构成：各工具（及文本/思考）按内容估算的占比，堆叠条 + 图例（媒体不计入，估算口径） -->
      <div v-if="contextMixRows.length" class="ctx-mix">
        <span class="ctx-mix-label">构成</span>
        <div class="ctx-mix-bar">
          <span
            v-for="seg in contextMixRows"
            :key="seg.key"
            :style="{ flex: Math.max(seg.percent, 0.6), background: seg.color }"
          />
        </div>
        <div class="ctx-mix-legend">
          <span v-for="seg in contextMixRows" :key="seg.key" class="ctx-mix-item">
            <span class="dot" :style="{ background: seg.color }" />
            {{ seg.label }} {{ seg.percent }}%
          </span>
        </div>
      </div>

      <!-- 详细信息：一行排开，每项自带悬停提示（上下文占比高时那一项转警示色） -->
      <div v-if="metaItems.length" class="ctx-meta">
        <template v-for="(item, index) in metaItems" :key="index">
          <span v-if="index > 0" class="sep"> · </span>
          <span :class="{ warn: item.warn }" :title="item.tip">{{ item.text }}</span>
        </template>
      </div>
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

/* 上下文构成：堆叠条 + 图例。估算口径（系统提示/缓存/媒体不计入）写在标签 title 里 */
.ctx-mix {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--fg-2, var(--fg));
}

.ctx-mix-label {
  color: var(--muted);
}

.ctx-mix-bar {
  display: flex;
  width: 100%;
  height: 4px;
  gap: 1px;
  border-radius: 2px;
  overflow: hidden;
  opacity: 0.9;
}

.ctx-mix-bar span {
  min-width: 2px;
}

.ctx-mix-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  color: var(--muted);
  white-space: nowrap;
}

.ctx-mix-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.ctx-mix-item .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
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

/* 上下文占比 ≥80%：那一项转警示色（窗口快满的预告） */
.ctx-meta .warn {
  color: var(--warn);
}
</style>
