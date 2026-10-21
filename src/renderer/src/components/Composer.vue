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
  if (modelOpen.value) {
    dirOpen.value = false
    switchError.value = ''
  }
}

async function chooseEngine(engine: EngineView) {
  modelOpen.value = false
  switchError.value = ''
  if (engine.id === currentEngineID.value) return
  try {
    // 没打开会话（空着重升新对话）：直接建一段新的，建的时候就带上引擎（REMOTE.md conversation.create engineID）
    if (!props.conversationId) {
      await store.createConversation({ engineID: engine.id })
      return
    }
    await store.setEngine(props.conversationId, engine.id)
  } catch (error) {
    switchError.value = error instanceof Error ? error.message : String(error)
  }
}

// MARK: 工作目录选择（方案 §5.3：runner.setWorkingDirectory；最近目录 directories.*，浏览 fs.list）
const dirOpen = ref(false)
const dirWrap = ref<HTMLDivElement | null>(null)
const dirError = ref('')
const browsing = ref(false)
const browseLoading = ref(false)
const browseError = ref('')
const browsePath = ref('')
const browseParent = ref<string | undefined>(undefined)
const browseEntries = ref<Array<{ name: string; path: string }>>([])
const browseRoots = ref<Array<{ name: string; path: string }>>([])

/** 这台机器的新对话默认工作目录（server.defaultWorkingDirectory） */
const defaultWorkdir = computed(() => store.currentMachineInfo?.serverInfo?.defaultWorkingDirectory ?? '')

function dirBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

const currentSummary = computed(() => store.summaries.find((summary) => summary.id === props.conversationId))
const currentWorkdir = computed(
  () => currentSummary.value?.workingDirectory ?? store.details[props.conversationId ?? '']?.runtime?.workingDirectory ?? ''
)
const currentWorkdirLabel = computed(() => {
  if (currentWorkdir.value) return currentSummary.value?.workingDirectoryName || dirBasename(currentWorkdir.value)
  return defaultWorkdir.value ? dirBasename(defaultWorkdir.value) : '默认目录'
})

function toggleDirMenu() {
  dirOpen.value = !dirOpen.value
  if (dirOpen.value) {
    modelOpen.value = false
    dirError.value = ''
    browsing.value = false
    void store.refreshDirectories() // 打开时重拉：顺带重验最近目录还在不在（REMOTE.md）
  }
}

/** 选定工作目录（path 不给 = 回这台机器的默认）；没打开会话就建一段新的并直接带上目录 */
async function chooseWorkdir(path?: string) {
  dirOpen.value = false
  dirError.value = ''
  if (path && path === currentWorkdir.value) return
  try {
    if (!props.conversationId) {
      await store.createConversation(path ? { workingDirectory: path } : {})
      return
    }
    await store.setWorkingDirectory(props.conversationId, path)
  } catch (error) {
    dirError.value = error instanceof Error ? error.message : String(error)
  }
}

/** 打开目录浏览（REMOTE.md fs.list：不给 path 是主目录；roots 是主目录和各盘） */
async function openBrowse(path?: string) {
  browsing.value = true
  browseLoading.value = true
  browseError.value = ''
  try {
    const result = await store.browseDirectory(path)
    if (!result) return
    browsePath.value = result.path
    browseParent.value = result.parent
    browseEntries.value = result.entries ?? []
    browseRoots.value = result.roots ?? []
  } catch (error) {
    browseError.value = error instanceof Error ? error.message : String(error)
  } finally {
    browseLoading.value = false
  }
}

function onDocClick(event: MouseEvent) {
  const target = event.target as Node
  if (modelOpen.value && modelWrap.value && !modelWrap.value.contains(target)) modelOpen.value = false
  if (dirOpen.value && dirWrap.value && !dirWrap.value.contains(target)) dirOpen.value = false
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

// MARK: 和助手开新会话（默认和助手对话：没选中会话时，输入本来就直接开一段新的和助手聊；
// 这个键把「开新会话」放到输入框旁边，不用去左上角会话列表找「＋ 新建」）
const newChatBusy = ref(false)
async function newConversation(): Promise<void> {
  if (!store.connected || newChatBusy.value) return
  // 当前已经是一段空着、没在跑的新会话：不再多开一段（连点几下也不攒空会话），直接聚焦输入
  const current = props.conversationId
  const detail = current ? store.details[current] : undefined
  const runtime = detail?.runtime
  const alreadyFresh =
    detail !== undefined &&
    detail.messages.length === 0 &&
    !runtime?.generating &&
    !runtime?.stopping &&
    (runtime?.queue?.length ?? 0) === 0
  if (!alreadyFresh) {
    newChatBusy.value = true
    try {
      await store.createConversation()
    } finally {
      newChatBusy.value = false
    }
  }
  textarea.value?.focus()
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
        <!-- 和助手开新会话：默认没选会话时输入就会开新的一段，这个键显式开 -->
        <button
          class="icon-btn"
          title="和助手开新会话"
          aria-label="和助手开新会话"
          :disabled="!store.connected || newChatBusy"
          @click="newConversation"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <path d="M12 7v6" />
            <path d="M9 10h6" />
          </svg>
        </button>
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

        <!-- 工作目录选择（方案 §5.3）：作用在当前会话；没打开会话就新建一段把目录带上 -->
        <div ref="dirWrap" class="model-wrap dir-wrap">
          <button
            class="model-chip"
            :class="{ open: dirOpen }"
            :title="dirError || `工作目录：${currentWorkdir || defaultWorkdir || '这台机器的默认目录'}`"
            @click="toggleDirMenu"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span class="model-name">{{ currentWorkdirLabel }}</span>
            <span class="model-caret">▾</span>
          </button>
          <div v-if="dirOpen" class="model-menu dir-menu">
            <!-- 列表模式：默认目录 + 最近目录 + 浏览入口 -->
            <template v-if="!browsing">
              <button class="model-item" :class="{ current: !currentWorkdir }" @click="chooseWorkdir()">
                <span class="model-item-main">
                  <span class="model-item-title">默认目录</span>
                  <span v-if="defaultWorkdir" class="model-item-model">{{ defaultWorkdir }}</span>
                </span>
                <span v-if="!currentWorkdir" class="model-check">✓</span>
              </button>
              <div v-if="store.recentDirectories && store.recentDirectories.length > 0" class="dir-sep">最近选择</div>
              <div
                v-for="entry in store.recentDirectories ?? []"
                :key="entry.path"
                class="model-item dir-recent"
                :class="{ current: entry.path === currentWorkdir, missing: !entry.exists }"
                :title="entry.path"
                @click="entry.exists && chooseWorkdir(entry.path)"
              >
                <span class="model-item-main">
                  <span class="model-item-title">{{ dirBasename(entry.path) }}</span>
                  <span class="model-item-model">{{ entry.path }}</span>
                </span>
                <button class="dir-remove" title="从最近里去掉" @click.stop="store.removeRecentDirectory(entry.path)">×</button>
              </div>
              <button class="dir-browse-btn" @click="openBrowse()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <path d="M9 14l2-2 2 2" transform="translate(1,-1)" />
                </svg>
                浏览这台机器的目录…
              </button>
            </template>
            <!-- 浏览模式（fs.list）：逐层下钻，「选定此目录」收尾 -->
            <template v-else>
              <div class="dir-browse-bar">
                <button v-if="browseParent" class="dir-up" title="上一级" @click="openBrowse(browseParent)">↑</button>
                <span class="dir-browse-path" :title="browsePath">{{ browsePath || '主目录' }}</span>
                <button class="dir-back" @click="browsing = false">返回</button>
              </div>
              <div v-if="browseLoading" class="model-empty">正在读目录…</div>
              <div v-else-if="browseError" class="model-empty">{{ browseError }}</div>
              <div v-else class="dir-browse-list">
                <template v-if="browseRoots.length > 0 && !browseParent">
                  <div class="dir-browse-sep">这台机器的盘 / 主目录</div>
                  <button
                    v-for="root in browseRoots"
                    :key="root.path"
                    class="model-item"
                    :title="root.path"
                    @click="openBrowse(root.path)"
                  >
                    <span class="model-item-main">
                      <span class="model-item-title">{{ root.name }}</span>
                    </span>
                  </button>
                </template>
                <button
                  v-for="entry in browseEntries"
                  :key="entry.path"
                  class="model-item"
                  :title="entry.path"
                  @click="openBrowse(entry.path)"
                >
                  <span class="model-item-main">
                    <span class="model-item-title">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="opacity: .7; vertical-align: -1px; margin-right: 3px">
                        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                      </svg>{{ entry.name }}
                    </span>
                  </span>
                </button>
                <div v-if="browseEntries.length === 0 && !(browseRoots.length > 0 && !browseParent)" class="model-empty">这里面没有子目录</div>
              </div>
              <button class="dir-pick" :disabled="!browsePath" @click="chooseWorkdir(browsePath)">选定此目录</button>
            </template>
          </div>
        </div>

        <span v-if="switchError" class="error">{{ switchError }}</span>
        <span v-else-if="uploadError" class="error">{{ uploadError }}</span>
        <span v-else-if="dirError" class="error">{{ dirError }}</span>
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
  padding: 4px 6px 6px;
  /* 悬浮在中间桌面底部（App.vue 的 composer-dock）：不再做面板底色，透出 3D 场景 */
  background: transparent;
}

.composer-card {
  max-width: 760px;
  margin: 0 auto;
  border: 1px solid var(--border);
  border-radius: 18px;
  /* 悬浮输入台：磨砂玻璃卡（透出底下场景）+ 顶部内高光 + 柔和落影 */
  background: var(--panel-2);
  backdrop-filter: blur(18px) saturate(1.4);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.22),
    0 10px 30px rgba(0, 0, 0, 0.16);
  padding: 4px 8px 7px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  transition: border-color 0.18s, box-shadow 0.18s, transform 0.18s;
}

/* 贾维斯主题的输入台样式在文件末尾的「全息指令台」段（四角括号/能量线/聚焦辉光，特异性更高会盖掉上面） */

/* 聚焦：不再改边框/光环（用户要求去掉输入框聚焦边框），只保留轻轻上浮 */
.composer-card.focused {
  transform: translateY(-2px);
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
  padding: 9px 10px 3px;
  background: transparent;
  color: var(--text);
  line-height: 1.55;
  min-height: 36px;
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

.icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.icon-btn:hover:not(:disabled) {
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
  /* 弹出菜单：磨砂玻璃（半透底 + 模糊背景），和悬浮输入台同一质感 */
  background: var(--panel);
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.18);
  padding: 5px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* ---- 工作目录选择 ---- */
.dir-menu {
  min-width: 300px;
  max-height: 360px;
}

.dir-sep,
.dir-browse-sep {
  flex: none;
  padding: 7px 9px 3px;
  font-size: 10.5px;
  letter-spacing: 1px;
  color: var(--text-3);
}

.dir-recent.missing {
  opacity: 0.45;
  cursor: default;
}

.dir-recent .model-item-model {
  direction: rtl; /* 路径太长时留下尾巴（盘符/深层目录名）而不是开头 */
  text-align: left;
}

.dir-remove {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  font-size: 13px;
  line-height: 1;
}

.dir-remove:hover {
  background: var(--hover);
  color: var(--fail);
}

.dir-browse-btn {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 3px;
  padding: 7px 9px;
  border-top: 1px solid var(--border);
  border-radius: 0 0 8px 8px;
  color: var(--text-2);
  font-size: 12.5px;
}

.dir-browse-btn:hover {
  color: var(--text);
  background: var(--hover);
}

.dir-browse-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 5px 7px;
  border-bottom: 1px solid var(--border);
}

.dir-up,
.dir-back {
  flex: none;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 12px;
}

.dir-up:hover,
.dir-back:hover {
  background: var(--hover);
  color: var(--text);
}

.dir-browse-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 11.5px;
  color: var(--text-2);
}

.dir-browse-list {
  min-height: 120px;
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0 -5px;
  padding: 0 5px;
}

.dir-pick {
  flex: none;
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 12.5px;
}

.dir-pick:hover:not(:disabled) {
  filter: brightness(1.08);
}

.dir-pick:disabled {
  background: var(--chip);
  color: var(--text-3);
  cursor: default;
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
  box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 35%, transparent);
  transition: filter 0.12s, opacity 0.12s, transform 0.12s, box-shadow 0.12s;
}

.round-btn.send:hover:not(:disabled) {
  filter: brightness(1.1);
  transform: translateY(-1px);
  box-shadow: 0 5px 14px color-mix(in srgb, var(--accent) 45%, transparent);
}

.round-btn.send:active:not(:disabled) {
  transform: translateY(0);
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

/* 聚焦：同样只上浮，不改边框/辉光；四角括号也不再点亮（去掉聚焦边框效果） */
[data-theme='jarvis'] .composer-card.focused {
  transform: translateY(-2px);
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

[data-theme='jarvis'] .model-menu {
  /* 全息面板：深色玻璃 + 青色描边（模糊背景照加，透出底下网格） */
  background: var(--panel-glass-deep);
  border-color: var(--accent-a30);
  box-shadow:
    0 0 18px var(--accent-a10),
    0 12px 32px rgba(0, 0, 0, 0.5);
}

[data-theme='jarvis'] .dir-sep,
[data-theme='jarvis'] .dir-browse-sep {
  font-family: var(--font-hud);
  color: var(--accent-a65);
}

[data-theme='jarvis'] .dir-up,
[data-theme='jarvis'] .dir-back {
  border-color: var(--accent-a30);
  color: var(--text-2);
}

[data-theme='jarvis'] .dir-pick {
  background: var(--accent-a20);
  border: 1px solid var(--accent-a55);
  color: #bdf3ff;
  box-shadow: 0 0 12px var(--accent-a25);
}

[data-theme='jarvis'] .dir-pick:disabled {
  background: transparent;
  border-color: var(--accent-a20);
  color: var(--text-3);
  box-shadow: none;
}

[data-theme='jarvis'] .dir-browse-btn {
  border-top-color: var(--accent-a20);
  color: var(--accent-a65);
}

[data-theme='jarvis'] .dir-browse-btn:hover {
  color: var(--accent);
  background: var(--hover);
}

/* 发送 / 停止钮：圆环辉光；生成中停止键红色脉冲 */
[data-theme='jarvis'] .round-btn {
  border: 1px solid var(--accent-a55);
  background: var(--accent-a10);
  color: #bdf3ff;
  box-shadow:
    0 0 12px var(--accent-a25),
    inset 0 0 8px var(--accent-a12);
  transition: box-shadow 0.15s, transform 0.15s, filter 0.15s;
}

[data-theme='jarvis'] .round-btn.send:hover:not(:disabled) {
  box-shadow:
    0 0 20px var(--accent-a50),
    inset 0 0 10px var(--accent-a20);
  transform: translateY(-1px);
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
