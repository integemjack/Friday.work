<script setup lang="ts">
// 输入框（方案 §5.3）：发送、停止、附件（对话框 + 拖放，经主进程背书上传）
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'
import type { PickedFile } from '../lib/host.js'

const emit = defineEmits<{ submit: [text: string, attachments: Array<{ path: string; name: string }>] }>()

const store = useAppStore()
const props = defineProps<{ conversationId?: string }>()
const text = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)

// 「让 Friday 改」：文件卡片预填一条消息（方案 §5.5）
function onPrefill(event: Event): void {
  const detail = (event as CustomEvent<string>).detail
  if (typeof detail !== 'string') return
  text.value = detail
  void nextTick(() => {
    textarea.value?.focus()
    textarea.value?.setSelectionRange(detail.length, detail.length)
  })
}
onMounted(() => window.addEventListener('friday-prefill', onPrefill as EventListener))
onBeforeUnmount(() => window.removeEventListener('friday-prefill', onPrefill as EventListener))
const busy = ref(false)
const attachments = ref<Array<{ handle: string; name: string; size: number }>>([])
const uploadError = ref('')

const sending = computed(() => {
  const id = props.conversationId
  const runtime = id ? store.details[id]?.runtime : store.runtime
  return runtime?.generating ?? false
})

function resize() {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
}

async function handleAttachments(picked: PickedFile[]) {
  for (const file of picked) {
    attachments.value.push(file)
  }
}

async function pick() {
  const picked = await window.fridayBridge.pickAttachments()
  await handleAttachments(picked)
}

function onDrop(event: DragEvent) {
  const files = [...(event.dataTransfer?.files ?? [])]
  if (files.length === 0) return
  event.preventDefault()
  for (const file of files) {
    void window.fridayBridge.registerDrop(file).then((picked) => {
      if (picked) attachments.value.push(picked)
    })
  }
}

async function send() {
  const value = text.value.trim()
  if ((!value && attachments.value.length === 0) || busy.value || sending.value) return
  busy.value = true
  uploadError.value = ''
  try {
    const uploaded: Array<{ path: string; name: string }> = []
    for (const attachment of attachments.value) {
      const path = await store.uploadFile(attachment.handle)
      uploaded.push({ path, name: attachment.name })
    }
    emit('submit', value, uploaded)
    text.value = ''
    attachments.value = []
    await nextTick(resize)
  } catch (error) {
    uploadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
}

function removeAttachment(index: number) {
  attachments.value.splice(index, 1)
}

function stop() {
  void store.stopRunner()
}
</script>

<template>
  <div class="composer" @drop.prevent="onDrop" @dragover.prevent>
    <div v-if="attachments.length > 0" class="attachments">
      <div v-for="(attachment, index) in attachments" :key="attachment.handle" class="attachment">
        <span class="att-name">{{ attachment.name }}</span>
        <span class="att-size">{{ (attachment.size / 1024).toFixed(0) }} KB</span>
        <button class="att-remove" @click="removeAttachment(index)">×</button>
      </div>
    </div>

    <textarea
      ref="textarea"
      v-model="text"
      rows="1"
      placeholder="发给这台机器上的 Friday……（Enter 发送，Shift+Enter 换行）"
      @input="resize"
      @keydown="onKeydown"
    />

    <div class="row">
      <button class="btn" title="添加附件" @click="pick">📎</button>
      <span v-if="uploadError" class="error">{{ uploadError }}</span>
      <span class="spacer" />
      <button v-if="sending" class="btn warn" @click="stop">■ 停止</button>
      <button
        class="btn primary"
        :disabled="busy || (!text.trim() && attachments.length === 0)"
        @click="send"
      >
        {{ busy ? '上传中…' : '发送' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer {
  border-top: 1px solid var(--border);
  background: var(--panel);
  padding: 8px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.attachment {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 3px 8px;
  font-size: 12.5px;
  background: var(--panel-2);
}

.att-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.att-size {
  color: var(--text-3);
  font-size: 11.5px;
}

.att-remove {
  color: var(--text-3);
  font-size: 14px;
  line-height: 1;
}

.att-remove:hover {
  color: var(--fail);
}

textarea {
  width: 100%;
  resize: none;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 12px;
  background: var(--panel-2);
  color: var(--text);
  outline: none;
  line-height: 1.6;
  min-height: 38px;
}

textarea:focus {
  border-color: var(--accent);
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn.warn {
  color: var(--warn);
  border-color: var(--warn);
}

.error {
  color: var(--fail);
  font-size: 12.5px;
}

.spacer {
  flex: 1;
}
</style>