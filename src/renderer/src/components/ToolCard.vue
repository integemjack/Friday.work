<script setup lang="ts">
// 工具卡片：符号 + 标题 + 状态徽标 + 参数/结果摘要；展开看完整；transcript 递归渲染成子卡片（方案 §5.3）
import { computed, ref } from 'vue'
import type { ToolEvent } from '../../../protocol/rpc/protocol.js'
import { blockCase, blockPayload } from '../../../protocol/rpc/protocol.js'
import ToolCard from './ToolCard.vue'

const props = defineProps<{
  tool: ToolEvent
  /** 展开状态由父级管（保持多个卡片状态） */
  openModel?: boolean
}>()

const open = ref(props.openModel ?? false)

const statusClass = computed(() => {
  switch (props.tool.status) {
    case 'succeeded': return 'ok'
    case 'failed': return 'fail'
    case 'awaitingApproval': return 'warn'
    case 'running': return 'run'
    default: return ''
  }
})

const statusText = computed(() => {
  switch (props.tool.status) {
    case 'succeeded': return '完成'
    case 'failed': return '失败'
    case 'awaitingApproval': return '待确认'
    case 'running': return '运行中'
    case 'denied': return '已拒绝'
    default: return props.tool.status
  }
})

const title = computed(() => props.tool.title ?? props.tool.name)

/** 展开后的参数：JSON 就格式化，否则原样 */
const prettyArguments = computed(() => {
  const raw = props.tool.arguments?.trim()
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
})

/** 参数摘要：JSON 里取出主要字段（path / command / url / prompt …），不直接截 JSON */
const argumentSummary = computed(() => {
  const raw = props.tool.arguments?.trim()
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const keys = ['command', 'path', 'url', 'prompt', 'query', 'task', 'pattern', 'keywords', 'text', 'goal']
    for (const key of keys) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').slice(0, 200)
    }
    const first = Object.entries(parsed)[0]
    if (first && typeof first[1] === 'string') return `${first[0]}: ${first[1]}`.slice(0, 200)
    return Object.keys(parsed).join(', ').slice(0, 200)
  } catch {
    return raw.replace(/\s+/g, ' ').slice(0, 200)
  }
})

/** 结果摘要（第一行） */
const resultSummary = computed(() => {
  const text = props.tool.result?.trim()
  if (!text) return ''
  return text.split('\n')[0]!.slice(0, 300)
})

function symbol(): string {
  switch (props.tool.symbol) {
    case undefined: case '': return '⚙️'
    case 'run': return '▶'
    case 'file': return '📄'
    case 'browser': return '🌐'
    case 'terminal': return '⌨'
    case 'search': return '🔎'
    default: return props.tool.symbol
  }
}
</script>

<template>
  <div class="tool-card" :class="[statusClass, { open }]" @click="open = !open">
    <div class="tool-head">
      <span class="tool-symbol">{{ symbol() }}</span>
      <span class="tool-title">{{ title }}</span>
      <span class="tool-status" :class="statusClass">{{ statusText }}</span>
      <span class="tool-chevron">{{ open ? '▾' : '▸' }}</span>
    </div>
    <div v-if="!open" class="tool-summary">
      <div v-if="argumentSummary" class="arg">参数：{{ argumentSummary }}</div>
      <div v-if="resultSummary" class="res">{{ resultSummary }}</div>
    </div>
    <div v-if="open" class="tool-open">
      <div v-if="tool.arguments" class="section">
        <div class="section-label">参数</div>
        <pre>{{ prettyArguments }}</pre>
      </div>
      <div v-if="tool.result" class="section">
        <div class="section-label">结果</div>
        <pre>{{ tool.result }}</pre>
      </div>
      <!-- 子 Agent 的运行记录：递归渲染成嵌套卡片（方案 §5.7） -->
      <div v-if="tool.transcript && tool.transcript.length > 0" class="section">
        <div class="section-label">运行记录</div>
        <div class="transcript">
          <div v-for="block in tool.transcript" :key="block.id" class="t-block">
            <ToolCard
              v-if="blockCase(block) === 'tool'"
              :tool="blockPayload<ToolEvent>(block, 'tool')!"
            />
            <pre v-else-if="blockCase(block) === 'text'" class="t-text">{{ blockPayload<string>(block, 'text') }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  padding: 4px 0;
  cursor: pointer;
  overflow: hidden;
}

.tool-card.open {
  background: var(--panel);
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
}

.tool-symbol {
  font-size: 14px;
}

.tool-title {
  font-weight: 500;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-status {
  flex: none;
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-2);
}

.tool-status.ok { color: var(--ok); border-color: var(--ok); }
.tool-status.fail { color: var(--fail); border-color: var(--fail); }
.tool-status.warn { color: var(--warn); border-color: var(--warn); }
.tool-status.run { color: var(--run); border-color: var(--run); }

.tool-chevron {
  color: var(--text-3);
  font-size: 11px;
}

.tool-summary {
  padding: 0 12px 7px;
  font-size: 12.5px;
  color: var(--text-2);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.arg {
  color: var(--text-3);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
}

.res {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-open {
  border-top: 1px solid var(--border);
}

.section {
  padding: 8px 12px;
  border-top: 1px solid var(--border);
}

.section:first-child {
  border-top: none;
}

.section-label {
  font-size: 11.5px;
  color: var(--text-3);
  margin-bottom: 5px;
}

.transcript {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.t-block {
  border-left: 2px solid var(--border);
  padding-left: 8px;
}

.t-text {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-2);
}

/* 贾维斯界面：工具卡片变任务遥测条（左侧状态条在全局 jarvis.css） */
[data-theme='jarvis'] .tool-card {
  background: rgba(10, 25, 45, 0.45);
  border-color: rgba(34, 211, 238, 0.18);
}

[data-theme='jarvis'] .tool-card.open {
  border-color: rgba(34, 211, 238, 0.32);
}

[data-theme='jarvis'] .tool-title {
  letter-spacing: 0.5px;
}

[data-theme='jarvis'] .tool-status {
  font-family: var(--font-hud);
  font-size: 10.5px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
}

[data-theme='jarvis'] .tool-status.run {
  color: var(--accent);
  text-shadow: 0 0 8px rgba(34, 211, 238, 0.55);
}

[data-theme='jarvis'] .tool-symbol {
  filter: drop-shadow(0 0 5px rgba(34, 211, 238, 0.5));
}

[data-theme='jarvis'] .section-label {
  font-family: var(--font-hud);
  font-size: 10.5px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--accent);
  opacity: 0.75;
}

[data-theme='jarvis'] .arg,
[data-theme='jarvis'] .res {
  color: #9adcf2;
}
</style>