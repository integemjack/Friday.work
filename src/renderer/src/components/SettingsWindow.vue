<script setup lang="ts">
// 设置窗口（M4）：两个 tab——「机器」（这台远程机器的引擎、Agent 设置、服务状态，只读）
// 和「语音播报」（回复 TTS：开关、音色、自定义音色、模型下载）。
// 语音播报是本机行为（本地 kokoro 模型合成），不依赖连接哪台机器。
import { computed, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'
import { loadTheme, setTheme, type UITheme } from '../lib/theme.js'
import {
  addCustomVoice,
  CUSTOM_VOICE_GROUPS,
  currentVoiceId,
  customVoices,
  PRESET_VOICES,
  previewVoice,
  prefetchTtsModel,
  removeCustomVoice,
  replySpeakEnabled,
  setCurrentVoice,
  setReplySpeak,
  sidToVoiceCode,
  stopSpeaking,
  ttsDetail,
  ttsPhase,
  type VoiceOption
} from '../lib/speechOutput.js'

const store = useAppStore()
const loading = ref(false)
const error = ref('')

// 设置分区：机器信息（原有内容）/ 语音播报（回复 TTS）
const tab = ref<'machine' | 'speech'>('machine')

// 界面主题（本机偏好，见 lib/theme.ts）：跟系统 / 贾维斯
const theme = ref<UITheme>(loadTheme())
function pickTheme(next: UITheme): void {
  theme.value = next
  setTheme(next)
}

interface EngineView {
  id: string
  title: string
  model: string
  kind?: string
  supportsTools?: boolean
  subAgentAllowed?: boolean
  disabled?: boolean
}

const engines = ref<EngineView[]>([])
const settings = ref<Record<string, unknown> | null>(null)
const server = ref<Record<string, unknown> | null>(null)

const machine = computed(() => store.currentMachineInfo)

// 客户端更新（主进程 ClientUpdate；状态在 store.update。自动管线：定时查到新版本会自动下载，
// Windows 下载完倒计时自动安装重启；进度另在桌面右下角浮层 UpdateOverlay 播报）
const update = computed(() => store.update)
const updateBusy = computed(
  () => update.value.phase === 'checking' || update.value.phase === 'downloading' || update.value.phase === 'installing'
)
const canInstall = computed(() => update.value.phase === 'available' || update.value.phase === 'ready')
const installLabel = computed(() =>
  update.value.phase === 'ready' ? '重新下载' : update.value.platform === 'win32' ? '下载并安装' : '下载安装包'
)
const commitText = computed(() => {
  const commit = update.value.currentCommit
  if (!commit || commit === 'dev') return '开发版'
  return commit.slice(0, 7)
})
const percentText = computed(() => `${Math.round(update.value.progress * 100)}%`)

async function load(): Promise<void> {
  if (!store.currentMachine || !store.connected) return
  loading.value = true
  error.value = ''
  try {
    // 引擎没有单独的查询方法：用 hello 快照 + engines 事件维护的那份（REMOTE.md §5）
    engines.value = store.engines as EngineView[]
  } catch {
    engines.value = []
  }
  try {
    settings.value = (await store.rpc(store.currentMachine, 'settings.get', {})) as Record<string, unknown>
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  try {
    server.value = (await store.rpc(store.currentMachine, 'server.status', {})) as Record<string, unknown>
  } catch {
    // 旧服务端没有这个方法
  }
  loading.value = false
}

/** 设置里挑几项给人看的 */
const settingRows = computed<Array<{ key: string; label: string; value: string }>>(() => {
  const value = settings.value
  if (!value) return []
  const rows: Array<{ key: string; label: string; value: string }> = []
  const push = (key: string, label: string): void => {
    const raw = value[key]
    if (raw === undefined || raw === null || raw === '') return
    rows.push({ key, label, value: typeof raw === 'boolean' ? (raw ? '开' : '关') : String(raw) })
  }
  push('defaultPermissionMode', '默认权限模式')
  push('teamMode', '工作方式')
  push('defaultEngineID', '默认引擎')
  push('lightEngineID', '小活用的模型')
  push('subAgentEngineID', '子智能体用的模型')
  push('quotaFallback', '额度用完时')
  push('enableThinking', '默认开思考')
  push('requireApproval', '工具调用要确认')
  push('confirmPaidCalls', '付费调用要确认')
  push('workingDirectory', '默认工作目录')
  return rows
})

const serverRows = computed<Array<{ label: string; value: string }>>(() => {
  const value = server.value
  if (!value) return []
  const rows: Array<{ label: string; value: string }> = []
  const push = (key: string, label: string): void => {
    const raw = value[key]
    if (raw === undefined || raw === null) return
    rows.push({ label, value: typeof raw === 'object' ? JSON.stringify(raw) : String(raw) })
  }
  push('version', '版本')
  push('protocol', '协议版本')
  push('hostname', '主机名')
  push('user', '用户')
  push('dataDirectory', '数据目录')
  push('clients', '客户端数')
  push('host', '服务来源')
  return rows
})

onMounted(load)

// MARK: 语音播报（tab=speech）：开关 / 音色 / 自定义音色 / 模型下载

/** 自定义音色下拉的选项（分组：中文女 55 / 中文男 45 / 英文女 3） */
const customVoiceOptions = CUSTOM_VOICE_GROUPS.map((group) => ({
  label: group.label,
  options: group.sids.map((sid) => ({ value: sid, label: `${sidToVoiceCode(sid)}（编号 ${sid}）` }))
}))

/** 全部可选音色：预置 10 个 + 用户自定义的（自定义的排后面，可删） */
const allVoices = computed<VoiceOption[]>(() => [...PRESET_VOICES, ...customVoices.value])

const draft = ref({ name: '', sid: 3, speed: 1.0 })
const draftOpen = ref(false)

function pickDraftVoice(sid: number): void {
  draft.value.sid = sid
}

function previewDraft(): void {
  previewVoice({ id: 'draft', name: draft.value.name || '新音色', tag: '', sid: draft.value.sid, speed: draft.value.speed })
}

function saveCustom(): void {
  const name = draft.value.name.trim()
  if (!name) return
  const voice = addCustomVoice(name, draft.value.sid, draft.value.speed)
  setCurrentVoice(voice.id)
  draftOpen.value = false
  draft.value = { name: '', sid: 3, speed: 1.0 }
}

/** 模型状态文案（下载/解压/加载/就绪/出错；首次使用自动下载约 150MB） */
const modelStateText = computed(() => {
  switch (ttsPhase.value) {
    case 'downloading':
      return ttsDetail.value || '语音模型下载中…'
    case 'extracting':
      return '语音模型解压中…'
    case 'loading':
      return '语音模型加载中…（首次约十几秒）'
    case 'error':
      return `模型出错：${ttsDetail.value || '未知原因'}`
    default:
      return ''
  }
})
const modelReady = computed(() => ttsPhase.value === 'idle' || ttsPhase.value === 'speaking')
</script>

<template>
  <div class="settings">
    <div class="head">
      <div class="tabs">
        <button class="tab-btn" :class="{ active: tab === 'machine' }" @click="tab = 'machine'">机器</button>
        <button class="tab-btn" :class="{ active: tab === 'speech' }" @click="tab = 'speech'">语音播报</button>
      </div>
      <button v-if="tab === 'machine'" class="small-btn" :disabled="loading || !store.connected" @click="load">
        {{ loading ? '读取中…' : '刷新' }}
      </button>
      <button v-else-if="ttsPhase === 'speaking'" class="small-btn" @click="stopSpeaking()">停止试听</button>
    </div>

    <template v-if="tab === 'machine'">
    <div class="note" style="padding-top: 0">来自 {{ machine?.name ?? '（未连接）' }} 的只读信息。</div>
    <section>
      <h3>客户端更新</h3>
      <div class="row">
        <span class="key">当前版本</span>
        <span class="value">{{ update.currentVersion || '…' }}（{{ commitText }}）</span>
      </div>
      <div v-if="update.version" class="row">
        <span class="key">可用更新</span>
        <span class="value">
          {{ update.version }}<span v-if="update.commit">（{{ update.commit.slice(0, 7) }}）</span>
        </span>
      </div>
      <div v-if="update.phase === 'downloading'" class="progress">
        <div class="bar" :style="{ width: percentText }" />
      </div>
      <div v-if="update.phase === 'uptodate'" class="note">已是最新版本。</div>
      <div v-if="update.phase === 'installing'" class="note">正在静默安装，应用即将重启…</div>
      <div class="note">每 1 分钟自动检查（发布频繁）；Windows 下发现更新会自动下载并重启安装，下载进度也显示在桌面右下角。</div>
      <div v-if="update.note" class="note">{{ update.note }}</div>
      <div v-if="update.error" class="error">{{ update.error }}</div>
      <div class="update-actions">
        <button class="small-btn" :disabled="updateBusy" @click="store.checkUpdate()">
          {{ update.phase === 'checking' ? '检查中…' : '检查更新' }}
        </button>
        <button
          v-if="canInstall"
          class="small-btn strong"
          :disabled="updateBusy"
          @click="store.installUpdate()"
        >
          {{ update.phase === 'downloading' ? `下载中 ${percentText}` : installLabel }}
        </button>
      </div>
    </section>

    <section>
      <h3>界面</h3>
      <div class="theme-row">
        <button class="small-btn" :class="{ strong: theme === 'system' }" @click="pickTheme('system')">
          跟随系统
        </button>
        <button
          class="small-btn"
          :class="{ strong: theme === 'jarvis' }"
          title="深空青色发光界面，照钢铁侠 J.A.R.V.I.S. 的全息 HUD 风"
          @click="pickTheme('jarvis')"
        >
          贾维斯
        </button>
      </div>
      <div class="note">贾维斯是本机界面偏好（深空黑 + 电光青全息风），与远程机器无关。</div>
    </section>

    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="!store.connected" class="empty">先连上一台机器。</div>

    <template v-else>
      <section>
        <h3>服务</h3>
        <div v-if="!serverRows.length" class="empty-line">没有服务信息</div>
        <div v-for="row in serverRows" :key="row.label" class="row">
          <span class="key">{{ row.label }}</span>
          <span class="value">{{ row.value }}</span>
        </div>
      </section>

      <section>
        <h3>引擎</h3>
        <div v-if="!engines.length" class="empty-line">这台机器没有可用的引擎</div>
        <div v-for="engine in engines" :key="engine.id" class="engine">
          <div class="engine-main">
            <span class="engine-title">{{ engine.title }}</span>
            <span class="engine-model">{{ engine.model }}</span>
          </div>
          <div class="engine-tags">
            <span v-if="engine.kind" class="tag">{{ engine.kind }}</span>
            <span v-if="engine.supportsTools" class="tag">工具</span>
            <span v-if="engine.subAgentAllowed" class="tag">子 Agent 可用</span>
            <span v-if="engine.disabled" class="tag off">已停用</span>
          </div>
        </div>
      </section>

      <section>
        <h3>Agent 设置</h3>
        <div v-if="!settingRows.length" class="empty-line">没有读到设置</div>
        <div v-for="row in settingRows" :key="row.key" class="row">
          <span class="key">{{ row.label }}</span>
          <span class="value">{{ row.value }}</span>
        </div>
        <div class="note">这些值在远端 Friday 上改；这里只展示。</div>
      </section>
    </template>
    </template>

    <section v-else>
      <h3>回复语音播报</h3>
      <div class="row">
        <span class="key">助手回复念出来</span>
        <span class="value">
          <button class="small-btn" :class="{ strong: replySpeakEnabled }" @click="setReplySpeak(true)">开</button>
          <button class="small-btn" :class="{ strong: !replySpeakEnabled }" @click="setReplySpeak(false)">关</button>
        </span>
      </div>
      <div class="note">回复完成时用本地语音模型朗读文字部分（代码块、链接不念），完全离线、不联网。自己发言会自动打断播报。首次使用会下载约 350MB 模型（fp32，比 int8 快 3-4 倍），之后不再下载。</div>

      <h3 class="sub">音色（默认 10 种，可自定义）</h3>
      <div class="voice-grid">
        <button
          v-for="voice in allVoices"
          :key="voice.id"
          class="voice-item"
          :class="{ active: currentVoiceId === voice.id }"
          @click="setCurrentVoice(voice.id)"
        >
          <span class="voice-name">{{ voice.name }}</span>
          <span class="voice-meta">{{ voice.tag }} · {{ voice.custom ? sidToVoiceCode(voice.sid) : voice.id }}</span>
          <span class="voice-actions">
            <span class="voice-mini" role="button" title="试听这个音色" @click.stop="previewVoice(voice)">试听</span>
            <span
              v-if="voice.custom"
              class="voice-mini danger"
              role="button"
              title="删掉这个自定义音色"
              @click.stop="removeCustomVoice(voice.id)"
              >删除</span
            >
          </span>
        </button>
        <button class="voice-item add" @click="draftOpen = !draftOpen">
          <span class="voice-name">+ 自定义音色</span>
          <span class="voice-meta">在 100 个内置音色里起名保存</span>
        </button>
      </div>

      <div v-if="draftOpen" class="voice-draft">
        <div class="row">
          <span class="key">名字</span>
          <input v-model="draft.name" class="input" maxlength="12" placeholder="比如：沉稳男声" />
        </div>
        <div class="row">
          <span class="key">底层音色</span>
          <select class="input" :value="draft.sid" @change="pickDraftVoice(Number(($event.target as HTMLSelectElement).value))">
            <optgroup v-for="group in customVoiceOptions" :key="group.label" :label="group.label">
              <option v-for="option in group.options" :key="option.value" :value="option.value">{{ option.label }}</option>
            </optgroup>
          </select>
        </div>
        <div class="row">
          <span class="key">语速 {{ draft.speed.toFixed(2) }}×</span>
          <input
            v-model.number="draft.speed"
            class="input range"
            type="range"
            min="0.6"
            max="1.6"
            step="0.05"
          />
        </div>
        <div class="update-actions">
          <button class="small-btn" @click="previewDraft">试听</button>
          <button class="small-btn strong" :disabled="!draft.name.trim()" @click="saveCustom">保存并使用</button>
        </div>
      </div>

      <h3 class="sub">本地语音模型</h3>
      <div class="row">
        <span class="key">模型</span>
        <span class="value">kokoro v1.1 fp32（103 音色，中英）· 本机合成 · 实测比实时快 2-3 倍</span>
      </div>
      <div v-if="ttsPhase === 'downloading'" class="progress">
        <div class="bar" :style="{ width: (ttsDetail.match(/(\d+)%/)?.[1] ?? 0) + '%' }" />
      </div>
      <div v-if="modelStateText" class="note">{{ modelStateText }}</div>
      <div v-else-if="modelReady" class="note">模型已就绪（首次使用后不再下载）。</div>
      <div class="update-actions">
        <button v-if="ttsPhase === 'downloading' || ttsPhase === 'extracting' || ttsPhase === 'loading'" class="small-btn" disabled>
          准备中…
        </button>
        <button v-else-if="!modelReady" class="small-btn" @click="prefetchTtsModel()">重试下载</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px 20px;
  background: var(--panel);
  font-size: 12.5px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 10px;
}

/* 设置分区 tab */
.tabs {
  display: flex;
  gap: 6px;
}

.tab-btn {
  font-size: 12.5px;
  padding: 3px 12px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
}

.tab-btn:hover {
  color: var(--text);
}

.tab-btn.active {
  color: var(--text);
  border-color: var(--border);
  background: var(--chip);
}

[data-theme='jarvis'] .tab-btn.active {
  color: var(--accent);
  border-color: var(--accent-a55);
  box-shadow: 0 0 10px var(--accent-a15);
}

.small-btn {
  font-size: 12px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text-2);
}

.small-btn:hover:not(:disabled) {
  color: var(--text);
}

.small-btn:disabled {
  opacity: 0.5;
}

.small-btn.strong {
  color: var(--text);
  border-color: var(--text-3);
}

.progress {
  height: 4px;
  border-radius: 2px;
  background: var(--chip);
  overflow: hidden;
  margin: 6px 0;
}

.bar {
  height: 100%;
  border-radius: 2px;
  background: var(--text-3);
  transition: width 0.2s ease;
}

.update-actions {
  display: flex;
  gap: 8px;
  padding-top: 6px;
}

/* 界面主题切换（跟系统 / 贾维斯） */
.theme-row {
  display: flex;
  gap: 8px;
}

/* 贾维斯界面下选中的主题按钮用青色描边，和整体发光风一致 */
[data-theme='jarvis'] .small-btn.strong {
  color: var(--accent);
  border-color: var(--accent-a55);
  box-shadow: 0 0 10px var(--accent-a15);
}

section {
  margin-bottom: 18px;
}

h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}

.row {
  display: flex;
  gap: 12px;
  padding: 3px 0;
}

.key {
  flex: 0 0 130px;
  color: var(--text-3);
}

.value {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.engine {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 6px;
}

.engine-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.engine-title {
  font-weight: 500;
}

.engine-model {
  color: var(--text-3);
  font-size: 11.5px;
}

.engine-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--chip);
  color: var(--text-2);
}

.tag.off {
  color: var(--fail);
}

.note {
  color: var(--text-3);
  font-size: 11.5px;
  padding-top: 6px;
}

.empty,
.empty-line {
  color: var(--text-3);
  font-size: 12.5px;
  padding: 8px 0;
}

.error {
  color: var(--fail);
  padding: 6px 0;
}

/* 语音播报 tab */
h3.sub {
  margin-top: 14px;
}

.voice-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
}

.voice-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.voice-item:hover {
  border-color: var(--text-3);
}

.voice-item.active {
  border-color: var(--text-2);
  box-shadow: 0 0 0 1px var(--text-3) inset;
}

[data-theme='jarvis'] .voice-item.active {
  border-color: var(--accent);
  box-shadow: 0 0 10px var(--accent-a15);
}

.voice-name {
  font-weight: 500;
}

.voice-meta {
  font-size: 11px;
  color: var(--text-3);
}

.voice-actions {
  display: flex;
  gap: 8px;
}

.voice-mini {
  font-size: 11px;
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 0 6px;
}

.voice-mini:hover {
  color: var(--text);
  border-color: var(--text-3);
}

.voice-mini.danger:hover {
  color: var(--fail);
  border-color: var(--fail);
}

.voice-draft {
  margin-top: 10px;
  padding: 10px;
  border: 1px dashed var(--border);
  border-radius: 8px;
}

.input {
  font-size: 12px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  min-width: 0;
  flex: 1;
}

.input.range {
  padding: 0;
  border: none;
  accent-color: var(--text-2);
}

[data-theme='jarvis'] .input.range {
  accent-color: var(--accent);
}
</style>
