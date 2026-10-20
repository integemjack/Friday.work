<script setup lang="ts">
// 后台子 Agent 卡片（M2，方案 §5.7 / REMOTE.md §5 TeamState）：
// 每个子 Agent 一行：名字、活动、第几步、运行多久、速度、排队消息；停 / 插话（agent.stop / agent.send）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TeamRun } from '../../../protocol/rpc/protocol.js'
import { rpc } from '../lib/host.js'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()
const now = ref(Date.now())
let timer: number | null = null

onMounted(() => {
  // 状态行按本地时钟每秒刷新（不用服务端推，REMOTE.md §5）
  timer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})

const runs = computed(() =>
  [...store.teamRuns].sort((a, b) => (a.running === b.running ? a.started.localeCompare(b.started) : a.running ? -1 : 1))
)

/** 这段会话的子 Agent（卡片里优先显示） */
const visibleRuns = computed(() => runs.value)

function since(iso?: string): string {
  if (!iso) return ''
  const seconds = Math.max(0, Math.round((now.value - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`
}

function activityText(run: TeamRun): string {
  if (!run.activity) return '在想'
  const kind = run.activity.kind
  const label =
    kind === 'generating'
      ? '在生成'
      : kind === 'tool'
        ? `在执行「${run.activity.title}」`
        : kind === 'waitingChildren'
          ? '在等子 Agent'
          : kind === 'waitingApproval'
            ? `在等确认：${run.activity.title}`
            : '排队中'
  const idle = run.lastOutput ? ` · ${since(run.lastOutput)}前有动静` : ''
  return `${label}${idle}`
}

async function stop(run: TeamRun): Promise<void> {
  if (!store.currentMachine) return
  await rpc(store.currentMachine, 'agent.stop', { agentID: run.id }).catch((error) => {
    store.error = error instanceof Error ? error.message : String(error)
  })
}

const speaking = ref('')
const speakingText = ref('')

async function send(run: TeamRun): Promise<void> {
  const text = speakingText.value.trim()
  if (!text || !store.currentMachine) return
  try {
    await rpc(store.currentMachine, 'agent.send', { agentID: run.id, text, attachments: [] })
    speakingText.value = ''
    speaking.value = ''
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <div class="agents-card">
    <div v-if="!visibleRuns.length" class="empty-tip">现在没有子 Agent 在跑</div>
    <div v-for="run in visibleRuns" :key="run.id" class="run" :class="{ done: !run.running }">
      <div class="run-head">
        <span class="name">{{ run.name }}</span>
        <span class="chip">{{ run.background ? '后台' : '前台' }}</span>
        <span v-if="run.running" class="live-dot" />
        <span class="spacer" />
        <button v-if="run.running" class="link" title="让它停下来" @click="stop(run)">停</button>
        <button
          v-if="run.running"
          class="link"
          title="给它插句话"
          @click="speaking = speaking === run.id ? '' : run.id"
        >
          插话
        </button>
      </div>
      <div class="run-line">{{ activityText(run) }}</div>
      <div class="run-line muted">
        第 {{ run.steps }} 步 · 已运行 {{ since(run.started) }}
        <template v-if="run.speed"> · {{ run.speed.toFixed(1) }} tok/s</template>
        <template v-if="run.passTokens"> · 本轮 {{ run.passTokens }} tok</template>
      </div>
      <div v-if="run.queue.length" class="run-line muted">排队 {{ run.queue.length }} 条</div>
      <div v-if="speaking === run.id" class="speak">
        <input
          v-model="speakingText"
          class="speak-input"
          placeholder="给它插一句话，下一轮它会看到"
          @keydown.enter="send(run)"
        />
        <button class="link" @click="send(run)">发送</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agents-card {
  height: 100%;
  overflow-y: auto;
  padding: 6px 0;
  font-size: 12.5px;
}

.empty-tip {
  padding: 14px;
  color: var(--muted);
  font-size: 12px;
}

.run {
  padding: 7px 12px;
  border-bottom: 1px solid var(--line);
}

.run.done {
  opacity: 0.55;
}

.run-head {
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 1.5;
}

.name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip {
  font-size: 10px;
  color: var(--muted);
  background: var(--chip);
  border-radius: 4px;
  padding: 0 5px;
}

.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4aa3e0;
  animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.spacer {
  flex: 1 1 auto;
}

.run-line {
  line-height: 1.6;
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.muted {
  color: var(--muted);
}

.link {
  border: none;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 4px;
}

.link:hover {
  background: var(--hover);
}

.speak {
  display: flex;
  gap: 6px;
  margin-top: 5px;
}

.speak-input {
  flex: 1 1 auto;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--panel-2);
  color: var(--fg);
  font-size: 11.5px;
  padding: 3px 7px;
  outline: none;
}

/* 贾维斯界面：子 Agent 变在役任务单元——左侧青线、运行中渐变、状态等宽化 */
[data-theme='jarvis'] .run {
  border-left: 2px solid var(--accent-a35);
}

[data-theme='jarvis'] .run:not(.done) {
  background: linear-gradient(90deg, var(--accent-a5), transparent 60%);
}

[data-theme='jarvis'] .live-dot {
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent-a70);
}

[data-theme='jarvis'] .chip,
[data-theme='jarvis'] .run-line.muted {
  font-family: var(--font-hud);
}

[data-theme='jarvis'] .chip {
  color: var(--accent);
  background: var(--accent-a10);
}
</style>
