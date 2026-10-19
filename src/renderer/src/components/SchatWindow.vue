<script setup lang="ts">
// 扫码一键连（M1.5）：手机 Secret-Chat 扫二维码确认 → 拿到凭据 → 连 schat-ws → 列出机器人 → 和 Friday bot 对话。
// 载波是 SCSH:1:login:<token>（Secret-Chat docs/qr_login_plan.md），手机扫标准二维码即可。
import QRCode from 'qrcode'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()
const serverInput = ref(store.schat.server || 'https://47.100.98.3:2012')
const deviceName = ref('')
const svg = ref('')
const activeBot = ref(0)
const draft = ref('')
const scroller = ref<HTMLDivElement | null>(null)

const state = computed(() => store.schat)
const bots = computed(() => state.value.bots)
const messages = computed(() => state.value.messages[activeBot.value] ?? [])
const canSend = computed(() => state.value.phase === 'online' && activeBot.value > 0 && draft.value.trim().length > 0)

/** 一键连上这台机器（方案 §4.0 ③）：直接开一个工作连接，不输任何地址/口令 */
async function connectWork(botID: number): Promise<void> {
  workError.value = ''
  try {
    const url = await store.connectWork(botID)
    workResult.value = url ? `已连上 ${url}（设备默认不受信：想用终端/浏览器/文件，在聊天里发 /trust <设备id> on）` : '已连上'
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

async function renderQr(): Promise<void> {
  if (!state.value.qrPayload) {
    svg.value = ''
    return
  }
  svg.value = await QRCode.toString(state.value.qrPayload, { type: 'svg', margin: 1, width: 220 })
}

watch(() => state.value.qrPayload, () => void renderQr(), { immediate: true })

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

async function login(): Promise<void> {
  await store.schatLogin(serverInput.value, deviceName.value)
}

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
      <span class="title">Secret-Chat 一键连</span>
      <span class="phase" :class="state.phase">{{ statusText }}</span>
      <button v-if="state.phase === 'online' || state.phase === 'error'" class="small-btn" @click="store.schatDisconnect()">
        退出登录
      </button>
    </div>

    <div v-if="state.error" class="error">{{ state.error }}</div>
    <div v-if="store.connectingWork" class="work-ok">正在通过聊天让那台机器配对…（几秒）</div>
    <div v-if="workResult" class="work-ok">{{ workResult }}</div>
    <div v-if="workError" class="error">{{ workError }}</div>

    <!-- 未登录：填服务器、生成二维码 -->
    <div v-if="state.phase === 'idle' || (state.phase === 'error' && !state.qrPayload)" class="setup">
      <label>
        聊天服务器
        <input v-model="serverInput" placeholder="https://47.100.98.3:2012" @keydown.enter="login" />
      </label>
      <label>
        这台设备的名字（手机上显示）
        <input v-model="deviceName" placeholder="比如「办公室的 Windows」" @keydown.enter="login" />
      </label>
      <button class="btn primary" @click="login">
        {{ state.phase === 'error' ? '重新生成二维码' : '生成登录二维码' }}
      </button>
      <p class="hint">
        用手机 Secret-Chat 扫一扫，在手机上确认后这台电脑就登上了；之后连机器人不需要再输密码。
      </p>
    </div>

    <!-- 登录中：二维码 + 状态 -->
    <div v-if="state.qrPayload" class="qr-area">
      <div class="qr" v-html="svg" />
      <div class="qr-side">
        <div class="qr-title">用手机 Secret-Chat 扫一扫</div>
        <div class="qr-status">{{ state.status || '等着你扫码…' }}</div>
        <div class="qr-payload">
          <code>{{ state.qrPayload }}</code>
        </div>
        <button class="small-btn" @click="login">换一个码</button>
      </div>
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
          <span v-if="bot.botCalls" class="bot-call" title="语音通话" @click.stop="store.callDial(bot.id, 'audio')">📞</span>
          <span class="bot-work" title="一键连上这台机器（不用输地址/口令）" @click.stop="connectWork(bot.id)">⚡</span>
          <span v-if="bot.botCalls" class="bot-tag">通话</span>
        </button>
        <div v-if="bots.length === 0" class="empty-tip">好友里还没有机器人。先在手机上把这个 Friday 机器人加成好友。</div>
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

.setup {
  padding: 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--text-2);
}

input {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--panel-2);
  color: var(--text);
  outline: none;
}

input:focus {
  border-color: var(--accent);
}

.hint {
  color: var(--text-3);
  font-size: 11.5px;
  line-height: 1.6;
  margin: 0;
}

.qr-area {
  display: flex;
  gap: 16px;
  padding: 16px 14px;
  border-bottom: 1px solid var(--border);
}

.qr {
  flex: none;
  background: #fff;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
}

.qr :deep(svg) {
  display: block;
}

.qr-side {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.qr-title {
  font-weight: 600;
}

.qr-status {
  color: var(--warn);
}

.qr-payload code {
  display: block;
  font-size: 10.5px;
  color: var(--text-3);
  word-break: break-all;
  background: var(--code-bg);
  border-radius: 6px;
  padding: 6px;
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
</style>
