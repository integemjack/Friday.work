<script setup lang="ts">
// 右下角常驻的「与助手聊天」面板（2026-10 布局改版）：
// 作用在当前选中的会话上（左侧会话列表切换），流式输出同时以气泡投到桌面。
// 状态条 / 审批横幅 / 消息流 / 输入框，比会话窗口紧凑，去掉了分支切换器。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app.js'
import MessageItem from './MessageItem.vue'
import Composer from './Composer.vue'

const store = useAppStore()
const scrollEl = ref<HTMLDivElement | null>(null)
const messagesEl = ref<HTMLDivElement | null>(null)
const stickToBottom = ref(true)

const conversationID = computed(() => store.activeConversationID)
const detail = computed(() => store.details[conversationID.value] ?? null)
const summary = computed(() => store.summaries.find((item) => item.id === conversationID.value) ?? null)
const allMessages = computed(() => detail.value?.messages ?? [])
const visibleCount = ref(40)
const messages = computed(() => {
  const all = allMessages.value
  return all.length <= visibleCount.value ? all : all.slice(all.length - visibleCount.value)
})
const runtime = computed(() => detail.value?.runtime ?? null)
const approvals = computed(() => store.approvals[conversationID.value] ?? [])

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    if (stickToBottom.value) void scrollToBottom()
  })
  if (messagesEl.value) resizeObserver.observe(messagesEl.value)
  void scrollToBottom(true)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

function onScroll() {
  const el = scrollEl.value
  if (!el) return
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

watch(conversationID, () => {
  visibleCount.value = 40
  stickToBottom.value = true
  void scrollToBottom(true)
})

async function scrollToBottom(immediate = false) {
  await nextTick()
  const el = scrollEl.value
  if (!el || (!stickToBottom.value && !immediate)) return
  el.scrollTop = el.scrollHeight
}

watch(messages, () => void scrollToBottom(), { deep: false })

async function submit(text: string, attachments: Array<{ path: string; name: string }>) {
  await store.submitText(text, attachments)
  stickToBottom.value = true
  await scrollToBottom(true)
}

const statusLine = computed(() => {
  const current = runtime.value
  if (!current) return ''
  if (current.generating) return '正在生成…'
  if (current.stopping) return '正在停止…'
  if (approvals.value.length > 0) return '等待你确认'
  if (current.queue.length > 0) return `${current.queue.length} 条消息排队`
  return ''
})
</script>

<template>
  <section class="assistant-chat" data-testid="assistant-chat">
    <header class="head">
      <span class="head-title">助手</span>
      <span v-if="summary" class="session-name" :title="summary.title">{{ summary.title || '（无标题）' }}</span>
      <span v-if="statusLine" class="status-line">{{ statusLine }}</span>
      <span class="spacer" />
      <button v-if="runtime?.generating" class="stop-btn" @click="store.stopRunner(conversationID)">停止</button>
    </header>

    <div v-if="approvals.length > 0" class="approval-bar">
      <div v-for="approval in approvals" :key="approval.eventID" class="approval-item">
        <span class="approval-tool">{{ approval.title || approval.tool }}</span>
        <span class="approval-summary">{{ approval.summary }}</span>
        <div class="approval-actions">
          <button class="abtn" @click="store.resolveApproval(approval.eventID, false)">拒绝</button>
          <button class="abtn primary" @click="store.resolveApproval(approval.eventID, true)">批准</button>
        </div>
      </div>
    </div>

    <div ref="scrollEl" class="message-scroll" @scroll="onScroll">
      <div ref="messagesEl" class="messages">
        <MessageItem v-for="entry in messages" :key="entry.message.id" :message="entry.message" />
        <div v-if="!conversationID" class="hint">
          {{ store.connected ? '选一段会话，或直接说话（会自动开一段新的）' : '先连上机器' }}
        </div>
      </div>
    </div>

    <Composer :conversation-id="conversationID" @submit="submit" />
  </section>
</template>

<style scoped>
.assistant-chat {
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
  gap: 8px;
  padding: 2px 4px 6px;
}

.head-title {
  font-family: var(--font-hud);
  font-size: 11px;
  letter-spacing: 3px;
  color: var(--accent);
  opacity: 0.85;
}

.session-name {
  font-size: 12px;
  color: var(--fg-2, var(--fg));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}

.status-line {
  font-size: 11px;
  color: var(--run, var(--accent));
}

.spacer {
  flex: 1 1 auto;
}

.stop-btn {
  font-size: 11px;
  padding: 1px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: transparent;
  color: var(--fg-2, var(--fg));
  cursor: pointer;
}

.stop-btn:hover {
  border-color: var(--fail);
  color: var(--fail);
}

.approval-bar {
  flex: none;
  border-bottom: 1px solid var(--warn);
  background: var(--warn);
}

.approval-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  color: #fff;
  font-size: 12px;
  flex-wrap: wrap;
}

.approval-tool {
  font-weight: 600;
}

.approval-summary {
  flex: 1;
  min-width: 100px;
  opacity: 0.92;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.approval-actions {
  display: flex;
  gap: 6px;
}

.abtn {
  border: 1px solid #fff;
  background: transparent;
  color: #fff;
  font-size: 11.5px;
  padding: 2px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.abtn:hover {
  background: rgba(255, 255, 255, 0.18);
}

.abtn.primary {
  background: #fff;
  color: var(--warn);
  font-weight: 600;
}

.message-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 8px;
}

.messages {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hint {
  padding: 10px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

/* 输入框贴底、收紧 */
.assistant-chat :deep(.composer) {
  border-top: 1px solid var(--line);
  border-bottom: none;
}
</style>
