// 助手回复的语音播报（输出侧）：偏好（开关 / 音色 / 克隆音色）、回复文本的朗读清理、
// WebAudio 播放与打断。合成在主进程的 friday-voice 引擎（CosyVoice3，本机 GPU/Vulkan），
// 这里只管「播什么、用哪个音色播、什么时候停」。
//
// 2026-10 收敛：kokoro（CPU、103 音色）和本地 sherpa-onnx 系列都删了，语音只剩
// friday-voice 引擎一条链路——五个内置音色 + 用户克隆的音色（v0.5，8~15 秒录音
// 本地提取）。引擎没下好时不再有回落，状态行提示下载（自动在后台拉）。
//
// CosyVoice3 那五个的排序是实测来的（RTX 2060、Vulkan、同一句 5 句连播）：
// default / lively-female RTF 0.52-0.74、首块 0.53-0.82s（边播边合成完全跟得上）；
// gentle-female RTF 1.04-1.08（临界）；两个男声 RTF 1.15-1.30（长句会断 0.3s）。
// 同一句话在 CUDA 后端是 RTF 1.42-1.56、首块 1.6-1.8s（会断流），所以引擎走 Vulkan。
//
// 偏好落 localStorage（本机 UI 偏好，和主题一样：这台机器上的客户端行为，不随远程机器变）。

import { ref, type Ref } from 'vue'
import { blockCase, blockPayload, type MessageBlock } from '../../../protocol/rpc/protocol.js'

// MARK: 音色

export interface VoiceOption {
  /** 稳定 id（预置 = cv3:<音色名>；克隆音色同名同 id，引擎删了就回落） */
  id: string
  name: string
  /** 界面上标注的性别/来源 */
  tag: string
  /** 引擎的音色名（voices/<name>.gguf） */
  voice: string
  /** 自然语言语气指令（空 = 平常念法；CosyVoice3 独有） */
  instruction?: string
  /** 语速倍率（1 = 原速；实测 speed 越大时长越短、说得越快：0.9/1.0/1.2 → 2.10s/1.87s/1.59s） */
  speed: number
  /** 克隆出来的音色（引擎 user-voices 里，可删） */
  custom?: boolean
}

/** 预置：引擎随包带的五个（本机 GPU、音质最自然；排序实测见头注释） */
export const PRESET_VOICES: VoiceOption[] = [
  { id: 'cv3:default', name: '素绢', tag: '女声 · 默认', voice: 'default', speed: 1.0 },
  { id: 'cv3:lively-female', name: '朗晴', tag: '女声 · 明快', voice: 'lively-female', speed: 1.0 },
  { id: 'cv3:gentle-female', name: '柔蓝', tag: '女声 · 温柔', voice: 'gentle-female', speed: 1.0 },
  { id: 'cv3:young-male', name: '晓川', tag: '男声', voice: 'young-male', speed: 1.0 },
  { id: 'cv3:calm-male', name: '砂青', tag: '男声 · 沉稳', voice: 'calm-male', speed: 1.0 }
]

// MARK: 偏好（localStorage + 响应式单例；设置页和聊天面板共用）

const KEY_ENABLED = 'voice.replySpeak'
const KEY_CURRENT = 'voice.tts.current'
const KEY_SPEED = 'voice.tts.speed'
const KEY_SPEED_DYNAMIC = 'voice.tts.speedDynamic'
const KEY_SPEED_MIN = 'voice.tts.speedMin'
const KEY_SPEED_MAX = 'voice.tts.speedMax'
const KEY_MUTED = 'voice.tts.muted'
const KEY_VOLUME = 'voice.tts.volume'
const KEY_SINK = 'voice.tts.sink'

/** 回复语音播报总开关（默认开；合成本地免费、不联网，开着没有成本） */
export const replySpeakEnabled = ref<boolean>(loadEnabled())

/** 当前选中的音色 id */
export const currentVoiceId = ref<string>(loadCurrentId())

/** 全局语速倍率（设置页可调、localStorage 持久化；乘在音色自带语速上，改完下一句生效）。
 *  动态语速开着时不用它，改用最慢/最快区间按本轮文本长度插值 */
export const ttsSpeed = ref<number>(loadSpeed())
/** 动态语速：按本轮要念的字数在最慢~最快之间自动取值（短句从容、长文提速） */
export const ttsDynamicSpeed = ref<boolean>(loadDynamic())
/** 动态语速下限（短回复用的倍率） */
export const ttsSpeedMin = ref<number>(loadSpeedBound(KEY_SPEED_MIN, 0.9))
/** 动态语速上限（长回复用的倍率） */
export const ttsSpeedMax = ref<number>(loadSpeedBound(KEY_SPEED_MAX, 1.6))
/** 静音：波形照走、gain 归零，但不停止播报队列（取消静音能接回正在念的那句） */
export const ttsMuted = ref<boolean>(loadMuted())
/** 音量 0-1（1 = 引擎原声；作用在播放链的 GainNode 上，播报中途拖动也即时生效） */
export const ttsVolume = ref<number>(loadVolume())
/** 输出设备 id（'' = 系统默认；落到 AudioContext.setSinkId，选了具体设备重启后仍走它） */
export const ttsSinkId = ref<string>(loadSinkId())

/** 引擎是否可用（本机平台有包且已下好） */
export const cosyVoiceReady = ref(false)
export const cosyVoiceStatus = ref<{ supported: boolean; installed: boolean; serving: boolean; voices: string[]; version: string } | null>(null)

/** 克隆出来的音色（引擎 user-voices；listVoices 动态拉，删了跟着少） */
export const clonedVoices = ref<VoiceOption[]>([])
/** 克隆能力：前端模型装了没有（没装时设置页给「先下载再克隆」） */
export const cloneSupported = ref(false)

/** 拉一次引擎状态 + 音色列表（启动时、下载后、克隆/删除后调） */
export async function refreshCosyVoiceStatus(): Promise<void> {
  try {
    const status = await window.fridayBridge.cosyVoiceStatus()
    cosyVoiceStatus.value = status
    cosyVoiceReady.value = status.supported && status.installed
  } catch {
    cosyVoiceReady.value = false
  }
  let listAuthoritative = false
  try {
    const [voices, clone] = await Promise.all([window.fridayBridge.listVoices(), window.fridayBridge.cloneVoiceStatus()])
    // user 是引擎侧 ASCII 安全名（引擎在 Windows 会把中文名落盘成 GBK 乱码）；
    // 显示名从主进程的映射（voice-names.json）换回来，列表/选中/删除用安全名、展示用显示名
    clonedVoices.value = voices.user.map((name) => ({
      id: `cv3:${name}`,
      name: voices.userDisplay?.[name] ?? name,
      tag: '克隆',
      voice: name,
      speed: 1.0,
      custom: true
    }))
    cloneSupported.value = clone.installed
    listAuthoritative = true
  } catch {
    // 引擎没在跑：克隆列表清空（下次刷新对齐），但不动选中的音色——
    // 引擎临时没起（模型在下载 / 服务还没拉起）不代表克隆被删了，
    // 此时把选择重置成默认还会写进 localStorage，把用户的选择永久抹掉
    clonedVoices.value = []
  }
  // 只在拿到了引擎权威列表时才回落：选中的音色确实不在了（引擎侧被删 / 旧缓存 kokoro id）
  if (listAuthoritative && !allVoices().some((voice) => voice.id === currentVoiceId.value)) {
    setCurrentVoice(PRESET_VOICES[0].id)
  }
}

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(KEY_ENABLED) !== '0'
  } catch {
    return true
  }
}

function loadCurrentId(): string {
  try {
    const saved = localStorage.getItem(KEY_CURRENT)
    if (saved && PRESET_VOICES.some((voice) => voice.id === saved)) return saved
    // 克隆音色也保留：它的列表是启动后异步从引擎拉的（refreshCosyVoiceStatus），
    // 模块初始化时 clonedVoices 还是空——不保留的话重启就回落默认，选择永久丢失。
    // 保留后列表没到前 activeVoice() 临时用预置播，列表到了自然对上；
    // 真被删了由 refreshCosyVoiceStatus 的成功路径回落。旧 kokoro id 不属于这两类 → 默认
    if (saved && saved.startsWith('cv3:')) return saved
  } catch {
    // localStorage 不可用：默认
  }
  return PRESET_VOICES[0].id
}

function loadSpeed(): number {
  try {
    const raw = Number(localStorage.getItem(KEY_SPEED))
    return Number.isFinite(raw) && raw > 0 ? Math.min(2, Math.max(0.5, raw)) : 1
  } catch {
    return 1
  }
}

function loadDynamic(): boolean {
  try {
    return localStorage.getItem(KEY_SPEED_DYNAMIC) === '1'
  } catch {
    return false
  }
}

/** 最慢/最快语速的加载（合法区间 0.5-2；顺便保证 min ≤ max） */
function loadSpeedBound(key: string, fallback: number): number {
  try {
    const raw = Number(localStorage.getItem(key))
    return Number.isFinite(raw) && raw > 0 ? Math.min(2, Math.max(0.5, raw)) : fallback
  } catch {
    return fallback
  }
}

function loadMuted(): boolean {
  try {
    return localStorage.getItem(KEY_MUTED) === '1'
  } catch {
    return false
  }
}

function loadVolume(): number {
  try {
    const raw = Number(localStorage.getItem(KEY_VOLUME))
    return Number.isFinite(raw) && raw > 0 ? Math.min(1, Math.max(0, raw)) : 1
  } catch {
    return 1
  }
}

function loadSinkId(): string {
  try {
    return localStorage.getItem(KEY_SINK) ?? ''
  } catch {
    return ''
  }
}

function allVoices(): VoiceOption[] {
  return [...PRESET_VOICES, ...clonedVoices.value]
}

/** 当前生效的音色（克隆音色被删后回落到预置第一个） */
export function activeVoice(): VoiceOption {
  return allVoices().find((voice) => voice.id === currentVoiceId.value) ?? PRESET_VOICES[0]
}

export function setReplySpeak(enabled: boolean): void {
  replySpeakEnabled.value = enabled
  try {
    localStorage.setItem(KEY_ENABLED, enabled ? '1' : '0')
  } catch {
    // 不可写：本次会话内生效即可
  }
  if (!enabled) stopSpeaking()
}

export function setCurrentVoice(id: string): void {
  currentVoiceId.value = id
  try {
    localStorage.setItem(KEY_CURRENT, id)
  } catch {
    // 不可写：本次会话内生效即可
  }
}

export function setTtsSpeed(value: number): void {
  ttsSpeed.value = Math.min(2, Math.max(0.5, value))
  try {
    localStorage.setItem(KEY_SPEED, String(ttsSpeed.value))
  } catch {
    // 不可写：本次会话内生效即可
  }
}

export function setTtsDynamicSpeed(on: boolean): void {
  ttsDynamicSpeed.value = on
  try {
    localStorage.setItem(KEY_SPEED_DYNAMIC, on ? '1' : '0')
  } catch {
    // 不可写：本次会话内生效即可
  }
}

export function setTtsSpeedMin(value: number): void {
  ttsSpeedMin.value = Math.min(2, Math.max(0.5, value))
  // 互钳：最慢不能超过最快（超过就把最快抬上来，两个设置永远自洽）
  if (ttsSpeedMin.value > ttsSpeedMax.value) setTtsSpeedMax(ttsSpeedMin.value)
  try {
    localStorage.setItem(KEY_SPEED_MIN, String(ttsSpeedMin.value))
  } catch {
    // 不可写：本次会话内生效即可
  }
}

export function setTtsSpeedMax(value: number): void {
  ttsSpeedMax.value = Math.min(2, Math.max(0.5, value))
  if (ttsSpeedMax.value < ttsSpeedMin.value) setTtsSpeedMin(ttsSpeedMax.value)
  try {
    localStorage.setItem(KEY_SPEED_MAX, String(ttsSpeedMax.value))
  } catch {
    // 不可写：本次会话内生效即可
  }
}

export function setTtsMuted(muted: boolean): void {
  ttsMuted.value = muted
  try {
    localStorage.setItem(KEY_MUTED, muted ? '1' : '0')
  } catch {
    // 不可写：本次会话内生效即可
  }
  applyOutputGain()
}

export function setTtsVolume(value: number): void {
  ttsVolume.value = Math.min(1, Math.max(0, value))
  try {
    localStorage.setItem(KEY_VOLUME, String(ttsVolume.value))
  } catch {
    // 不可写：本次会话内生效即可
  }
  applyOutputGain()
}

// MARK: 回复文本 → 朗读文本（纯函数，test/speechoutput.test.cjs 直接测）

/** 取消息的 text 块拼成朗读文本（thinking / 工具调用 / 媒体不念） */
export function textBlocksToSpeech(blocks: MessageBlock[] | undefined | null): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => blockCase(block) === 'text')
    .map((block) => {
      const payload = blockPayload<string>(block, 'text')
      return typeof payload === 'string' ? payload : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 朗读前的清理：代码块/行内代码、链接 URL、图片、LaTeX、HTML 标签、markdown 记号
 * 都会糟蹋语音（念出星号、反引号、https://…），只留自然语言；
 * emoji（非 BMP 字符）和控制字符一并去掉，空白压成单个空格。
 */
export function cleanForSpeech(raw: string): string {
  let text = raw
  // 代码块（``` 围栏，可能带语言名）→ 直接去掉（念代码没有意义）
  text = text.replace(/```[\s\S]*?```/g, ' ')
  // LaTeX 公式块与行内公式
  text = text.replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\$[^$\n]+\$/g, ' ')
  // 图片 ![alt](url) 与链接 [text](url)：链接留文字
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // HTML 标签
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
  // 裸 URL（含 www. 开头的）
  text = text.replace(/(?:https?:\/\/|www\.)\S+/g, ' ')
  // 行内代码 → 去掉反引号留内容
  text = text.replace(/`([^`]*)`/g, '$1')
  // markdown 记号：标题 #、强调 * _ ~、引用 >、列表标记、表格竖线与分隔行
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, ' ')
  text = text.replace(/^\s{0,3}>+\s?/gm, ' ')
  text = text.replace(/^\s*[-+*]\s+/gm, ' ')
  text = text.replace(/^\s*\d+[.)]\s+/gm, ' ')
  text = text.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ')
  text = text.replace(/\|/g, ' ')
  text = text.replace(/(\*\*|__|\*|_|~~|===|---)/g, ' ')
  // 控制字符与 emoji：控制符、变体选择符/零宽连接符、BMP 内符号区（✅⭐✂…）、非 BMP（🚀😀…）
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\ufe0f\u200d]/g, ' ')
  text = text.replace(/[\u2600-\u27bf\u2b00-\u2bff]/g, ' ')
  text = text.replace(/[\u{10000}-\u{10FFFF}]/gu, ' ')
  // 空白压成单空格；中文标点前的空白收紧（「了 ，」→「了，」）
  text = text.replace(/\s+/g, ' ')
  text = text.replace(/\s+([，。、！？；：,.!?;:）)])/g, '$1')
  return text.trim()
}

// MARK: 播放（WebAudio；单例 AudioContext，后到的播放打断前面的）

export type TtsPhase = 'idle' | 'downloading' | 'extracting' | 'loading' | 'speaking' | 'error'

/** 播报状态（下载/加载/合成播放中/出错）——聊天面板状态行与设置页共用 */
export const ttsPhase: Ref<TtsPhase> = ref('idle')
export const ttsDetail = ref('')

let audioContext: AudioContext | null = null
let activeSource: AudioBufferSourceNode | null = null
let speakToken = 0
/** 主增益（静音/音量）与波形分析器：播放链固定 source → masterGain → analyser → destination。
 *  analyser 挂在 gain 之后，波形反映的是「实际听到的」——静音即归零、音量小波形也矮。 */
let masterGain: GainNode | null = null
let outputAnalyser: AnalyserNode | null = null

/** 待播片段队列 + 播放泵：整条播报（新回复 / 试听）先清队再入队（后到的优先）；
 *  流式增量（append）只接到队尾、不打断正在播的——回复气泡的文本一片片来，
 *  句子按先后接播，这才是「跟气泡实时」。 */
let speechQueue: string[] = []
let pumping = false
/** 本轮泵指定音色（试听时非空）；流式增量为空 → 每句跟当前选中的音色 */
let pumpVoice: VoiceOption | undefined
/** 本轮逐句送引擎的全局倍率：动态语速开时按本轮要念的总字数插值（流式追加会重算，
 *  后续句子随文本变多自动提速）；关时就是固定 ttsSpeed */
let pumpScale = 1
/** 本轮已入队总字数（含已播完的）：动态语速按整条回复长度取值，不是剩余队列——
 *  否则越播到后面（队列越短）插值出的语速反而越慢 */
let pumpChars = 0
/** 引擎正在合成（stopSpeaking 靠它决定要不要 cancel 引擎里那句） */
let engineBusy = false

/** 重新取本轮的全局倍率（speakText 入队后调）：看本轮一共要念多少字 */
function refreshPumpScale(): void {
  pumpScale = ttsDynamicSpeed.value
    ? dynamicSpeedFor(pumpChars, ttsSpeedMin.value, ttsSpeedMax.value)
    : ttsSpeed.value
}

/** 模型准备进度（主进程事件 → 状态行 / 设置页进度条） */
export function initTtsProgressListener(): void {
  window.fridayBridge?.onTtsModelProgress?.((state) => {
    ttsDetail.value = state.detail ?? ''
    if (state.phase === 'downloading') {
      ttsDetail.value = state.percent !== undefined ? `${state.detail ?? '语音模型下载中'} ${state.percent}%` : (state.detail ?? '语音模型下载中')
      ttsPhase.value = 'downloading'
    } else if (state.phase === 'extracting') {
      ttsPhase.value = 'extracting'
    } else if (state.phase === 'loading') {
      ttsPhase.value = 'loading'
    } else if (state.phase === 'ready') {
      // ready 只意味着模型就绪；此刻若没在播，状态回到 idle（合成很快，speaking 由播放端设置）
      if (ttsPhase.value !== 'speaking') ttsPhase.value = 'idle'
      // 下载/启动完成：刷新状态，音色就能真用上了
      void refreshCosyVoiceStatus()
    } else if (state.phase === 'error') {
      ttsPhase.value = 'error'
    }
  })
}

/** 停掉当前播放并清空待播队列（新整条回复到来 / 开关关闭 / 手动停止时调用）。
 *  引擎正在合成这句时一并 cancel（实测 7ms 就回 cancelled，不会让下一句排队等它）。 */
export function stopSpeaking(): void {
  speakToken += 1
  speechQueue = []
  pumping = false
  if (engineBusy) void window.fridayBridge.cancelCosyVoice?.().catch(() => {})
  if (activeSource) {
    try {
      activeSource.stop()
    } catch {
      // 已自然播完：忽略
    }
    activeSource = null
  }
  if (ttsPhase.value === 'speaking' || ttsPhase.value === 'error') ttsPhase.value = 'idle'
}

/** 建好（或复用）gain→analyser→destination 那段公共链，返回主增益节点 */
function ensureGraph(context: AudioContext): GainNode {
  if (!masterGain || !outputAnalyser) {
    masterGain = context.createGain()
    outputAnalyser = context.createAnalyser()
    outputAnalyser.fftSize = 1024
    outputAnalyser.smoothingTimeConstant = 0.7
    masterGain.connect(outputAnalyser)
    outputAnalyser.connect(context.destination)
    applyOutputGain()
  }
  return masterGain
}

/** 静音/音量落到 GainNode（20ms 平滑防爆音）；播放前、拖动/切换时都会走一遍 */
function applyOutputGain(): void {
  if (!masterGain || !audioContext) return
  const target = ttsMuted.value ? 0 : ttsVolume.value
  masterGain.gain.setTargetAtTime(target, audioContext.currentTime, 0.02)
}

/** 把选中的输出设备落到 AudioContext 的 sink（Chromium 110+ 支持且切换平滑，不中断正在播的）。
 *  context 还没建（还没播过）就只记住选择，建时在 playSamples 里应用；
 *  设备被拔等切换失败：保持原路出声。TS lib 对 setSinkId 没有类型，防御式取。 */
async function applySink(): Promise<void> {
  const ctx = audioContext as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null
  if (!ctx || typeof ctx.setSinkId !== 'function') return
  try {
    await ctx.setSinkId(ttsSinkId.value)
  } catch {
    // 切不过去就算了：继续从当前设备出声
  }
}

export function setTtsSinkId(id: string): void {
  ttsSinkId.value = id
  try {
    localStorage.setItem(KEY_SINK, id)
  } catch {
    // 不可写：本次会话内生效即可
  }
  void applySink()
}

/** 波形数据源（语音 HUD 的 rAF 从这里取时域数据；没播过声音时 AudioContext 还没建 → null） */
export function getTtsAnalyser(): AnalyserNode | null {
  return outputAnalyser
}

function playSamples(samples: Float32Array, sampleRate: number): Promise<void> {
  return new Promise((resolve) => {
    if (!audioContext) {
      audioContext = new AudioContext()
      void applySink() // 新 context 建好立即落到已选的输出设备（'' = 系统默认，无感）
    }
    const context = audioContext
    // Electron 默认 autoplay 无手势要求；被挂起（罕见）时恢复
    if (context.state === 'suspended') void context.resume()
    const gain = ensureGraph(context)
    const buffer = context.createBuffer(1, samples.length, sampleRate)
    buffer.getChannelData(0).set(samples)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(gain)
    source.onended = () => {
      if (activeSource === source) activeSource = null
      resolve()
    }
    activeSource = source
    source.start()
  })
}

/** 分句：按句末标点/换行切，超长句再按逗号顿号切；返回非空片段（首句短、首音快）。
 *  片段逐句送主进程合成（串行队列保序），播放与下一句的合成并行——女声 RTF 0.52-0.74
 *  （Vulkan 实测）< 1，播放追得上合成。firstLimit：首句上限——引擎整句合成完才返回，
 *  首句切短才能把开口压到 2-3 秒；流式追加传 Infinity（句子已在 SpeechIncrement 攒成
 *  完整句，再切只会把一句话剁成两段，合成间隙听感就是「中间停顿分两次说」）。 */
export function splitForSpeech(clean: string, firstLimit = 16): string[] {
  const parts: string[] = []
  // 纯标点/空白不独立成段：兜底硬切和句读残留会切出「，」「。」这类孤儿片段，
  // 引擎对纯标点返回空音频（实测 0B），白耗一次合成往返还留下怪停顿
  const push = (piece: string) => {
    const p = piece.trim()
    if (p && /[^\s，,、。．.！？!?；;：:"'“”‘’()（）\u2026-]/.test(p)) parts.push(p)
  }
  for (const paragraph of clean.split(/\n+/)) {
    const trimmed = paragraph.trim()
    if (!trimmed) continue
    for (const sentence of trimmed.split(/(?<=[。！？!?；;])/)) {
      const s = sentence.trim()
      if (!s) continue
      const limit = parts.length === 0 ? firstLimit : 60
      if (s.length <= limit) {
        push(s)
        continue
      }
      for (const clause of s.split(/(?<=[，,、])/)) {
        const c = clause.trim()
        if (!c) continue
        // 兜底：没有逗号也超长的（罕见，比如一长串无标点文本），按上限硬切（首句更短）；
        // 尾片不足 8 字并入前片——「，」「如下：」这类几个字的孤儿段单独送引擎只会得到
        // 空音频或含混的几个字，拼回前一段整句合成听感才连贯
        const hardLimit = parts.length === 0 ? firstLimit : 60
        const chunks: string[] = []
        for (let at = 0; at < c.length; at += hardLimit) chunks.push(c.slice(at, at + hardLimit))
        if (chunks.length >= 2 && chunks[chunks.length - 1].length < 8) {
          chunks[chunks.length - 2] += chunks.pop()
        }
        for (const chunk of chunks) push(chunk)
      }
    }
  }
  return parts
}

/** 送引擎的语速 = 音色自带倍率 × 全局倍率，夹进安全区间。
 *  CosyVoice3 的 speed 越大越快（实测 0.9/1.0/1.2 → 2.10s/1.87s/1.59s，见头注释）。 */
export function speechSpeedFor(voiceSpeed: number, globalSpeed: number): number {
  const speed = (Number.isFinite(voiceSpeed) && voiceSpeed > 0 ? voiceSpeed : 1) * (Number.isFinite(globalSpeed) && globalSpeed > 0 ? globalSpeed : 1)
  return Math.min(3, Math.max(0.25, speed))
}

/** 动态语速插值（纯函数，test 直测）：按本轮要念的总字数在 min~max 间线性取值——
 *  短回复（≤40 字，一两句话）用最慢，从容；长回复（≥520 字，一大段）用最快，
 *  别让一篇长文念上两分钟；中间线性过渡。字数只在本函数里定义，设置页不暴露 */
export function dynamicSpeedFor(length: number, min: number, max: number): number {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  const t = Math.min(1, Math.max(0, (length - 40) / (520 - 40)))
  return lo + (hi - lo) * t
}

/** 播一段文本（用当前选中的音色；分句流水线：首句 1-2 秒出声，后续句边播边合成）。
 *  整条播报（默认）：停掉并清空正在播的再入队（新回复 / 试听优先）。
 *  流式增量（append: true）：只把片段接到队尾不打断——回复气泡边显示边念，
 *  收尾的整条播报也不冲掉前面还没播完的句子。
 *  开关关着时不播（试听用 force 跳过）。 */
export function speakText(text: string, options?: { voice?: VoiceOption; force?: boolean; append?: boolean }): void {
  // 首句上限只对非流式的整条播报生效（一次性给全文时首句切短、快开口）。
  // 流式 append 的句子已在 SpeechIncrement 攒到自然句边界，一律整句送合成——
  // 再按 16 字切会把每句话剁成「半句 + 孤儿标点」两段，串行合成两遍，中间的
  // 合成间隙听感就是「一句话中间停顿分两次说」（2026-12 修）。
  const firstLimit = options?.append ? Infinity : 16
  const parts = splitForSpeech(cleanForSpeech(text), firstLimit)
  if (!parts.length) return
  if (!options?.force && !replySpeakEnabled.value) return
  if (!options?.append) {
    stopSpeaking() // 先停旧的、清空队列，再取新 token：此后任何新打断都会使 token 失配
    pumpVoice = options?.voice
    pumpChars = 0
  } else if (!pumping) {
    pumpVoice = options?.voice // 泵停着（刚被打断 / 上一轮播完）：这次 append 启动新一轮
    pumpChars = 0
  }
  speechQueue.push(...parts)
  pumpChars += parts.reduce((sum, part) => sum + part.length, 0)
  refreshPumpScale()
  if (!pumping) void pumpSpeech()
}

/** 播放泵：逐句「合成下一句与播放并行」地消费队列（RTF < 1，播放始终追得上合成）；
 *  流式增量随时往队尾加。token 失配（被 stopSpeaking 打断）即退出，
 *  残留队列已由 stopSpeaking 清空。 */
async function pumpSpeech(): Promise<void> {
  const token = speakToken
  pumping = true
  ttsPhase.value = 'loading'
  try {
    const synth = async (text: string) => {
      const voice = pumpVoice ?? activeVoice()
      engineBusy = true
      try {
        // 结尾完全没标点的片段（硬切截断 / 尾句）补个句号收韵律；逗号、冒号等
        // 未完标点结尾的保持原样——引擎实测都能出声，保留自然的未完语气，
        // 别叠加出「，。」「：。」这种连续标点
        const spoken = /[,，、:：;；.。!！?？…]\s*$/.test(text) ? text : `${text}。`
        return await window.fridayBridge.speakReply({
          text: spoken,
          speed: speechSpeedFor(voice.speed, pumpScale),
          voice: voice.voice,
          instruction: voice.instruction
        })
      } finally {
        engineBusy = false
      }
    }
    let next = speechQueue.length ? synth(speechQueue.shift()!) : null
    while (next) {
      const audio = await next
      if (token !== speakToken) return // 等待期间被打断（来了更新的整条回复或手动停止）
      next = speechQueue.length ? synth(speechQueue.shift()!) : null
      if (!audio.samples.length) continue
      ttsPhase.value = 'speaking'
      await playSamples(audio.samples, audio.sampleRate)
      if (token !== speakToken) return
    }
    if (token === speakToken) ttsPhase.value = 'idle'
  } catch (error) {
    if (token === speakToken) {
      ttsPhase.value = 'error'
      ttsDetail.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    // 自然播完才归还泵；被打断的（token 失配）不动 pumping——stopSpeaking 已把它复位，
    // 免得旧泵迟到的 finally 把新一轮泵的标志清掉（那会让后续增量只排队不出声）
    if (token === speakToken) pumping = false
  }
}

// MARK: 流式增量游标（回复气泡的实时播报）

/** 流式增量攒到句边界再入队：增量片常在句中截断，直接播会一字一顿；攒到句末
 *  标点 / 换行才成句送播（append 接队），长时间没有句末标点（无标点长文）就
 *  兜底直送（splitForSpeech 会按逗号 / 60 字硬切，不会憋着不出声）。 */
export interface SpeechIncrement {
  /** 流式又来了一片：接进缓冲，攒出完整句就送播 */
  push(chunk: string): void
  /** 结束（消息完成）：把还没等到句末标点的尾巴整段播完 */
  flush(): void
}

const SENTENCE_END = '。！？!?；;：\n'

export function createSpeechIncrement(): SpeechIncrement {
  let buffer = ''
  return {
    push(chunk: string) {
      if (!chunk) return
      buffer += chunk
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (SENTENCE_END.includes(buffer[i])) {
          speakText(buffer.slice(0, i + 1), { append: true })
          buffer = buffer.slice(i + 1)
          break
        }
      }
      if (buffer.length >= 120) {
        speakText(buffer, { append: true })
        buffer = ''
      }
    },
    flush() {
      if (buffer.trim()) speakText(buffer, { append: true })
      buffer = ''
    }
  }
}

/** 试听一个音色（设置页用；不受总开关影响，播固定例句） */
export function previewVoice(voice: VoiceOption): void {
  void speakText('你好，我是你的工作助手。这是这个音色的试听效果。', { voice, force: true })
}

/** 设置页「立即下载」：拉起引擎（下模型 + serve），不合成 */
export function prefetchTtsModel(): void {
  void window.fridayBridge.prefetchCosyVoice?.()
}
