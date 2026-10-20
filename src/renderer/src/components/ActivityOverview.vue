<script setup lang="ts">
// 活动总览（M2，方案 §5.2）：这台机器上全部会话的实时动静 ——
// 正在生成、等确认、等回答、卡住、出错。点一条切到那段会话。
// 数据源：activity.subscribe 的 SessionActivity（store 里按 conversationID 存）
import { computed } from 'vue'
import type { SessionActivity } from '../../../protocol/rpc/protocol.js'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()

const statusText: Record<string, string> = {
  idle: '闲着',
  running: '在干',
  approval: '等确认',
  question: '等你回答',
  quota: '等额度',
  error: '出错'
}

/** 有动静的会话（不是 idle 的），按状态优先级排 */
const interesting = computed<SessionActivity[]>(() => {
  const rank: Record<string, number> = { approval: 0, question: 1, quota: 2, error: 3, running: 4, idle: 5 }
  return Object.values(store.activities)
    .filter((activity) => activity.status !== 'idle')
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))
})

function open(conversationID: string): void {
  void store.openConversation(conversationID)
}

function briefOf(activity: SessionActivity): string {
  if (activity.task?.goal) return activity.task.goal
  if (activity.currentTool?.title) return `正在：${activity.currentTool.title}`
  if (activity.approvals?.length) return `等你确认：${activity.approvals[0]!.title}`
  return ''
}
</script>

<template>
  <div class="activity">
    <div class="activity-head">正在跑的会话</div>
    <button v-for="item in interesting" :key="item.id" class="row" @click="open(item.id)">
      <span class="dot" :class="item.status" />
      <span class="title">{{ item.title }}</span>
      <span class="status">{{ statusText[item.status] ?? item.status }}</span>
      <span v-if="briefOf(item)" class="brief">{{ briefOf(item) }}</span>
      <span v-if="item.task?.steps?.length" class="steps">
        <span
          v-for="(step, index) in item.task.steps"
          :key="index"
          class="step"
          :class="step.status"
          :title="step.text"
        />
      </span>
    </button>
    <div v-if="!interesting.length" class="empty-tip">
      现在没有会话在跑。智能体开始干活时，这里会实时列出它在做什么。
    </div>
  </div>
</template>

<style scoped>
.activity {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 10px;
}

.activity-head {
  font-size: 12px;
  color: var(--text-2);
  padding: 2px 4px 8px;
}

.empty-tip {
  padding: 16px 6px;
  color: var(--text-3);
  font-size: 12.5px;
  line-height: 1.7;
}

.row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  padding: 5px 6px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text);
  font-size: 12.5px;
}

.row:hover {
  background: var(--panel-2);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
}

.dot.running {
  background: var(--run);
  animation: pulse 1.4s ease-in-out infinite;
}

.dot.approval,
.dot.question {
  background: var(--warn);
}

.dot.quota {
  background: var(--warn);
}

.dot.error {
  background: var(--fail);
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
  font-size: 11.5px;
  color: var(--text-2);
  flex: none;
}

.brief {
  grid-column: 2 / 4;
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.steps {
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
}

.step.doing {
  background: var(--run);
}

/* 贾维斯界面：活动总览变遥测面板（分头/行/进度块的样式在全局 jarvis.css） */
[data-theme='jarvis'] .activity-head {
  border-bottom: 1px solid rgba(34, 211, 238, 0.2);
  padding-bottom: 6px;
}

[data-theme='jarvis'] .row {
  border-left: 2px solid transparent;
}

[data-theme='jarvis'] .row:hover {
  border-left-color: rgba(34, 211, 238, 0.5);
  background: rgba(34, 211, 238, 0.05);
}
</style>
