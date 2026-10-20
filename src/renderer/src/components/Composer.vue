<script setup lang="ts">
// 输入框（方案 §5.3，样式照 Friday 桌面端）：圆角卡片内嵌文本区，底行左侧附件、右侧圆形发送键；
// 生成中发送键变成停止。附件（对话框 + 拖放，经主进程背书上传）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'
import type { EngineView } from '../stores/app.js'
import type { PickedFile } from '../lib/host.js'

const emit = defineEmits<{ submit: [text: string, attachments: Array<{ path: string; name: string }>] }>()

const store = useAppStore()
const props = defineProps<{ conversationId?: string }>()
const text = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const focused = ref(false)

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

// MARK: 模型选择（方案 §5.3：runner.setEngine；照 Friday 输入框底行的模型选择器）
const modelOpen = ref(false)
const modelWrap = ref<HTMLDivElement | null>(null)
const switchError = ref('')

const availableEngines = computed<EngineView[]>(() => store.engines.filter((engine) => !engine.disabled))
const currentEngineID = computed(
  () => store.summaries.find((summary) => summary.id === props.conversationId)?.engineID ?? ''
)
const currentEngine = computed(() => availableEngines.value.find((engine) => engine.id === currentEngineID.value))
/** 没选过时显示新对话默认引擎的标题（REMOTE.md：engineID 空 = 跟随默认） */
const currentEngineTitle = computed(
  () =>
    currentEngine.value?.title ??
    availableEngines.value.find((engine) => engine.id === store.defaultEngineID)?.title ??
    '默认模型'
)

function toggleModelMenu() {
  modelOpen.value = !modelOpen.value
  if (!modelOpen.value) switchError.value = ''
}

async function chooseEngine(engine: EngineView) {
  modelOpen.value = false
  switchError.value = ''
  if (!props.conversationId || engine.id === currentEngineID.value) return
  try {
    await store.setEngine(props.conversationId, engine.id)
  } catch (error) {
    switchError.value = error instanceof Error ? error.message : String(error)
  }
}

function onDocClick(event: MouseEvent) {
  if (modelOpen.value && modelWrap.value && !modelWrap.value.contains(event.target as Node)) {
    modelOpen.value = false
  }
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

const sending = computed(() => {
  const id = props.conversationId
  const runtime = id ? store.details[id]?.runtime : store.runtime
  return runtime?.generating ?? false
})

const canSend = computed(() => Boolean(text.value.trim()) || attachments.value.length > 0)

function resize() {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`
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
    <div class="composer-card" :class="{ focused }">
      <!-- 附件 chips：卡片内、文本区上方 -->
      <div v-if="attachments.length > 0" class="attachments">
        <div v-for="(attachment, index) in attachments" :key="attachment.handle" class="attachment">
          <span class="att-name">{{ attachment.name }}</span>
          <span class="att-size">{{ (attachment.size / 1024).toFixed(0) }} KB</span>
          <button class="att-remove" title="移除" @click="removeAttachment(index)">×</button>
        </div>
      </div>

      <textarea
        ref="textarea"
        v-model="text"
        rows="1"
        placeholder="有什么可以帮你？"
        @input="resize"
        @keydown="onKeydown"
        @focus="focused = true"
        @blur="focused = false"
      />

      <div class="row">
        <button class="icon-btn" title="添加附件" @click="pick">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>

        <!-- 模型选择（Friday 输入框底行的模型选择器） -->
        <div ref="modelWrap" class="model-wrap">
          <button
            class="model-chip"
            :class="{ open: modelOpen }"
            :title="switchError || `当前模型：${currentEngineTitle}`"
            @click="toggleModelMenu"
          >
            <span class="model-name">{{ currentEngineTitle }}</span>
            <span class="model-caret">▾</span>
          </button>
          <div v-if="modelOpen" class="model-menu">
            <div v-if="availableEngines.length === 0" class="model-empty">这台机器没有可用引擎</div>
            <button
              v-for="engine in availableEngines"
              :key="engine.id"
              class="model-item"
              :class="{ current: engine.id === currentEngineID }"
              :title="engine.model"
              @click="chooseEngine(engine)"
            >
              <span class="model-item-main">
                <span class="model-item-title">{{ engine.title }}</span>
                <span v-if="engine.model && engine.model !== engine.title" class="model-item-model">{{ engine.model }}</span>
              </span>
              <span v-if="engine.id === currentEngineID" class="model-check">✓</span>
            </button>
          </div>
        </div>

        <span v-if="switchError" class="error">{{ switchError }}</span>
        <span v-else-if="uploadError" class="error">{{ uploadError }}</span>
        <span class="hint">Enter 发送 · Shift+Enter 换行</span>
        <span class="spacer" />
        <button v-if="sending" class="round-btn stop" title="停止生成" @click="stop">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <rect x="5" y="5" width="14" height="14" rx="2.5" />
          </svg>
        </button>
        <button
          v-else
          class="round-btn send"
          title="发送"
          :disabled="busy || !canSend"
          @click="send"
        >
          <svg v-if="!busy" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 19V5" />
            <path d="M5 12l7-7 7 7" />
          </svg>
          <span v-else class="busy-dot" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer {
  flex: none;
  padding: 6px 10px 9px;
  background: var(--panel);
}

.composer-card {
  max-width: 760px;
  margin: 0 auto;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--panel-2);
  padding: 3px 7px 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  transition: border-color 0.15s, box-shadow 0.15s;
}

/* 贾维斯界面：输入卡和背景融合——更透的底、柔和发光描边（不是锐利实线） */
[data-theme='jarvis'] .composer-card {
  background: var(--panel-input);
  border-color: var(--accent-a20);
  box-shadow: 0 0 18px var(--accent-a6);
}

.composer-card.focused {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}

.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 8px 0;
}

.attachment {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 3px 8px;
  font-size: 12.5px;
  background: var(--panel);
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
  border: none;
  outline: none;
  padding: 7px 9px 2px;
  background: transparent;
  color: var(--text);
  line-height: 1.55;
  min-height: 34px;
  max-height: 200px;
}

textarea::placeholder {
  color: var(--text-3);
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 3px 0;
}

.icon-btn {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  flex: none;
}

.icon-btn:hover {
  background: var(--hover);
  color: var(--text);
}

/* 模型选择器（Friday 样式：ghost chip + 上拉菜单） */
.model-wrap {
  position: relative;
  flex: none;
}

.model-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 220px;
  height: 30px;
  padding: 0 9px;
  border-radius: 8px;
  color: var(--text-2);
  font-size: 12.5px;
}

.model-chip:hover,
.model-chip.open {
  background: var(--hover);
  color: var(--text);
}

.model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-caret {
  font-size: 9px;
  color: var(--text-3);
}

.model-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  min-width: 240px;
  max-height: 300px;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16);
  padding: 5px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.model-empty {
  padding: 10px 12px;
  font-size: 12.5px;
  color: var(--text-3);
}

.model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 8px;
  text-align: left;
}

.model-item:hover {
  background: var(--hover);
}

.model-item.current {
  background: var(--selected);
}

.model-item-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.model-item-title {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-item-model {
  font-size: 11.5px;
  color: var(--text-3);
  font-family: 'Cascadia Code', Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-check {
  flex: none;
  color: var(--accent);
  font-size: 13px;
}

.error {
  color: var(--fail);
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint {
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
}

/* 面板窄时提示行没地方放：按容器宽（.assistant-chat 设了 container-type）而不是视口宽判断，
   视口媒体查询在 1920px 桌面上永远不命中，提示行在 352px 面板里会被挤断 */
@container (max-width: 420px) {
  .hint {
    display: none;
  }
}

.spacer {
  flex: 1;
}

/* 圆形发送 / 停止键（Friday 样式） */
.round-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.round-btn.send {
  background: var(--accent);
  color: #fff;
  transition: filter 0.12s, opacity 0.12s;
}

.round-btn.send:hover:not(:disabled) {
  filter: brightness(1.1);
}

.round-btn.send:disabled {
  background: var(--chip);
  color: var(--text-3);
  cursor: default;
}

.round-btn.stop {
  border: 1px solid var(--fail);
  color: var(--fail);
  background: transparent;
}

.round-btn.stop:hover {
  background: var(--fail);
  color: #fff;
}

.busy-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* 贾维斯界面：输入台 = 全息指令台。真四角括号（伪元素画，不被圆角裁掉）、顶部能量线、聚焦辉光 */
[data-theme='jarvis'] .composer {
  background: transparent;
}

[data-theme='jarvis'] .composer-card {
  position: relative;
  border-radius: 6px;
  background:
    linear-gradient(90deg, transparent, var(--accent-a40), transparent) top / 100% 1px no-repeat,
    var(--panel-glass-deep);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-color: var(--accent-a26);
  box-shadow:
    0 0 20px var(--accent-a7),
    0 10px 26px rgba(0, 0, 0, 0.45);
}

/* 四角括号：::before 画上面两角，::after 画下面两角 */
[data-theme='jarvis'] .composer-card::before,
[data-theme='jarvis'] .composer-card::after {
  content: '';
  position: absolute;
  left: -1px;
  right: -1px;
  height: 14px;
  pointer-events: none;
  background:
    linear-gradient(var(--accent) 0 0) left top / 14px 2px,
    linear-gradient(var(--accent) 0 0) left top / 2px 14px,
    linear-gradient(var(--accent) 0 0) right top / 14px 2px,
    linear-gradient(var(--accent) 0 0) right top / 2px 14px;
  background-repeat: no-repeat;
  opacity: 0.75;
  transition: opacity 0.15s;
}

[data-theme='jarvis'] .composer-card::before {
  top: -1px;
}

[data-theme='jarvis'] .composer-card::after {
  bottom: -1px;
  background:
    linear-gradient(var(--accent) 0 0) left bottom / 14px 2px,
    linear-gradient(var(--accent) 0 0) left bottom / 2px 14px,
    linear-gradient(var(--accent) 0 0) right bottom / 14px 2px,
    linear-gradient(var(--accent) 0 0) right bottom / 2px 14px;
  background-repeat: no-repeat;
}

[data-theme='jarvis'] .composer-card.focused {
  border-color: var(--accent-a60);
  box-shadow:
    0 0 0 1px var(--accent-a20),
    0 0 28px var(--accent-a16);
}

[data-theme='jarvis'] .composer-card.focused::before,
[data-theme='jarvis'] .composer-card.focused::after {
  opacity: 1;
}

[data-theme='jarvis'] .composer-card textarea {
  background: transparent;
  caret-color: var(--accent);
}

[data-theme='jarvis'] .composer-card textarea::placeholder {
  font-family: var(--font-hud);
  letter-spacing: 2px;
}

[data-theme='jarvis'] .icon-btn {
  color: var(--accent-a65);
}

[data-theme='jarvis'] .icon-btn:hover {
  color: var(--accent);
  text-shadow: 0 0 8px var(--accent-a60);
}

[data-theme='jarvis'] .hint {
  color: var(--text-3-a70);
}

[data-theme='jarvis'] .model-chip {
  font-family: var(--font-hud);
  letter-spacing: 1px;
  border-color: var(--accent-a30);
  border-radius: 4px;
  color: var(--code-inline-fg-a90);
}

[data-theme='jarvis'] .model-chip .model-caret {
  color: var(--accent);
}

[data-theme='jarvis'] .model-chip:hover,
[data-theme='jarvis'] .model-chip.open {
  border-color: var(--accent-a55);
  color: #c9f2ff;
}

/* 发送 / 停止钮：圆环辉光；生成中停止键红色脉冲 */
[data-theme='jarvis'] .round-btn {
  border: 1px solid var(--accent-a55);
  background: var(--accent-a10);
  color: #bdf3ff;
  box-shadow:
    0 0 12px var(--accent-a25),
    inset 0 0 8px var(--accent-a12);
}

[data-theme='jarvis'] .round-btn.send:hover:not(:disabled) {
  box-shadow:
    0 0 20px var(--accent-a50),
    inset 0 0 10px var(--accent-a20);
}

[data-theme='jarvis'] .round-btn.send:disabled {
  opacity: 0.35;
  box-shadow: none;
}

[data-theme='jarvis'] .round-btn.stop {
  border-color: var(--fail-a65);
  background: var(--fail-a12);
  color: #ffc2cd;
  animation: jarvis-stop-pulse 1.2s ease-in-out infinite;
}

@keyframes jarvis-stop-pulse {
  50% {
    box-shadow: 0 0 22px var(--fail-a50);
  }
}

[data-theme='jarvis'] .busy-dot {
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent-a80);
}
</style>
