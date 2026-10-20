<script setup lang="ts">
// 机器人聊天（M1.5）：登录后和 Friday bot 对话、语音通话、一键连机器。
// 登录（二维码）不在这里——登录页（LoginView）负责：未登录时这里只给一个「去扫码登录」的引导。
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()
const activeBot = ref(0)
const draft = ref('')
const scroller = ref<HTMLDivElement | null>(null)

const state = computed(() => store.schat)
const bots = computed(() => state.value.bots)
const messages = computed(() => state.value.messages[activeBot.value] ?? [])
const canSend = computed(() => state.value.phase === 'online' && activeBot.value > 0 && draft.value.trim().length > 0)

/** 已经连成机器人的 bot（work:<id>）→ 它的连接状态：已连的不显示 ⚡，显示状态，避免和机器列表重复、像没连过 */
const machineByBot = computed(() => {
  const map = new Map<number, { state: string; name: string }>()
  for (const machine of store.machines) {
    if (machine.targetKind !== 'work') continue
    const id = Number.parseInt(machine.targetText.slice(5), 10)
    if (Number.isInteger(id)) map.set(id, { state: machine.state, name: machine.name })
  }
  return map
})
const linkText: Record<string, string> = {
  ready: '已连接',
  connecting: '连接中',
  failed: '连接失败',
  versionMismatch: '版本不匹配',
  disconnected: '已断开'
}

/** 一键连上这台机器（0.3）：WebRTC 工作通道，不输任何地址/口令 */
async function connectWork(botID: number): Promise<void> {
  workError.value = ''
  try {
    await store.connectWork(botID)
    workResult.value = '已连上，语音 / 视频 / 数据都走这条 WebRTC 通道'
  } catch (err) {
    workError.value = err instanceof Error ? err.message : String(err)
  }
}

const workResult = ref('')
const workError = ref('')
const statusText = computed(() => {
  switch (state.value.phase) {
    case 'idle':
      return state.value.status || '未登录'
    case 'logging-in':
      return '等手机确认'
    case 'online':
      return `已登录（用户 ${state.value.userId}）`
    case 'error':
      return state.value.status || '出错'
    default:
      return ''
  }
})

// 自动选中第一个机器人
watch(
  bots,
  (list) => {
    if (!activeBot.value && list.length > 0) activeBot.value = list[0]!.id
  },
  { immediate: true }
)

watch(
  () => messages.value.length,
  () => {
    void nextTick(() => {
      const element = scroller.value
      if (element) element.scrollTop = element.scrollHeight
    })
  }
)

async function send(): Promise<void> {
  if (!canSend.value) return
  const text = draft.value.trim()
  draft.value = ''
  try {
    await store.schatSend(activeBot.value, text)
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  }
}

onMounted(() => {
  if (state.value.phase === 'idle') void store.schatRefresh()
})
</script>

<template>
  <div class="schat">
    <div class="head">
      <span class="title">机器人聊天</span>
      <span class="phase" :class="state.phase">{{ statusText }}</span>
      <button v-if="state.phase === 'online' || state.phase === 'error'" class="small-btn" @click="store.schatDisconnect()">
        退出登录
      </button>
    </div>

    <div v-if="state.error" class="error">{{ state.error }}</div>
    <div v-if="store.connectingWork" class="work-ok">正在通过聊天让那台机器配对…（几秒）</div>
    <div v-if="workResult" class="work-ok">{{ workResult }}</div>
    <div v-if="workError" class="error">{{ workError }}</div>

    <!-- 未登录：登录在登录页（二维码），这里只给引导 -->
    <div v-if="state.phase !== 'online'" class="not-logged-in" data-testid="schat-need-login">
      <div class="nl-icon">⚡</div>
      <div class="nl-text">
        {{ state.phase === 'logging-in' ? '正在登录，等手机确认…' : '还没登录' }}
      </div>
      <p class="nl-hint">用手机 Secret-Chat 扫二维码登录后，就能在这里和机器人对话、一键连机器。</p>
      <button v-if="state.phase !== 'logging-in'" class="btn primary" @click="store.openLogin()">去扫码登录</button>
    </div>

    <!-- 已登录：机器人列表 + 对话 -->
    <div v-if="state.phase === 'online'" class="online">
      <div class="bots">
        <div class="bots-head">机器人</div>
        <button
          v-for="bot in bots"
          :key="bot.id"
          class="bot"
          :class="{ active: activeBot === bot.id }"
          :data-bot-id="bot.id"
          @click="activeBot = bot.id"
        >
          <span class="bot-name">{{ bot.name }}</span>
          <span class="bot-actions">
            <span
              v-if="bot.botCalls"
              class="bot-call"
              title="语音通话"
              @click.stop="store.callDial(bot.id, 'audio')"
            >📞</span>
            <span
              v-if="bot.botCalls"
              class="bot-call"
              title="视频通话（右下角挂件里看画面）"
              @click.stop="store.callDial(bot.id, 'video')"
            >📹</span>
          </span>
          <span
            v-if="machineByBot.has(bot.id)"
            class="bot-linked"
            :class="machineByBot.get(bot.id)?.state"
            title="这台机器已在「机器与会话」里，去那里管理连接"
          >{{ linkText[machineByBot.get(bot.id)?.state ?? ''] ?? machineByBot.get(bot.id)?.state }}</span>
          <span
            v-else
            class="bot-work"
            title="连上这台机器（WebRTC 工作通道）"
            @click.stop="connectWork(bot.id)"
          >⚡</span>
          <span v-if="bot.botCalls" class="bot-tag">通话</span>
        </button>
        <div v-if="bots.length === 0" class="empty-tip">
          好友里还没有机器人。先在手机上把这个 Friday 机器人加成好友，
          <button class="link-btn" @click="store.schatRefreshBots()">刷新一下</button>。
        </div>
      </div>

      <div class="chat">
        <div ref="scroller" class="chat-scroll">
          <div v-for="message in messages" :key="message.id" class="msg" :class="{ mine: message.mine }">
            <div class="bubble" :class="{ failed: message.failed }">
              {{ message.content }}
              <span v-if="message.streaming" class="stream">…</span>
              <span v-if="message.failed" class="fail-note">{{ message.failed }}</span>
            </div>
          </div>
          <div v-if="messages.length === 0" class="empty-tip">
            选一个机器人，说句话试试。它的回复会支持流式显示。
          </div>
        </div>
        <div class="composer">
          <textarea
            v-model="draft"
            rows="2"
            placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
            @keydown.enter.exact.prevent="send"
          />
          <button class="btn primary" :disabled="!canSend" @click="send">发送</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.schat {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  font-size: 12.5px;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.title {
  font-weight: 600;
}

.phase {
  color: var(--text-3);
  font-size: 11.5px;
  flex: 1;
}

.phase.online {
  color: var(--ok);
}

.phase.error {
  color: var(--fail);
}

.small-btn {
  font-size: 12px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text-2);
}

.small-btn:hover {
  color: var(--text);
}

.error {
  padding: 8px 12px;
  color: var(--fail);
  border-bottom: 1px solid var(--border);
}

/* 未登录引导 */
.not-logged-in {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 20px;
}

.nl-icon {
  font-size: 30px;
  opacity: 0.8;
}

.nl-text {
  font-size: 14px;
  color: var(--text);
}

.nl-hint {
  margin: 0 0 6px;
  max-width: 300px;
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.7;
}

.online {
  flex: 1;
  min-height: 0;
  display: flex;
}

.bots {
  flex: 0 0 168px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  padding: 8px 6px;
}

.bots-head {
  color: var(--text-3);
  font-size: 11.5px;
  padding: 2px 6px 6px;
}

.bot {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  padding: 6px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-size: 12.5px;
}

.bot:hover {
  background: var(--hover);
}

.bot.active {
  background: var(--accent-weak);
}

.bot-call {
  font-size: 12px;
  cursor: pointer;
  opacity: 0.75;
}

.bot-call:hover {
  opacity: 1;
}

.bot-work {
  font-size: 12px;
  cursor: pointer;
  opacity: 0.8;
}

/* 已连成机器人的 bot：状态小签（和机器列表同一份状态，不再是「可连接」的样子） */
.bot-linked {
  font-size: 10.5px;
  opacity: 0.85;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
}
.bot-linked.ready { color: var(--ok, #7ee787); border-color: color-mix(in srgb, var(--ok, #7ee787) 45%, transparent); }
.bot-linked.connecting { color: var(--warn, #e3b341); }
.bot-linked.failed,
.bot-linked.versionMismatch { color: var(--danger, #ff8a80); }

.work-ok {
  padding: 8px 14px;
  color: var(--ok);
  font-size: 12.5px;
  border-bottom: 1px solid var(--border);
}

.bot-work:hover {
  opacity: 1;
}

.bot-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-tag {
  font-size: 10.5px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--chip);
  color: var(--text-2);
}

.chat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.msg {
  display: flex;
}

.msg.mine {
  justify-content: flex-end;
}

.bubble {
  max-width: 78%;
  padding: 7px 10px;
  border-radius: 10px;
  background: var(--panel-2);
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg.mine .bubble {
  background: var(--accent-weak);
}

.bubble.failed {
  background: rgba(220, 38, 38, 0.1);
  border: 1px solid rgba(220, 38, 38, 0.35);
}

.fail-note {
  display: block;
  margin-top: 4px;
  color: var(--fail);
  font-size: 11px;
}

.stream {
  color: var(--run);
}

.composer {
  flex: none;
  display: flex;
  gap: 8px;
  padding: 8px 12px 12px;
  border-top: 1px solid var(--border);
}

.composer textarea {
  flex: 1;
  resize: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 9px;
  background: var(--panel-2);
  color: var(--text);
  font-family: inherit;
  font-size: 12.5px;
  outline: none;
}

.composer textarea:focus {
  border-color: var(--accent);
}

.empty-tip {
  color: var(--text-3);
  padding: 12px 6px;
  line-height: 1.7;
}

.link-btn {
  border: none;
  background: none;
  color: var(--accent);
  cursor: pointer;
  font-size: inherit;
  padding: 0;
}

.link-btn:hover {
  text-decoration: underline;
}

/* 贾维斯界面：聊天窗头部等宽化（弹窗玻璃、输入、按钮由全局 jarvis.css 覆盖） */
[data-theme='jarvis'] .head {
  border-bottom-color: rgba(34, 211, 238, 0.25);
}

[data-theme='jarvis'] .title {
  font-family: var(--font-hud);
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--accent);
  opacity: 0.85;
}
</style>
