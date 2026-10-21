<script setup lang="ts">
// 右栏下半段常驻的「与助手聊天」面板：叠在视频上面，顶端顶到视频中点、向上渐隐。
// 作用在当前选中的会话上（左侧会话列表切换）；没选中时默认就是和助手的新对话（直接输入就开一段新的），流式输出同时以气泡投到桌面。
// 消息流（顶端渐隐）/ 审批横幅 / 信息行；输入框已挪到中间桌面底部（App.vue 挂 Composer）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app.js'
import MessageItem from './MessageItem.vue'

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
  // 消息变高、或面板本身变矮（审批横幅/状态行/窗口改变）时，只要贴底开关开着就跟随到底
  if (messagesEl.value) resizeObserver.observe(messagesEl.value)
  if (scrollEl.value) resizeObserver.observe(scrollEl.value)
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

// 输入框已挪到中间桌面底部（App.vue），提交不经过本组件；
// 追加进来的是自己发的消息（user）时强制贴底——不管刚才滚到了哪里，都跟着回到底部。
// 助手回复的流式增长不强制（上滚读历史时不被拽下去，仍走 stickToBottom 开关）。
watch(allMessages, (next, prev) => {
  const from = prev?.length ?? 0
  if (next.length > from && next[from]?.message.role === 'user') {
    stickToBottom.value = true
    void scrollToBottom(true)
  }
})

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
    <div ref="scrollEl" class="message-scroll" @scroll="onScroll">
      <div ref="messagesEl" class="messages">
        <MessageItem v-for="entry in messages" :key="entry.message.id" :message="entry.message" />
        <div v-if="!conversationID" class="hint">
          {{ store.connected ? '直接说话，和助手开一段新对话' : '先连上机器' }}
        </div>
      </div>
    </div>

    <!-- 审批横幅 / 信息行挪到底部（消息流顶端直通视频中点、渐隐，顶部不再压文字） -->
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

    <header class="head">
      <span class="head-title">助手</span>
      <!-- 没选会话时也占位显示「新对话」：默认态就是和助手的新对话 -->
      <span class="session-name" :title="summary?.title">{{ conversationID ? summary?.title || '（无标题）' : '新对话' }}</span>
      <span v-if="statusLine" class="status-line">{{ statusLine }}</span>
      <span class="spacer" />
      <button v-if="runtime?.generating" class="stop-btn" @click="store.stopRunner(conversationID)">停止</button>
    </header>
  </section>
</template>

<style scoped>
.assistant-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  /* 面板宽度作容器查询尺寸：面板窄时输入框等子组件按容器宽自适应（视口媒体查询在这里不生效） */
  container-type: inline-size;
  /* 常驻元素融在桌面上：无卡片壳（透明、无边框、无阴影） */
  background: transparent;
  border: none;
}

/* 信息行贴在输入框上方（原来在顶部，现在顶部让给视频渐隐） */
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px 0;
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
  border-top: 1px solid var(--warn);
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
  padding: 6px 8px 12px;
  /* 顶端渐隐：向上滚进视频区的消息淡出，视频从聊天底下透出来 */
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 96px);
  mask-image: linear-gradient(to bottom, transparent 0, #000 96px);
}

.messages {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* 消息少时贴底（锚在输入框上方），多时正常滚动 */
  min-height: 100%;
  justify-content: flex-end;
}

.hint {
  padding: 10px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}
</style>
