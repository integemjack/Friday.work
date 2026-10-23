<script setup lang="ts">
// 设置窗口（M4）：两个 tab——「机器」（这台远程机器的引擎、Agent 设置、服务状态，只读）
// 和「语音播报」（回复 TTS：开关、音色、自定义音色、模型下载）。
// 语音播报是本机行为（本地 kokoro 模型合成），不依赖连接哪台机器。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'
import { loadTheme, setTheme, type UITheme } from '../lib/theme.js'
import {
  clonedVoices,
  cloneSupported,
  cosyVoiceReady,
  cosyVoiceStatus,
  currentVoiceId,
  PRESET_VOICES,
  previewVoice,
  refreshCosyVoiceStatus,
  replySpeakEnabled,
  setCurrentVoice,
  setReplySpeak,
  setTtsBackgroundVoiceSwap,
  setTtsBackgroundVolume,
  setTtsFollowBubble,
  setTtsSpatialHeadphones,
  setTtsDynamicSpeed,
  setTtsSpeed,
  setTtsSpeedMax,
  setTtsSpeedMin,
  stopSpeaking,
  ttsBackgroundVoiceSwap,
  ttsBackgroundVolume,
  ttsFollowBubble,
  ttsSpatialHeadphones,
  ttsDetail,
  ttsDynamicSpeed,
  ttsPhase,
  ttsSpeed,
  ttsSpeedMax,
  ttsSpeedMin,
  type VoiceOption
} from '../lib/speechOutput.js'
import { resample } from '../lib/voiceMedia.js'
import { autoCallEnabled, setAutoCall } from '../lib/autoCall.js'
import { CAPABILITY_LABEL, deviceGrants, revokeGrant } from '../lib/devices/grants.js'

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

// MARK: 语音播报（tab=speech）：开关 / 音色（内置 + 克隆）/ 克隆向导 / 模型下载
// 2026-10 收敛：语音只剩 friday-voice 引擎一条路（CosyVoice3 + 克隆），kokoro 和本地
// sherpa-onnx 系列已删；「自定义音色」变成「克隆自己的声音」（引擎 v0.5）。

/** 全部可选音色：引擎内置 5 个 + 克隆的（克隆的排后面，可删） */
const allVoices = computed<VoiceOption[]>(() => [...PRESET_VOICES, ...clonedVoices.value])

/** 语速滑条（0.5×–2×）：v-model 双向，写入走 setTtsSpeed（localStorage 持久化 + 钳制） */
const speedValue = computed<number>({
  get: () => ttsSpeed.value,
  set: (value: number) => setTtsSpeed(value)
})

/** 最慢 / 最快（动态语速的两端）：互钳在 setter 里，两行永远自洽 */
const speedMinValue = computed<number>({
  get: () => ttsSpeedMin.value,
  set: (value: number) => setTtsSpeedMin(value)
})
const speedMaxValue = computed<number>({
  get: () => ttsSpeedMax.value,
  set: (value: number) => setTtsSpeedMax(value)
})

/** 后台会话音量（0–100%）：前台说话时后台压到这么低；0 = 后台会话不播 */
const backgroundVolumeValue = computed<number>({
  get: () => ttsBackgroundVolume.value,
  set: (value: number) => setTtsBackgroundVolume(value)
})

/** 克隆模型（前端两个 ONNX）还没装：向导里提醒首次会先下 ~260MB */
const cloneModelHint = computed(() => (cloneSupported.value ? '' : '（首次克隆会先下载前端模型约 260MB）'))

/** 模型状态文案（下载/解压/加载/出错） */
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

// MARK: 引擎状态 / 下载

const cv3StateText = computed(() => {
  const status = cosyVoiceStatus.value
  if (!status) return '状态读取中…'
  if (!status.supported) return '本机平台没有对应的引擎包'
  if (!status.installed) return '未下载（约 1.2GB，本机 GPU 推理）'
  if (status.serving) return '已就绪（引擎在跑）'
  return `已下载（${status.voices.length} 个音色，念第一句时启动引擎）`
})
const cv3Downloaded = computed(() => cosyVoiceStatus.value?.installed ?? false)
const cv3Supported = computed(() => cosyVoiceStatus.value?.supported ?? false)

function downloadCosyVoice(): void {
  void window.fridayBridge.prefetchCosyVoice?.().catch(() => {})
}

onMounted(() => void refreshCosyVoiceStatus())

// MARK: 克隆我的声音（8~15 秒录音 → 引擎提取 → 出现在音色列表）

const cloneOpen = ref(false)
const cloneName = ref('')
const cloneRecording = ref(false)
const cloneSeconds = ref(0)
/** 录完待提取的音频（16 kHz Float32）；空 = 还没录 */
const cloneAudio = ref<Float32Array | null>(null)
const cloneBusy = ref(false)
const cloneError = ref('')
const cloneDone = ref('')
/** 克隆模型下载进度（onVoiceModelProgress 的百分比；克隆首次会先下 ~260MB 前端模型） */
const cloneProgress = ref('')

let cloneStream: MediaStream | null = null
let cloneContext: AudioContext | null = null
let cloneProcessor: ScriptProcessorNode | null = null
let cloneFrames: Float32Array[] = []
let cloneProgressOff: (() => void) | null = null

async function startCloneRecording(): Promise<void> {
  cloneError.value = ''
  cloneDone.value = ''
  cloneAudio.value = null
  try {
    cloneStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    cloneFrames = []
    cloneSeconds.value = 0
    cloneContext = new AudioContext()
    const source = cloneContext.createMediaStreamSource(cloneStream)
    cloneProcessor = cloneContext.createScriptProcessor(2048, 1, 1)
    const context = cloneContext
    cloneProcessor.onaudioprocess = (event) => {
      const frame = resample(event.inputBuffer.getChannelData(0), context.sampleRate, 16000)
      cloneFrames.push(frame)
      cloneSeconds.value = cloneFrames.reduce((n, f) => n + f.length, 0) / 16000
    }
    source.connect(cloneProcessor)
    cloneProcessor.connect(cloneContext.destination)
    cloneRecording.value = true
  } catch (error) {
    // getUserMedia 成功但 AudioContext/处理器建不起来时，把刚拿到的流停掉再报错，
    // 不然麦克风一直占着
    for (const track of cloneStream?.getTracks() ?? []) track.stop()
    cloneStream = null
    void cloneContext?.close().catch(() => {})
    cloneContext = null
    cloneProcessor = null
    cloneError.value = `麦克风开不起来：${error instanceof Error ? error.message : String(error)}`
  }
}

function stopCloneRecording(): void {
  cloneRecording.value = false
  const total = new Float32Array(cloneFrames.reduce((n, f) => n + f.length, 0))
  let at = 0
  for (const frame of cloneFrames) {
    total.set(frame, at)
    at += frame.length
  }
  cloneFrames = []
  cloneAudio.value = total
  cloneProcessor?.disconnect()
  cloneProcessor = null
  for (const track of cloneStream?.getTracks() ?? []) track.stop()
  cloneStream = null
  void cloneContext?.close().catch(() => {})
  cloneContext = null
}

async function extractClone(): Promise<void> {
  const audio = cloneAudio.value
  if (!audio || audio.length < 16000 * 3) {
    cloneError.value = '录音太短（至少 3 秒，建议 8~15 秒）'
    return
  }
  const name = (cloneName.value.trim() || 'my-voice').replace(/[\\/:*?"<>|\s.]/g, '-').slice(0, 60)
  cloneBusy.value = true
  cloneError.value = ''
  cloneProgressOff?.()
  cloneProgressOff = window.fridayBridge.onVoiceModelProgress?.((state) => {
    cloneProgress.value =
      state.phase === 'downloading'
        ? state.percent !== undefined ? `${state.detail ?? '克隆模型下载中'} ${state.percent}%` : (state.detail ?? '克隆模型下载中')
        : state.phase === 'loading'
          ? '启动语音引擎…'
          : ''
  }) ?? null
  try {
    // 没给 text：引擎用 SenseVoice 听写当底稿（念什么都行）
    const result = await window.fridayBridge.cloneVoice({ name, audio })
    cloneDone.value = `已克隆「${result.name}」（${result.seconds.toFixed(1)} 秒录音，用时 ${result.took.toFixed(1)} 秒）`
    cloneAudio.value = null
    cloneName.value = ''
    cloneOpen.value = false
    await refreshCosyVoiceStatus()
    setCurrentVoice(`cv3:${result.voice}`)
    // 克隆完直接试听一句（voice 是引擎侧安全名，name 才是用户起的名字）
    const option = clonedVoices.value.find((v) => v.id === `cv3:${result.voice}`)
    previewVoice(option ?? { id: `cv3:${result.voice}`, name: result.name, tag: '克隆', voice: result.voice, speed: 1.0, custom: true })
  } catch (error) {
    cloneError.value = error instanceof Error ? error.message : String(error)
  } finally {
    cloneBusy.value = false
    cloneProgress.value = ''
    cloneProgressOff?.()
    cloneProgressOff = null
  }
}

async function deleteClone(voice: VoiceOption): Promise<void> {
  try {
    await window.fridayBridge.deleteVoice(voice.voice)
    await refreshCosyVoiceStatus()
  } catch (error) {
    cloneError.value = error instanceof Error ? error.message : String(error)
  }
}

// MARK: 导入现成音色 gguf（拖拽 / 选文件）：复制进 user-voices 持久化，重启客户端仍在

const importOver = ref(false) // 拖拽悬停高亮
const importBusy = ref(false)
const importDone = ref('')
const importError = ref('')
const importProgress = ref('')
let importProgressOff: (() => void) | null = null

/** 导入结果的展示（拖拽和选文件共用）：成功提示持久化、失败逐个给原因，刷新音色列表 */
async function applyImportResult(result: { imported: string[]; failed: { file: string; error: string }[] }): Promise<void> {
  importDone.value = result.imported.length
    ? `已导入 ${result.imported.join('、')}（存在本机 user-voices，重启后仍在，可删）`
    : ''
  importError.value = result.failed.map((f) => `${f.file}：${f.error}`).join('；')
  await refreshCosyVoiceStatus()
  // 第一个导入成功的自动选上（和克隆完自动切换一致）；没有成功的保持原选择
  const first = result.imported[0]
  if (first && allVoices.value.some((voice) => voice.id === `cv3:${first}`)) setCurrentVoice(`cv3:${first}`)
}

/** 拖拽导入：只认 .gguf；导入中引擎会启动验证（首次几秒，进度行有提示） */
async function importVoiceFiles(files: File[]): Promise<void> {
  const ggufs = files.filter((file) => /\.gguf$/i.test(file.name))
  if (!ggufs.length) {
    importError.value = '只认 .gguf 音色文件（克隆导出的那种，几百 KB）'
    return
  }
  importBusy.value = true
  importError.value = ''
  importDone.value = ''
  importProgress.value = '导入中…（旧版引擎会先自动升级）'
  importProgressOff?.()
  importProgressOff =
    window.fridayBridge.onVoiceModelProgress?.((state) => {
      // 下载中 = 自动升级引擎（约 20MB）或补模型；loading = 起引擎验证导入的音色
      importProgress.value =
        state.phase === 'downloading'
          ? `${state.detail ?? '下载中'}${state.percent !== undefined ? ` ${state.percent}%` : ''}`
          : state.phase === 'loading'
            ? '启动语音引擎验证…'
            : ''
    }) ?? null
  try {
    await applyImportResult(await window.fridayBridge.importVoiceFiles(ggufs))
  } catch (error) {
    importError.value = error instanceof Error ? error.message : String(error)
  } finally {
    importBusy.value = false
    importProgress.value = ''
    importProgressOff?.()
    importProgressOff = null
  }
}

// 录音/导入进行中直接关掉设置窗口（卸载组件）：麦克风轨道、AudioContext、进度监听全要释放，
// 不然麦克风指示灯常亮、监听越积越多
onBeforeUnmount(() => {
  if (cloneRecording.value) stopCloneRecording()
  cloneProgressOff?.()
  cloneProgressOff = null
  importProgressOff?.()
  importProgressOff = null
})

function onVoiceDrop(event: DragEvent): void {
  importOver.value = false
  if (importBusy.value) return
  void importVoiceFiles(Array.from(event.dataTransfer?.files ?? []))
}

/** 点击拖拽框：主进程弹文件选择框（拖不了的时候用鼠标选） */
async function pickVoiceFiles(): Promise<void> {
  if (importBusy.value) return
  importBusy.value = true
  importError.value = ''
  importDone.value = ''
  try {
    const result = await window.fridayBridge.pickVoiceFiles()
    if (!result.canceled) await applyImportResult(result)
  } catch (error) {
    importError.value = error instanceof Error ? error.message : String(error)
  } finally {
    importBusy.value = false
  }
}
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
    <div class="note intro">来自 {{ machine?.name ?? '（未连接）' }} 的只读信息。</div>
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

    <section>
      <h3>通话</h3>
      <div class="row">
        <span class="key">进入工作台自动视频通话</span>
        <span class="value">
          <button class="small-btn" :class="{ strong: autoCallEnabled }" @click="setAutoCall(true)">开</button>
          <button class="small-btn" :class="{ strong: !autoCallEnabled }" @click="setAutoCall(false)">关</button>
        </span>
      </div>
      <div class="note">默认关：连上机器不自动拨打，想通话用聊天头部的视频/语音按钮。打开后进入工作台会自动与助手 bot 建立视频通话，挂断不重拨，断线弄断的会自动接回。</div>
    </section>

    <section>
      <h3>本机设备授权</h3>
      <div v-if="!deviceGrants.list.length" class="empty-line">没有「始终允许」的设备</div>
      <div v-for="grant in deviceGrants.list" :key="`${grant.machineID}|${grant.capability}|${grant.deviceId}`" class="row">
        <span class="key">{{ grant.machineName }} · {{ CAPABILITY_LABEL[grant.capability] }}</span>
        <span class="value">
          {{ grant.deviceLabel }}
          <button class="small-btn" @click="revokeGrant(grant)">撤销</button>
        </span>
      </div>
      <div class="note">远端机器要用本机的串口 / 摄像头 / 烧录时会先问你；选了「始终允许」的记在这里，撤销后下次再问。</div>
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
      <div class="note">回复完成时用本地语音引擎朗读文字部分（代码块、链接不念），完全离线、不联网、不花钱。首次使用会自动下载模型（约 1.2GB，本机 GPU 推理），之后不再下载。</div>

      <div class="row">
        <span class="key">语速调节</span>
        <span class="value">
          <button class="small-btn" :class="{ strong: ttsDynamicSpeed }" @click="setTtsDynamicSpeed(true)">动态</button>
          <button class="small-btn" :class="{ strong: !ttsDynamicSpeed }" @click="setTtsDynamicSpeed(false)">固定</button>
        </span>
      </div>

      <div v-if="!ttsDynamicSpeed" class="row">
        <span class="key">语速</span>
        <span class="value range-cell">
          <input v-model.number="speedValue" class="input range" type="range" min="0.5" max="2" step="0.05" />
          <span class="range-val">{{ ttsSpeed.toFixed(2) }}×</span>
        </span>
      </div>
      <template v-else>
        <div class="row">
          <span class="key">最慢语速</span>
          <span class="value range-cell">
            <input v-model.number="speedMinValue" class="input range" type="range" min="0.5" max="2" step="0.05" />
            <span class="range-val">{{ ttsSpeedMin.toFixed(2) }}×</span>
          </span>
        </div>
        <div class="row">
          <span class="key">最快语速</span>
          <span class="value range-cell">
            <input v-model.number="speedMaxValue" class="input range" type="range" min="0.5" max="2" step="0.05" />
            <span class="range-val">{{ ttsSpeedMax.toFixed(2) }}×</span>
          </span>
        </div>
      </template>
      <div class="note">动态：按本轮要念的字数在最慢~最快之间自动取值——短句从容、长文提速，不用听完漫长的播报；固定：所有句子一个倍率。改动即时保存，正在念的这句不变、下一句生效。</div>

      <div class="row">
        <span class="key">后台会话音量</span>
        <span class="value range-cell">
          <input v-model.number="backgroundVolumeValue" class="input range" type="range" min="0" max="1" step="0.05" />
          <span class="range-val">{{ ttsBackgroundVolume === 0 ? '不播' : `${Math.round(ttsBackgroundVolume * 100)}%` }}</span>
        </span>
      </div>
      <div class="row">
        <span class="key">后台换音色</span>
        <span class="value">
          <button class="small-btn" :class="{ strong: ttsBackgroundVoiceSwap }" @click="setTtsBackgroundVoiceSwap(true)">开</button>
          <button class="small-btn" :class="{ strong: !ttsBackgroundVoiceSwap }" @click="setTtsBackgroundVoiceSwap(false)">关</button>
        </span>
      </div>
      <div class="row">
        <span class="key">声音跟随气泡</span>
        <span class="value">
          <button class="small-btn" :class="{ strong: ttsFollowBubble }" @click="setTtsFollowBubble(true)">开</button>
          <button class="small-btn" :class="{ strong: !ttsFollowBubble }" @click="setTtsFollowBubble(false)">关</button>
        </span>
      </div>
      <div class="row">
        <span class="key">耳机空间音频</span>
        <span class="value">
          <button class="small-btn" :class="{ strong: ttsSpatialHeadphones }" @click="setTtsSpatialHeadphones(true)">开</button>
          <button class="small-btn" :class="{ strong: !ttsSpatialHeadphones }" @click="setTtsSpatialHeadphones(false)">关</button>
        </span>
      </div>
      <div class="note">几个会话同时回复时一起念：正在看的会话居中、原声；其他会话偏到左右一侧，前台说话时压到这个音量、前台安静时稍抬高。同一时刻最多再加一个后台会话，其余的排队。后台换音色：后台自动用一个和前台不同的快音色，好分辨，也少占本机合成。调到「不播」就只念正在看的会话。排队超过半分钟（或积压太多）的后台会话不再逐字念，只说一句「XX 有新回复」。声音跟随气泡：后台会话从它在桌面上的回复气泡那一侧出声；关掉则每个会话固定在左右某一侧。耳机空间音频：戴耳机时打开，声音有前后高低的方位感（HRTF）；用音箱外放请关着。</div>

      <div class="row">
        <span class="key">语音引擎</span>
        <span class="value">
          <span>{{ cv3StateText }}</span>
          <button v-if="cv3Supported && !cv3Downloaded" class="small-btn" :disabled="ttsPhase === 'downloading'" @click="downloadCosyVoice">
            {{ ttsPhase === 'downloading' ? '下载中…' : '下载（约 1.2GB）' }}
          </button>
        </span>
      </div>
      <div class="note">friday-voice（与服务端同一套）：CosyVoice3 合成 + SenseVoice/Whisper 听写，本机 GPU（Vulkan）推理。听写（输入框麦克风）和播报共用这一个引擎、同一批模型。</div>

      <h3 class="sub">音色（引擎内置 5 种 + 克隆的）</h3>
      <div class="voice-grid">
        <button
          v-for="voice in allVoices"
          :key="voice.id"
          class="voice-item"
          :class="{ active: currentVoiceId === voice.id }"
          @click="setCurrentVoice(voice.id)"
        >
          <span class="voice-name">{{ voice.name }}</span>
          <span class="voice-meta">{{ voice.tag }}{{ !cosyVoiceReady ? '（引擎未下载）' : '' }}</span>
          <span class="voice-actions">
            <span class="voice-mini" role="button" title="试听这个音色" @click.stop="previewVoice(voice)">试听</span>
            <span
              v-if="voice.custom"
              class="voice-mini danger"
              role="button"
              title="删掉这个克隆音色"
              @click.stop="deleteClone(voice)"
              >删除</span
            >
          </span>
        </button>
        <button class="voice-item add" @click="cloneOpen = !cloneOpen">
          <span class="voice-name">+ 克隆我的声音</span>
          <span class="voice-meta">念 8~15 秒，全程本地提取</span>
        </button>
      </div>

      <!-- 导入现成音色 gguf（拖拽优先，点击弹选择框）：和克隆同格式，存 user-voices 持久化 -->
      <div
        class="voice-drop"
        :class="{ over: importOver, busy: importBusy }"
        title="克隆导出的音色 gguf（几百 KB），拖进来或点击选择文件"
        @dragover.prevent
        @dragenter.prevent="importOver = true"
        @dragleave.prevent="importOver = false"
        @drop.prevent="onVoiceDrop"
        @click="pickVoiceFiles"
      >
        <span class="voice-name">{{ importBusy ? '导入中…' : '拖入 .gguf 音色文件' }}</span>
        <span class="voice-meta">克隆导出的音色；点击也可选择文件；导入后存在本机，重启不丢</span>
        <span v-if="importProgress" class="voice-meta">{{ importProgress }}</span>
        <span v-if="importDone" class="voice-meta ok">{{ importDone }}</span>
        <span v-if="importError" class="voice-meta danger">{{ importError }}</span>
      </div>

      <div v-if="cloneOpen" class="voice-draft">
        <div class="note" style="padding-top: 0">在安静环境里用平常说话的语气念 8~15 秒（念什么都行，引擎会自动听写当底稿）；太短效果差，太长没有增益。{{ cloneModelHint }}</div>
        <div class="row">
          <span class="key">音色名</span>
          <input v-model="cloneName" class="input" maxlength="20" placeholder="比如：我的声音（默认 my-voice）" />
        </div>
        <div class="update-actions">
          <button v-if="!cloneRecording && !cloneAudio" class="small-btn" :disabled="cloneBusy || !cv3Downloaded" @click="startCloneRecording">
            开始录音
          </button>
          <button v-if="cloneRecording" class="small-btn strong" @click="stopCloneRecording">结束（{{ cloneSeconds.toFixed(1) }}s）</button>
          <button v-if="cloneAudio && !cloneRecording" class="small-btn" :disabled="cloneBusy" @click="cloneAudio = null">重录</button>
          <button v-if="cloneAudio && !cloneRecording" class="small-btn strong" :disabled="cloneBusy" @click="extractClone">
            {{ cloneBusy ? '提取中…' : '提取音色' }}
          </button>
        </div>
        <div v-if="cloneRecording" class="note">正在录…（{{ cloneSeconds.toFixed(1) }} 秒）</div>
        <div v-else-if="cloneAudio && !cloneBusy" class="note">已录 {{ cloneSeconds.toFixed(1) }} 秒，可以提取（或重录）。</div>
        <div v-if="cloneProgress" class="note">{{ cloneProgress }}</div>
        <div v-if="cloneDone" class="note">{{ cloneDone }}</div>
        <div v-if="cloneError" class="error">{{ cloneError }}</div>
      </div>

      <h3 class="sub">本地语音模型</h3>
      <div class="row">
        <span class="key">模型</span>
        <span class="value">friday-voice · CosyVoice3 Q8（合成）+ SenseVoice/Whisper turbo（听写）· 本机 GPU</span>
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
        <button v-else-if="!modelReady" class="small-btn" @click="downloadCosyVoice()">重试下载</button>
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

/* 机器页顶上那句来源说明：和下面第一个分区标题拉开（原来贴着，贾维斯下两行字几乎叠在一起） */
.note.intro {
  padding-top: 0;
  margin-bottom: 14px;
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

/* 拖拽导入音色 gguf：整块都是拖放目标（子元素不接鼠标事件，dragleave 才不闪烁） */
.voice-drop {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1.5px dashed var(--border);
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}

.voice-drop > * {
  pointer-events: none;
}

.voice-drop:hover:not(.busy),
.voice-drop.over {
  border-color: var(--text-2);
  background: var(--chip);
}

.voice-drop.busy {
  cursor: default;
  opacity: 0.75;
}

[data-theme='jarvis'] .voice-drop:hover:not(.busy),
[data-theme='jarvis'] .voice-drop.over {
  border-color: var(--accent);
  box-shadow: 0 0 10px var(--accent-a15);
}

.voice-meta.ok {
  color: var(--text-2);
}

.voice-meta.danger {
  color: var(--fail);
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

/* 语速行：滑条 + 当前倍率值并排 */
.range-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.range-cell .input.range {
  flex: 1;
  max-width: 260px;
}

.range-val {
  flex: 0 0 auto;
  min-width: 44px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

[data-theme='jarvis'] .input.range {
  accent-color: var(--accent);
}
</style>
