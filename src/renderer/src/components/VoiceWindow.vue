<script setup lang="ts">
// 语音窗口（M3-A，方案 §6.1）：
// 按住说话 → MediaRecorder 录一段（webm/opus）→ 主进程落盘 → file.upload 到远端
// → assistant.say {text:"", attachments:[路径], source:"voice"} → assistant.entry 流式回复
// → speechSynthesis 逐句朗读。识别/理解都在远端（客户端不做语音识别）。
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { AssistantEntry } from '../../../protocol/rpc/protocol.js'
import { useAppStore } from '../stores/app.js'
import RealtimeVoice from './RealtimeVoice.vue'

const store = useAppStore()

const recording = ref(false)
const busy = ref(false)
const error = ref('')
const clips = ref<Array<{ id: string; at: string; text: string; reply: string; streaming: boolean }>>([])

let recorder: MediaRecorder | null = null
let chunks: BlobPart[] = []
let stream: MediaStream | null = null

const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

/** 订阅助手日志；新回复进来就朗读（M3-A 的播报） */
async function subscribeAssistant(): Promise<void> {
  if (store.assistantSubscribed || !store.currentMachine) return
  try {
    const result = (await store.rpc(store.currentMachine, 'assistant.subscribe', { count: 30 })) as {
      entries?: AssistantEntry[]
      state?: { enabled?: boolean }
    }
    store.assistantEntries = result.entries ?? []
    store.assistantEnabled = result.state?.enabled ?? false
    store.assistantSubscribed = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function speak(text: string): void {
  store.speakEntry({ id: `local-${Date.now()}`, at: new Date().toISOString(), kind: 'assistant', text })
}

function stopSpeaking(): void {
  store.stopSpeaking()
}

async function startRecording(): Promise<void> {
  if (recording.value || busy.value) return
  error.value = ''
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    chunks = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.start()
    recording.value = true
  } catch (e) {
    error.value = `打不开麦克风：${e instanceof Error ? e.message : String(e)}`
    releaseStream()
  }
}

function releaseStream(): void {
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
}

async function stopRecording(): Promise<void> {
  const current = recorder
  if (!current || !recording.value) return
  recording.value = false
  const done = new Promise<Blob>((resolve) => {
    current.onstop = () => resolve(new Blob(chunks, { type: current.mimeType || 'audio/webm' }))
  })
  current.stop()
  const blob = await done
  recorder = null
  releaseStream()
  if (blob.size === 0) {
    error.value = '这段没录到声音'
    return
  }
  await sendClip(blob)
}

/** 录音 → 上传 → assistant.say（source: voice） */
async function sendClip(blob: Blob): Promise<void> {
  if (!store.currentMachine) return
  busy.value = true
  try {
    const bytes = await blob.arrayBuffer()
    const picked = await window.fridayBridge.saveVoiceClip(bytes, blob.type)
    if (!picked) throw new Error('录音保存失败')
    const remotePath = await store.uploadFile(picked.handle)
    const result = (await store.rpc(store.currentMachine, 'assistant.say', {
      text: '',
      source: 'voice',
      attachments: [remotePath]
    })) as { entry?: AssistantEntry }
    clips.value.unshift({
      id: result.entry?.id ?? `local-${Date.now()}`,
      at: new Date().toLocaleTimeString(),
      text: '（语音消息）',
      reply: '',
      streaming: true
    })
    await subscribeAssistant()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

/** 读一条助手回复文本（去掉内部标记） */
function replyText(entry: AssistantEntry): string {
  return entry.data?.silent ? '' : entry.text
}

/** 助手日志（订阅后进来的新条目在模板里显示；回复的朗读由 store 处理） */
function onKeyDown(event: KeyboardEvent): void {
  if (event.code === 'Space' && !event.repeat) {
    event.preventDefault()
    void startRecording()
  }
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.code === 'Space') {
    event.preventDefault()
    void stopRecording()
  }
}

onMounted(() => {
  void subscribeAssistant()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  stopSpeaking()
  if (recorder && recording.value) {
    recorder.stop()
    recorder = null
  }
  releaseStream()
})
</script>

<template>
  <div class="voice">
    <div v-if="!supported" class="notice">
      这台电脑的页面环境不支持录音（navigator.mediaDevices 不可用）
    </div>

    <!-- v2.34 实时对话（voice.*）：听着说、边说边念、可以插话 -->
    <RealtimeVoice v-if="supported" />

    <div class="voice-main">
      <button
        class="mic"
        :class="{ recording, busy }"
        :disabled="busy || !store.connected"
        @mousedown.prevent="startRecording"
        @mouseup.prevent="stopRecording"
        @mouseleave="recording && stopRecording()"
      >
        <span class="mic-icon">{{ busy ? '⏳' : recording ? '●' : '🎙' }}</span>
        <span class="mic-text">
          {{ busy ? '上传中…' : recording ? '松开发送' : '按住说话' }}
        </span>
      </button>
      <div class="hint">
        识别和理解在远端 Friday 上做；回复会用本机语音念出来。
        <template v-if="!store.connected">（先连上一台机器）</template>
      </div>
      <button v-if="store.speakingEntryID" class="small-btn" @click="stopSpeaking">停止朗读</button>
    </div>

    <div v-if="!store.assistantEnabled" class="warn">
      这台机器的助手关着：语音消息只会记进日志，不会回复。需要在远端 Friday 的设置里启动助手。
    </div>
    <div v-if="error" class="error">{{ error }}</div>

    <div class="entries">
      <div v-if="!store.assistantEntries.length" class="empty">
        还没有助手日志。按住上面的麦克风说一句话试试。
      </div>
      <div
        v-for="entry in [...store.assistantEntries].reverse().slice(0, 40)"
        :key="entry.id"
        class="entry"
        :class="entry.kind"
      >
        <span class="entry-kind">{{ entry.kind === 'user' ? '你' : entry.kind === 'assistant' ? 'Friday' : entry.kind }}</span>
        <span class="entry-text">{{ replyText(entry) || '（空）' }}</span>
        <span v-if="entry.streaming" class="entry-stream">正在说…</span>
        <button
          v-if="entry.kind === 'assistant' && replyText(entry)"
          class="speak-btn"
          title="朗读这条"
          @click="speak(replyText(entry))"
        >
          🔊
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.voice {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
}

.notice {
  padding: 16px;
  color: var(--text-2);
  font-size: 12.5px;
}

.voice-main {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px 16px 16px;
  border-bottom: 1px solid var(--border);
}

.mic {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 180px;
  justify-content: center;
  padding: 12px 22px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
  transition: transform 0.08s ease, background 0.15s ease;
  user-select: none;
}

.mic:hover:not(:disabled) {
  background: var(--hover);
}

.mic.recording {
  background: var(--fail);
  border-color: var(--fail);
  color: #fff;
  transform: scale(1.03);
}

.mic.busy {
  opacity: 0.7;
}

.mic:disabled {
  opacity: 0.5;
  cursor: default;
}

.mic-icon {
  font-size: 16px;
}

.hint {
  color: var(--text-3);
  font-size: 11.5px;
  text-align: center;
  line-height: 1.6;
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
  padding: 8px 14px;
  color: var(--fail);
  font-size: 12.5px;
  border-bottom: 1px solid var(--border);
}

.warn {
  padding: 8px 14px;
  color: var(--warn);
  font-size: 12px;
  line-height: 1.6;
  border-bottom: 1px solid var(--border);
}

.entries {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty {
  color: var(--text-3);
  font-size: 12.5px;
  padding: 12px 0;
}

.entry {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12.5px;
  line-height: 1.65;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--panel-2);
}

.entry.user {
  background: var(--accent-weak);
}

.entry-kind {
  flex: none;
  font-size: 11.5px;
  color: var(--text-2);
  min-width: 44px;
}

.entry-text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.entry-stream {
  flex: none;
  font-size: 11px;
  color: var(--run);
}

.speak-btn {
  flex: none;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
}
</style>
