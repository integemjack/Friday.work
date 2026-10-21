<script setup lang="ts">
// 右栏下半段常驻的「与助手聊天」面板：叠在视频上面，顶端顶到视频中点、向上渐隐。
// 默认作用在当前选中的会话上（左侧会话列表切换）；「和助手说」开着时改在所连机器的助手日志上
// （assistant.say 发、assistant.entry 流式回，REMOTE.md §6），此时不碰会话。
// 消息流（顶端渐隐）/ 审批横幅 / 信息行；输入框已挪到中间桌面底部（App.vue 挂 Composer）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app.js'
import type { ChatMessage } from '../../../protocol/rpc/protocol.js'
import MessageItem from './MessageItem.vue'
import AskPanel from './AskPanel.vue'
import {
  replySpeakEnabled,
  speakText,
  stopSpeaking,
  textBlocksToSpeech,
  ttsDetail,
  ttsPhase
} from '../lib/speechOutput.js'

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

// MARK: 和助手说（助手模式）：面板改显所连机器的助手日志（JournalEntry → MessageItem 认的形状）
const assistantChat = computed(() => store.assistantChat)
/** 助手名字（config.name）或引擎名，都没有就「这台机器的助手」 */
const assistantName = computed(() => {
  const config = store.assistantState?.config as { name?: string } | undefined
  return config?.name || store.assistantState?.brainEngineTitle || '这台机器的助手'
})
/** user 靠右，其余（assistant/receipt/tool/notice）都靠左；silent 的不显示；
 *  流式同一条反复改（同 id），打断的标一下 */
const assistantMessages = computed(() =>
  store.assistantEntries
    .filter((entry) => !(entry.data?.silent))
    .map((entry) => ({
      message: {
        id: entry.id,
        role: entry.kind === 'user' ? 'user' : 'assistant',
        createdAt: entry.at,
        blocks: entry.text ? [{ id: entry.id, kind: { text: entry.text } }] : [],
        error: entry.data?.error ? '出错了' : undefined,
        notice: entry.interrupted ? '被打断' : undefined,
        agentName: entry.source && entry.kind === 'user' && entry.source !== 'desktop' ? entry.source : undefined
      } as ChatMessage
    }))
)
/** 面板实际显示的消息流：助手模式给助手日志，否则给当前会话 */
const shownMessages = computed(() => (assistantChat.value ? assistantMessages.value : messages.value))

// 排队 / 待插入的消息（runtime.queue）：像用户消息一样靠右、虚线描边的淡色气泡，可撤回（qt QueuedBubbles）
const queued = computed(() => runtime.value?.queue ?? [])
const queuePaused = computed(() => runtime.value?.queuePaused ?? false)

/** 服务端给的 attachments 是路径；显示用文件名 */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

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
  stopSpeaking()
})

/** 滚动区顶部有没有内容被裁（有才显示雾化窗帘；没有时窗帘隐藏，视频从顶部完整透出） */
const scrolledFromTop = ref(false)
function onScroll() {
  const el = scrollEl.value
  if (!el) return
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  scrolledFromTop.value = el.scrollTop > 2
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

// 助手模式：新的日志条（自己说的 user）强制贴底，流式增长跟随滚动（同会话那套规则）。
// deep 必须开：store 的 mergeAssistantEntry 用 splice 原地变异 assistantEntries，
// getter watch 只 track 数组引用、引用不变就永不触发（播报不响的根因同此）
watch(
  () => store.assistantEntries,
  (next, prev) => {
    const from = prev?.length ?? 0
    if (next.length > from && next[from]?.kind === 'user') {
      stickToBottom.value = true
      void scrollToBottom(true)
    } else {
      void scrollToBottom()
    }
  },
  { deep: true }
)
// 进/出助手模式：重置窗口化、回到底部
watch(assistantChat, () => {
  stickToBottom.value = true
  void scrollToBottom(true)
})

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

// 新排队一条（插入内容）也强制贴底：气泡落在消息流末尾，跟着回到底部才能看到它
watch(queued, (next, prev) => {
  if (next.length > (prev?.length ?? 0)) {
    stickToBottom.value = true
    void scrollToBottom(true)
  }
})

// MARK: 回复语音播报（本地 kokoro TTS，开关在设置 › 语音播报）：
// 助手回复「完成」的那一刻朗读文本部分（代码块/链接等不念）；自己发言时先停掉正在播的，
// 好比真人不会抢话。两种模式的完成信号：
//   - 助手模式：日志条 streaming true → false（或新条目直接落地非流式）；
//   - 会话模式：所有会话的 assistant 消息 finishedAt 出现（后台会话出结果也播，不只当前会话）。
// 打断的 / 出错的 / 静默的不播；会话首次进入监听时已完成的历史一律不补播
//（切会话/重连加载快照不念旧账）。
const seenEntryStreaming = new Map<string, { streaming?: boolean; interrupted?: boolean; spoken?: boolean }>()
// deep 必须开：store 的 mergeAssistantEntry 用 splice 原地变异 assistantEntries（同 id 更新、
// 新条目插入都不换数组引用），getter watch 只 track 引用、不开 deep 就永远等不到
// 「streaming → 完成」的边沿——气泡照常渲染（渲染函数自己 track 了内容）但播报从不触发。
watch(
  () => store.assistantEntries,
  (entries, prev) => {
    const initial = prev === undefined
    for (const entry of entries) {
      if (entry.kind === 'user') {
        if (entry.data?.silent) continue
        // 记入已见再判边沿：deep 之下每帧都会重跑这里，不记的话每帧都 stopSpeaking，
        // 会把正在播的回复挦掉（打断只能发生在「新出现自己发言」那一帧）
        const first = !seenEntryStreaming.has(entry.id)
        seenEntryStreaming.set(entry.id, {})
        if (!initial && first) stopSpeaking() // 自己发言：打断播报
        continue
      }
      if (entry.kind !== 'assistant') continue
      const mark = seenEntryStreaming.get(entry.id)
      const done = !entry.streaming
      const speakable =
        !entry.data?.silent && !entry.interrupted && !entry.data?.error && entry.text.trim().length > 0
      if (!initial && done && !mark?.spoken && (mark === undefined || mark.streaming) && speakable) {
        seenEntryStreaming.set(entry.id, { streaming: entry.streaming, spoken: true })
        if (replySpeakEnabled.value) void speakText(entry.text)
        continue
      }
      seenEntryStreaming.set(entry.id, { streaming: entry.streaming, spoken: mark?.spoken })
    }
  },
  { immediate: true, deep: true }
)

// 会话模式：监听所有会话的 assistant 完成态——后台会话出结果也播，不只当前会话；
// 自己在当前会话发言时打断。getter 只产出完成态快照（role/finishedAt/标记 + 当前会话的
// user 消息），不读 blocks：流式内容增长不触发回调，只有完成边沿、新消息、切会话才重跑，
// 不需要 deep 递归。会话首次进入监听时已完成的消息当历史不播；已在监听里的会话，
// 流式完成、整条落地完成都播。
const seenConversations = new Set<string>()
const seenMessageFinish = new Map<string, string | undefined>()
watch(
  () => {
    const snapshot: Array<{
      key: string
      conv?: string
      msgID?: string
      user?: boolean
      finishedAt?: string
      stoppedByUser?: boolean
      error?: string
      notice?: string
    }> = []
    for (const conv of Object.keys(store.details)) {
      const current = conv === conversationID.value
      for (const { message } of store.details[conv]?.messages ?? []) {
        if (message.role === 'user') {
          if (current) snapshot.push({ key: `u:${conv}:${message.id}`, user: true })
          continue
        }
        if (message.role !== 'assistant') continue
        snapshot.push({
          key: `a:${conv}:${message.id}`,
          conv,
          msgID: message.id,
          finishedAt: message.finishedAt,
          stoppedByUser: message.stoppedByUser,
          error: message.error,
          notice: message.notice
        })
      }
    }
    return snapshot
  },
  (list, prev) => {
    const initial = prev === undefined
    // 先统一登记本帧新出现的会话：其中已完成的消息全部当历史不播。
    // （不能在遍历中边遇边登记——那样只有新会话的第一条享受到豁免，后面的照播）
    const freshConvs = new Set<string>()
    for (const item of list) {
      if (item.conv !== undefined && !seenConversations.has(item.conv)) freshConvs.add(item.conv)
    }
    for (const conv of freshConvs) seenConversations.add(conv)
    for (const item of list) {
      if (item.user) {
        // 记入已见再判边沿：快照每帧重跑这里，不记的话每帧都 stopSpeaking，
        // 会把正在播的回复挦掉（打断只能发生在「新出现自己发言」那一帧）
        const first = !seenMessageFinish.has(item.key)
        seenMessageFinish.set(item.key, undefined)
        if (!initial && first) stopSpeaking() // 自己发言：打断播报
        continue
      }
      if (item.conv === undefined || item.msgID === undefined) continue
      // 本帧新登记会话里已完成的消息是历史，不播（否则切会话/重连会念旧账）；
      // 未完成的照常记录，它们之后完成时照播
      if (freshConvs.has(item.conv) && item.finishedAt) {
        seenMessageFinish.set(item.key, item.finishedAt)
        continue
      }
      const before = seenMessageFinish.get(item.key)
      const done = !!item.finishedAt
      const speakable = !item.stoppedByUser && !item.error && !item.notice
      if (!initial && done && !before && speakable && replySpeakEnabled.value) {
        const entry = store.details[item.conv]?.messages.find((candidate) => candidate.message.id === item.msgID)
        if (entry) void speakText(textBlocksToSpeech(entry.message.blocks))
      }
      seenMessageFinish.set(item.key, item.finishedAt)
    }
  },
  { immediate: true }
)

// 切会话/切换模式：窗口化的消息流变了，旧的完成边沿不重播，播报也停掉
watch([conversationID, assistantChat], () => {
  stopSpeaking()
})

/** 播报状态行文案（下载/解压/加载/播报中/出错）；叠加在常规状态后面 */
const ttsStatusLine = computed(() => {
  switch (ttsPhase.value) {
    case 'downloading':
      return ttsDetail.value || '语音模型下载中…（首次约 350MB）'
    case 'extracting':
      return '语音模型解压中…'
    case 'loading':
      return '语音模型加载中…'
    case 'speaking':
      return '播报中'
    case 'error':
      return `播报不可用：${ttsDetail.value || '出错'}`
    default:
      return ''
  }
})

const statusLine = computed(() => {
  let line = ''
  if (assistantChat.value) {
    if (store.assistantUnsupported) return '这台机器的 Friday 版本不带助手'
    if (store.assistantState === null) line = store.connected ? '正在拿助手日志…' : ''
    else if (store.assistantState.reacting) line = '正在回复…'
    else if (!store.assistantState.enabled) line = '助手关着：说的话只记日志、不会回'
  } else {
    const current = runtime.value
    if (current) {
      if (current.generating) line = current.queue.length > 0 ? `正在生成 · ${current.queue.length} 条待插入` : '正在生成…'
      else if (current.stopping) line = '正在停止…'
      else if (approvals.value.length > 0)
        line = approvals.value.some((item) => item.questions?.length) ? '等你回答' : '等待你确认'
      else if (current.queuePaused && current.queue.length > 0) line = '排队已暂停'
      else if (current.queue.length > 0) line = `${current.queue.length} 条消息排队`
    }
  }
  if (line) return line
  return ttsStatusLine.value
})
</script>

<template>
  <section class="assistant-chat" data-testid="assistant-chat">
    <div ref="scrollEl" class="message-scroll" @scroll="onScroll">
      <!-- 顶端雾化窗帘：内容滚入顶部 96px 时渐进模糊，替代旧的 scroller mask -->
      <div class="top-fade" :class="{ on: scrolledFromTop }" aria-hidden="true" />
      <div ref="messagesEl" class="messages">
        <MessageItem v-for="entry in shownMessages" :key="entry.message.id" :message="entry.message" />

        <!-- 排队 / 待插入的消息（qt QueuedBubbles）：靠右虚线气泡，随列表滚动，接在消息流末尾（会话模式才有） -->
        <div v-if="!assistantChat && queued.length > 0" class="queued">
          <div v-for="item in queued" :key="item.id" class="queued-item">
            <div v-if="item.attachments.length > 0" class="queued-atts" :title="item.attachments.join(', ')">
              📎 {{ item.attachments.map(baseName).join('、') }}
            </div>
            <div v-if="item.text" class="queued-bubble">{{ item.text }}</div>
            <button class="queued-remove" title="撤回这条，不交给智能体" @click="store.removeQueued(conversationID, item.id)">撤回</button>
          </div>
          <div class="queued-status" :class="{ paused: queuePaused }">
            <span>{{ queuePaused ? '排队已暂停' : '排队中 · 做完当前这一步就交给它' }}</span>
            <button v-if="queuePaused" class="queued-resume" @click="store.resumeQueue(conversationID)">发送</button>
          </div>
        </div>

        <div v-if="assistantChat ? assistantMessages.length === 0 : !conversationID" class="hint">
          {{
            assistantChat
              ? store.assistantUnsupported
                ? '这台机器的 Friday 版本不带助手'
                : store.connected
                  ? '直接说话，发给这台机器上的助手'
                  : '先连上机器'
              : store.connected
                ? '直接说话，和助手开一段新对话'
                : '先连上机器'
          }}
        </div>
      </div>
    </div>

    <!-- 审批横幅 / 信息行挪到底部（消息流顶端直通视频中点、渐隐，顶部不再压文字）；
         会话模式才有审批（助手日志里没有审批卡） -->
    <div v-if="!assistantChat && approvals.length > 0" class="approval-bar">
      <div
        v-for="approval in approvals"
        :key="approval.eventID"
        class="approval-item"
        :class="{ ask: !!approval.questions?.length }"
      >
        <template v-if="approval.questions?.length">
          <span class="approval-tool">{{ approval.title || '问你' }}</span>
          <AskPanel
            class="approval-ask"
            :questions="approval.questions"
            :answered="store.answeredAsks.has(approval.eventID)"
            @answer="(payload) => store.answerQuestion(approval.eventID, payload)"
            @skip="store.skipQuestion(approval.eventID)"
          />
        </template>
        <template v-else>
          <span class="approval-tool">{{ approval.title || approval.tool }}</span>
          <span class="approval-summary">{{ approval.summary }}</span>
          <div class="approval-actions">
            <button class="abtn" @click="store.resolveApproval(approval.eventID, false)">拒绝</button>
            <button class="abtn primary" @click="store.resolveApproval(approval.eventID, true)">批准</button>
          </div>
        </template>
      </div>
    </div>

    <header class="head">
      <span class="head-title">助手</span>
      <!-- 助手模式：显示助手名字；没选会话时也占位显示「新对话」：默认态就是和助手的新对话 -->
      <span class="session-name" :title="summary?.title">{{
        assistantChat ? assistantName : conversationID ? summary?.title || '（无标题）' : '新对话'
      }}</span>
      <span v-if="statusLine" class="status-line">{{ statusLine }}</span>
      <span class="spacer" />
      <button
        v-if="assistantChat"
        class="stop-btn"
        :disabled="!(store.assistantState?.reacting ?? false)"
        @click="store.assistantStop()"
      >
        停止
      </button>
      <button v-else-if="runtime?.generating" class="stop-btn" @click="store.stopRunner(conversationID)">停止</button>
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

.stop-btn:disabled {
  opacity: 0.35;
  cursor: default;
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

/* ask_user：问题面板整行展开（橙底白字，AskPanel 的变量在这给一套） */
.approval-item.ask {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  --ask-line: rgba(255, 255, 255, 0.55);
  --ask-accent: #fff;
  --ask-picked: rgba(255, 255, 255, 0.16);
}

.approval-ask {
  width: 100%;
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
  /* 顶端渐隐改用 .top-fade 雾化窗帘：原先的 scroller mask 是祖先级 backdrop root，
     会把消息里气泡的 backdrop-filter 困在滚动容器内（磨砂全失效，实测 blur 差 87→2） */
}

/* 顶端雾化窗帘：sticky 钉在滚动视口顶部、负 margin 不占流内空间；
   自带 blur + 自身 mask 渐显 → 顶部锐利、往下渐进模糊（自身 mask 不影响自身 backdrop 采样范围）。
   只在顶部真有内容被裁（scrollTop > 2）时显示，没有时视频从顶部完整透出 */
.top-fade {
  position: sticky;
  top: 0;
  z-index: 2;
  height: 96px;
  margin-bottom: -96px;
  pointer-events: none;
  display: none;
}

.top-fade.on {
  display: block;
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
  backdrop-filter: blur(18px) saturate(1.4);
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

/* 排队 / 待插入的消息（qt QueuedBubbles）：靠右、虚线描边的淡色气泡（正式用户气泡是实底） */
.queued {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.queued-item {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
}

.queued-atts {
  max-width: 90%;
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queued-bubble {
  max-width: 92%;
  padding: 7px 11px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
  color: var(--text-2);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent);
}

.queued-remove {
  border: none;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  padding: 0 2px;
  cursor: pointer;
}

.queued-remove:hover {
  color: var(--fail);
}

.queued-status {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
  font-size: 11px;
  color: var(--text-3);
}

.queued-status.paused {
  color: var(--warn);
}

.queued-resume {
  border: 1px solid var(--warn);
  background: transparent;
  color: var(--warn);
  font-size: 11px;
  padding: 1px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.queued-resume:hover {
  background: var(--warn);
  color: #fff;
}
</style>
