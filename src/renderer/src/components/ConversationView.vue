<script setup lang="ts">
// 一段会话的窗口内容：任务状态条、审批横幅、消息流、输入框（方案 §5.3）。
// 每个窗口对应一段会话（多会话可同时开窗）。
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app.js'
import MessageItem from './MessageItem.vue'
import Composer from './Composer.vue'

const props = defineProps<{ conversationId?: string }>()

const store = useAppStore()
const scrollEl = ref<HTMLDivElement | null>(null)
const stickToBottom = ref(true)

const conversationID = computed(() => props.conversationId ?? '')
const detail = computed(() => store.details[conversationID.value] ?? null)
const messages = computed(() => detail.value?.messages ?? [])
const runtime = computed(() => detail.value?.runtime ?? null)
const approvals = computed(() => store.approvals[conversationID.value] ?? [])

onMounted(() => {
  if (conversationID.value) store.activeConversationID = conversationID.value
  void scrollToBottom(true)
})

function onScroll() {
  const el = scrollEl.value
  if (!el) return
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

async function scrollToBottom(immediate = false) {
  await nextTick()
  const el = scrollEl.value
  if (!el || (!stickToBottom.value && !immediate)) return
  el.scrollTop = el.scrollHeight
}

watch(messages, () => void scrollToBottom(), { deep: false })

async function submit(text: string, attachments: Array<{ path: string; name: string }>) {
  store.activeConversationID = conversationID.value
  await store.submitText(text, attachments)
  stickToBottom.value = true
  await scrollToBottom(true)
}

/** 这条消息的同父分支信息（没有 = 不显示切换器） */
function branchOf(messageID: string) {
  return store.branchInfo[conversationID.value]?.[messageID]
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
  <div class="conversation-view">
    <div class="status-bar">
      <span v-if="statusLine" class="status-line">{{ statusLine }}</span>
      <span v-else class="status-idle">就绪 · {{ store.currentMachineInfo?.name }}</span>
      <span v-if="approvals.length > 0" class="approval-count">{{ approvals.length }} 个待确认</span>
      <button
        v-if="runtime?.generating"
        class="stop-btn"
        @click="store.stopRunner(conversationID)"
      >
        停止
      </button>
    </div>

    <!-- 审批横幅（橙色，方案 §5.3） -->
    <div v-if="approvals.length > 0" class="approval-bar">
      <div v-for="approval in approvals" :key="approval.eventID" class="approval-item">
        <span class="approval-tool">{{ approval.title || approval.tool }}</span>
        <span class="approval-summary">{{ approval.summary }}</span>
        <div class="approval-actions">
          <button class="btn danger" @click="store.resolveApproval(approval.eventID, false)">拒绝</button>
          <button class="btn primary" @click="store.resolveApproval(approval.eventID, true)">批准</button>
        </div>
      </div>
    </div>

    <div ref="scrollEl" class="message-scroll" @scroll="onScroll">
      <div class="messages">
        <div v-for="entry in messages" :key="entry.message.id" class="message-wrap">
          <!-- 分叉切换器（方案 §5.3：同父多个孩子时显示） -->
          <div v-if="branchOf(entry.message.id)" class="branch-row">
            <button class="branch-btn" title="上一条分支" @click="store.switchBranch(conversationID, entry.message.id, -1)">
              ‹
            </button>
            <span class="branch-pos">
              {{ (branchOf(entry.message.id)?.index ?? 0) + 1 }}/{{ branchOf(entry.message.id)?.count }}
            </span>
            <button class="branch-btn" title="下一条分支" @click="store.switchBranch(conversationID, entry.message.id, 1)">
              ›
            </button>
          </div>
          <MessageItem :message="entry.message" />
        </div>
        <div v-if="messages.length === 0" class="no-messages">这段会话还没有消息，说第一句吧。</div>
      </div>
    </div>

    <Composer :conversation-id="conversationID" @submit="submit" />
  </div>
</template>

<style scoped>
.conversation-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
}

.status-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-2);
  background: var(--panel-2);
}

.status-line {
  color: var(--run);
}

.status-idle {
  color: var(--text-3);
}

.approval-count {
  margin-left: auto;
  color: var(--warn);
}

.stop-btn {
  margin-left: auto;
  font-size: 12px;
  padding: 2px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
}

.stop-btn:hover {
  border-color: var(--fail);
  color: var(--fail);
}

.approval-bar {
  flex: none;
  border-bottom: 1px solid var(--border);
  background: var(--warn);
}

.approval-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  color: #fff;
  font-size: 12.5px;
  flex-wrap: wrap;
}

.approval-tool {
  font-weight: 600;
}

.approval-summary {
  flex: 1;
  min-width: 120px;
  opacity: 0.92;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.approval-actions {
  display: flex;
  gap: 6px;
}

.approval-actions .btn {
  padding: 3px 12px;
  font-size: 12px;
}

.approval-actions .btn.primary {
  background: #fff;
  color: var(--warn);
  border-color: #fff;
}

.approval-actions .btn.danger {
  background: transparent;
  color: #fff;
  border-color: rgba(255, 255, 255, 0.6);
}

.message-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scroll-behavior: smooth;
}

.message-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 分叉切换器：同父多个孩子时显示在消息上方 */
.branch-row {
  display: flex;
  align-items: center;
  gap: 2px;
  align-self: flex-start;
  padding: 0 2px;
}

.branch-btn {
  width: 20px;
  height: 20px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel);
  color: var(--text-2);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}

.branch-btn:hover {
  background: var(--panel-2);
  color: var(--text);
}

.branch-pos {
  font-size: 11px;
  color: var(--text-3);
  min-width: 26px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.messages {
  max-width: 900px;
  margin: 0 auto;
  padding: 16px 20px 8px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.no-messages {
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
  padding: 40px 0;
}
</style>
