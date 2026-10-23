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
const KEY_BG_VOLUME = 'voice.tts.bgVolume'
const KEY_BG_VOICE_SWAP = 'voice.tts.bgVoiceSwap'
const KEY_HRTF = 'voice.tts.hrtf'
const KEY_FOLLOW_BUBBLE = 'voice.tts.followBubble'

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
/** 后台会话的音量：前台出声时后台压到这么低（0-1；0 = 后台会话不播） */
export const ttsBackgroundVolume = ref<number>(loadBackgroundVolume())
/** 后台会话自动换一个内置快音色：和前台的声音错开好分辨，也少占引擎 */
export const ttsBackgroundVoiceSwap = ref<boolean>(loadBackgroundVoiceSwap())
/** 耳机空间音频：各路换成 HRTF 定位（戴耳机听得出左右前后和高低；外放会发怪，默认关） */
export const ttsSpatialHeadphones = ref<boolean>(loadFlag(KEY_HRTF, false))
/** 后台会话的声音从它的桌面气泡那边来（关 = 按会话固定在左右某一侧） */
export const ttsFollowBubble = ref<boolean>(loadFlag(KEY_FOLLOW_BUBBLE, true))

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

function loadBackgroundVolume(): number {
  try {
    const saved = localStorage.getItem(KEY_BG_VOLUME)
    const raw = Number(saved)
    // 0 是合法值（后台不播），所以先判有没有存过，不能像音量那样按 > 0 兜底
    return saved !== null && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.25
  } catch {
    return 0.25
  }
}

function loadBackgroundVoiceSwap(): boolean {
  return loadFlag(KEY_BG_VOICE_SWAP, true)
}

/** 开关类偏好：存 '1' / '0'，没存过用默认值 */
function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const saved = localStorage.getItem(key)
    return saved === null ? fallback : saved === '1'
  } catch {
    return fallback
  }
}

function saveFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // 不可写：本次会话内生效即可
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

export function setTtsBackgroundVolume(value: number): void {
  ttsBackgroundVolume.value = Math.min(1, Math.max(0, value))
  try {
    localStorage.setItem(KEY_BG_VOLUME, String(ttsBackgroundVolume.value))
  } catch {
    // 不可写：本次会话内生效即可
  }
  applyMix()
}

export function setTtsBackgroundVoiceSwap(on: boolean): void {
  ttsBackgroundVoiceSwap.value = on
  saveFlag(KEY_BG_VOICE_SWAP, on)
}

export function setTtsSpatialHeadphones(on: boolean): void {
  ttsSpatialHeadphones.value = on
  saveFlag(KEY_HRTF, on)
  rebuildSpatial() // 已建好的各路就地换定位节点，正在说的那句不断
}

export function setTtsFollowBubble(on: boolean): void {
  ttsFollowBubble.value = on
  saveFlag(KEY_FOLLOW_BUBBLE, on)
  applyMix()
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

// MARK: 播放（WebAudio；单例 AudioContext，每个来源一条通道，可同时出声）

export type TtsPhase = 'idle' | 'downloading' | 'extracting' | 'loading' | 'speaking' | 'error'

/** 播报状态（下载/加载/合成播放中/出错）——聊天面板状态行与设置页共用 */
export const ttsPhase: Ref<TtsPhase> = ref('idle')
export const ttsDetail = ref('')

let audioContext: AudioContext | null = null
/** 主增益（静音/音量）与波形分析器：播放链 source → 通道 gain → 通道定位节点（声像 / HRTF） → masterGain → analyser → destination。
 *  analyser 挂在主增益之后，波形反映的是「实际听到的」（各通道混起来）——静音即归零、音量小波形也矮。 */
let masterGain: GainNode | null = null
let outputAnalyser: AnalyserNode | null = null

// 多来源并行播报：每个来源（一个会话 / 助手日志 / 试听）一条通道——自己的待合成队列、
// 已合成待播缓冲、增益和声像节点。前台（正在看的会话或助手、试听）居中原声；后台偏到
// 一侧、前台出声时压低（闪避）。同一时刻最多听到「前台 + 一个后台」：后台按先来后到
// 占麦，占麦的空下来一会儿（等模型 / 跑工具）才让给下一个，免得几个后台一句一句穿插。
//
// 瓶颈是合成不是播放：引擎串行（GPU 并发只会互相拖慢），女声 RTF ~0.6，两路同时播就要
// 1.2，必然断流。所以合成名额在这里排优先级：前台垫着的不够 2 句先给前台，够了才给后台
// 占麦的那个；主进程队列里同时只放一句，优先级才排得上。后台再提速、换快音色少占引擎，
// 偶有停顿也压着音量，不碍事。

/** 未指定来源（试听 / 旧调用方）：恒为前台 */
const DEFAULT_SOURCE = ''
/** 助手日志的来源名（会话 id 是 uuid，不会撞） */
export const ASSISTANT_SPEECH_SOURCE = '__assistant__'
/** 前台多合成几句垫着：后台那句占着引擎时前台不至于断流 */
const FRONT_LOOKAHEAD = 2
const BACK_LOOKAHEAD = 1
/** 后台语速再乘的倍率：说得快 = 合成出的音频短 = 少占引擎 */
const BACKGROUND_SPEED_BOOST = 1.2
/** 前台不出声时后台抬回的音量（下限；后台音量设成 0 的照样不出声） */
const BACKGROUND_IDLE_GAIN = 0.7
/** 前台一句播完到下一句开口通常只隔几百毫秒：停顿超过这么久才把后台抬回来，免得后台忽大忽小 */
const DUCK_RELEASE_MS = 800
/** 占麦的后台来源空了多久才让出（流式中途等模型 / 跑工具） */
const BACKGROUND_HOLD_MS = 3000
/** 后台的声像位置（按来源 id 哈希固定：同一个会话每次都从同一侧出声） */
const BACKGROUND_PANS = [-0.6, 0.6, -0.85, 0.85]
/** 增益 / 声像过渡的时间常数（setTargetAtTime，约 3 倍到位：切前台时 0.4s 左右滑过去） */
const MIX_TIME_CONSTANT = 0.13
/** 跟随气泡时后台离正中至少这么远：气泡落在桌面中间也别和居中的前台叠在一个方向 */
const BUBBLE_PAN_MIN = 0.35
const BUBBLE_PAN_MAX = 0.9
/** HRTF 下气泡高低换成仰角（弧度，±0.5 ≈ ±29°）：桌面上方的气泡声音也偏上 */
const BUBBLE_ELEVATION_MAX = 0.5
/** 后台排着轮不到的：等了这么久还没开口、或积压超过这么多字，就不再逐字念——
 *  压成一句「XX 有新回复」（等一分钟才念出来的长文已经没用，要的是知道那边说完了） */
const BACKGROUND_STALE_MS = 30_000
const BACKGROUND_STALE_CHARS = 300
/** 压缩后这一路安静这么久才算那条回复说完：之后来的文本当新回复正常排队；没安静下来的照丢 */
const COLLAPSE_RESET_MS = 20_000
/** 积压检查的间隔（有后台在排队时才转） */
const STALE_SWEEP_MS = 2000

interface SynthAudio {
  samples: Float32Array
  sampleRate: number
}

interface SpeechChannel {
  id: string
  /** 待合成的句子 */
  queue: string[]
  /** 已合成、待播 */
  ready: SynthAudio[]
  /** 引擎里正在合成本通道的一句 */
  synthesizing: boolean
  /** 播放循环在跑 */
  playing: boolean
  /** 正在出声的那句 */
  current: AudioBufferSourceNode | null
  /** 本轮指定音色（试听时非空）；空 = 每句跟当前选中的音色 */
  voice?: VoiceOption
  /** 本轮已入队总字数（含已播完的）：动态语速按整条回复长度取值，不是剩余队列——
   *  否则越播到后面（队列越短）插值出的语速反而越慢 */
  chars: number
  /** 通道级打断令牌：stopSpeaking 加一，迟到的合成结果 / 播放循环据此作废 */
  token: number
  /** 这一轮排上队的先后（后台按先来后到占麦） */
  since: number
  /** 这一轮开始 / 最近一句开口的时刻（积压判定：后台多久没出声了） */
  startedAt: number
  spokeAt: number
  /** 积压被压成「有新回复」之后：这条回复后面的文本都丢，直到安静 COLLAPSE_RESET_MS 或成了前台 */
  collapsed: boolean
  /** 最近一次来文本的时刻（含被丢掉的） */
  inputAt: number
  /** 桌面气泡位置（归一化 -1..1，x 左负右正、y 上负下正）；没有气泡过 = null，用固定一侧 */
  position: { x: number; y: number } | null
  gain: GainNode | null
  spatial: Spatial | null
}

/** 定位节点：外放用左右声像；耳机模式用 HRTF（能表现前后高低） */
type Spatial = { kind: 'stereo'; node: StereoPannerNode } | { kind: 'hrtf'; node: PannerNode }

const channels = new Map<string, SpeechChannel>()
let arrivals = 0
/** 前台来源（AssistantChat 按当前模式 / 会话设置）；DEFAULT_SOURCE 也恒为前台 */
let foregroundSource = DEFAULT_SOURCE
/** 占着后台麦的来源 */
let backgroundHolder: string | null = null
let holderTimer: ReturnType<typeof setTimeout> | null = null
/** 闪避中：前台在出声，或刚停下还不到 DUCK_RELEASE_MS */
let ducking = false
let duckTimer: ReturnType<typeof setTimeout> | null = null
/** 引擎里正在合成的那句属于哪个通道；全部停止时换代，迟到的结果直接丢 */
let inFlight: { channel: string; gen: number } | null = null
let engineGen = 0
/** 最近一次合成失败、之后还没有新句子入队：空闲时状态行停在「出错」 */
let failed = false
let staleTimer: ReturnType<typeof setTimeout> | null = null
/** 来源 → 念给人听的名字（压缩成「XX 有新回复」时用）；AssistantChat 注册 */
let titleOfSource: (source: string) => string = () => ''

/** 注册来源名字的查法（会话标题 / 「助手」） */
export function setSpeechTitleResolver(resolve: (source: string) => string): void {
  titleOfSource = resolve
}

/** 某一路的桌面气泡位置（归一化 -1..1，x 左负右正、y 上负下正）。只更新不清除：
 *  气泡 5 秒渐隐后声音留在原处，不会念到一半跳回固定的那一侧 */
export function setSpeechPosition(source: string, position: { x: number; y: number }): void {
  const ch = channelFor(source)
  const x = Math.min(1, Math.max(-1, position.x))
  const y = Math.min(1, Math.max(-1, position.y))
  if (ch.position && Math.abs(ch.position.x - x) < 0.01 && Math.abs(ch.position.y - y) < 0.01) return
  ch.position = { x, y }
  applyMix()
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

/** 停掉播放并清空待播（试听 / 开关关闭 / 手动停止时调用）。不带 source 停全部通道；
 *  带 source 只停那一个，其余照常播。引擎正在合成被停通道的那句时一并 cancel
 *  （实测 7ms 就回 cancelled，不会让下一句排队等它）。 */
export function stopSpeaking(source?: string): void {
  const all = source === undefined
  const targets = all ? [...channels.values()] : [channels.get(source)].filter((ch): ch is SpeechChannel => !!ch)
  for (const ch of targets) {
    ch.token += 1
    ch.queue = []
    ch.ready = []
    ch.synthesizing = false
    ch.playing = false
    ch.collapsed = false
    if (ch.current) {
      try {
        ch.current.stop()
      } catch {
        // 已自然播完：忽略
      }
      ch.current = null
    }
  }
  if (inFlight && (all || inFlight.channel === source)) {
    void window.fridayBridge.cancelCosyVoice?.().catch(() => {})
    // 全停：换代后立刻放出合成名额（被 cancel 的那句迟到的结果按代作废）；
    // 只停一个：等它回 cancelled 再放，别让下一句和被取消的那句在引擎里叠着
    if (all) {
      engineGen += 1
      inFlight = null
    }
  }
  if (all || backgroundHolder === source) releaseBackground()
  if (all) {
    failed = false
    if (ttsPhase.value === 'error') ttsPhase.value = 'idle'
    if (staleTimer) {
      clearTimeout(staleTimer)
      staleTimer = null
    }
  }
  onAudibleChange()
  kick()
}

/** 前台来源：正在看的会话 id，或助手模式的 ASSISTANT_SPEECH_SOURCE。切换时不打断任何一路：
 *  新前台从侧面滑到正中、旧前台滑到侧面压低，正在说的那句都说完 */
export function setSpeechForeground(source: string): void {
  if (source === foregroundSource) return
  foregroundSource = source
  if (backgroundHolder === source) releaseBackground() // 占麦的后台成了前台：后台麦空出来
  const front = channels.get(source)
  if (front?.collapsed) {
    // 被压成「有新回复」的会话切到眼前了：提示不用念了，之后长出来的文本照常实时念
    front.collapsed = false
    if (!front.playing && !front.synthesizing) {
      front.token += 1
      front.queue = []
      front.ready = []
    }
  }
  onAudibleChange()
  applyMix()
  kick()
}

function channelFor(id: string): SpeechChannel {
  let ch = channels.get(id)
  if (!ch) {
    ch = {
      id,
      queue: [],
      ready: [],
      synthesizing: false,
      playing: false,
      current: null,
      chars: 0,
      token: 0,
      since: 0,
      startedAt: 0,
      spokeAt: 0,
      collapsed: false,
      inputAt: 0,
      position: null,
      gain: null,
      spatial: null
    }
    channels.set(id, ch)
  }
  return ch
}

function isFront(id: string): boolean {
  return id === DEFAULT_SOURCE || id === foregroundSource
}

function channelBusy(ch: SpeechChannel): boolean {
  return ch.queue.length > 0 || ch.ready.length > 0 || ch.synthesizing || ch.playing
}

function releaseBackground(): void {
  backgroundHolder = null
  if (holderTimer) {
    clearTimeout(holderTimer)
    holderTimer = null
  }
}

/** 后台麦归谁：占着的继续占；没人占就让这一轮排队最早、手上有句子的后台通道来占 */
function claimBackground(): SpeechChannel | null {
  if (backgroundHolder !== null) {
    const held = channels.get(backgroundHolder)
    if (held && !isFront(held.id)) return held
    releaseBackground()
  }
  let pick: SpeechChannel | null = null
  for (const ch of channels.values()) {
    if (isFront(ch.id) || (!ch.queue.length && !ch.ready.length)) continue
    if (!pick || ch.since < pick.since) pick = ch
  }
  if (pick) backgroundHolder = pick.id
  return pick
}

function mayPlay(ch: SpeechChannel): boolean {
  return isFront(ch.id) || claimBackground()?.id === ch.id
}

/** 占麦的后台通道空下来：等 BACKGROUND_HOLD_MS 还没有新句子才让给下一个（流式中途的停顿不算说完） */
function settle(ch: SpeechChannel): void {
  if (ch.id !== backgroundHolder || channelBusy(ch) || holderTimer) return
  holderTimer = setTimeout(() => {
    holderTimer = null
    const held = backgroundHolder === null ? undefined : channels.get(backgroundHolder)
    if (held && channelBusy(held)) return
    backgroundHolder = null
    kick()
  }, BACKGROUND_HOLD_MS)
}

/** 状态变了之后统一推一把：能播的开播、空出来的合成名额派下去、状态行跟上 */
function kick(): void {
  for (const ch of channels.values()) {
    if (ch.ready.length && !ch.playing) void runPlayback(ch)
  }
  schedule()
  sweepStale()
  updatePhase()
}

/** 积压检查：排着轮不到的后台（不占麦、没在说也没在合成），等太久或攒太多字就压成一句提示。
 *  还有后台在排队就隔 STALE_SWEEP_MS 再查一次，都排空了就停 */
function sweepStale(): void {
  const now = Date.now()
  let waiting = false
  for (const ch of channels.values()) {
    if (isFront(ch.id) || ch.id === backgroundHolder || ch.collapsed || ch.playing || ch.synthesizing) continue
    if (!ch.queue.length && !ch.ready.length) continue
    const waited = now - Math.max(ch.startedAt, ch.spokeAt)
    const backlog = ch.queue.reduce((sum, part) => sum + part.length, 0)
    if (waited >= BACKGROUND_STALE_MS || backlog >= BACKGROUND_STALE_CHARS) collapse(ch)
    else waiting = true
  }
  if (waiting && !staleTimer) {
    staleTimer = setTimeout(() => {
      staleTimer = null
      kick()
    }, STALE_SWEEP_MS)
  }
}

/** 一路积压压成「XX 有新回复」：没播的句子（含已合成的）作废，只留这一句提示排队；
 *  这条回复后面再来的文本也丢（collapsed），直到安静下来或切到眼前 */
function collapse(ch: SpeechChannel): void {
  const title = cleanForSpeech(titleOfSource(ch.id)).slice(0, 24)
  ch.token += 1 // 迟到的合成结果作废（调用方已确认它此刻不在合成、不在说）
  ch.queue = [title ? `${title} 有新回复。` : '另一个会话有新回复。']
  ch.ready = []
  ch.chars = 0
  ch.collapsed = true
}

function updatePhase(): void {
  const all = [...channels.values()]
  if (all.some((ch) => ch.current)) {
    ttsPhase.value = 'speaking'
  } else if (inFlight || all.some((ch) => ch.queue.length || ch.ready.length)) {
    // 下载 / 解压由模型进度事件管，这里不盖掉
    if (ttsPhase.value !== 'downloading' && ttsPhase.value !== 'extracting') ttsPhase.value = 'loading'
  } else if (failed) {
    ttsPhase.value = 'error'
  } else if (ttsPhase.value === 'speaking' || ttsPhase.value === 'loading') {
    ttsPhase.value = 'idle'
  }
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

/** 某通道此刻该有的增益与方位：前台居中原声；后台偏到一侧（跟随气泡开着且有过气泡 = 气泡那边，
 *  否则按 id 固定一侧），前台出声时压到后台音量、前台安静时抬回 BACKGROUND_IDLE_GAIN。
 *  elevation 只在 HRTF 下有用（立体声像表现不了高低） */
function mixFor(ch: SpeechChannel): { gain: number; pan: number; elevation: number } {
  if (isFront(ch.id)) return { gain: 1, pan: 0, elevation: 0 }
  const low = ttsBackgroundVolume.value
  const gain = ducking || low === 0 ? low : Math.max(low, BACKGROUND_IDLE_GAIN)
  if (ttsFollowBubble.value && ch.position) {
    return { gain, pan: bubblePan(ch.position.x, ch.id), elevation: -ch.position.y * BUBBLE_ELEVATION_MAX }
  }
  return { gain, pan: backgroundPan(ch.id), elevation: 0 }
}

function backgroundPan(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return BACKGROUND_PANS[Math.abs(hash) % BACKGROUND_PANS.length]
}

/** 气泡横坐标 → 声像：同侧，离正中至少 BUBBLE_PAN_MIN（正好在中间的按 id 那一侧） */
export function bubblePan(x: number, id: string): number {
  const side = Math.abs(x) < 0.01 ? Math.sign(backgroundPan(id)) : Math.sign(x)
  return side * Math.min(BUBBLE_PAN_MAX, Math.max(BUBBLE_PAN_MIN, Math.abs(x) * BUBBLE_PAN_MAX))
}

/** 声像 -1..1 → 方位角 ±90°，配仰角换成 HRTF 的单位球坐标（听者在原点、面朝 -z、头顶 +y） */
export function hrtfPosition(pan: number, elevation: number): { x: number; y: number; z: number } {
  const azimuth = (pan * Math.PI) / 2
  return {
    x: Math.sin(azimuth) * Math.cos(elevation),
    y: Math.sin(elevation),
    z: -Math.cos(azimuth) * Math.cos(elevation)
  }
}

/** 定位节点推到目标方位（immediate：刚建的节点直接落位，不从正中滑过去） */
function placeSpatial(spatial: Spatial, pan: number, elevation: number, now: number, immediate: boolean): void {
  if (spatial.kind === 'stereo') {
    if (immediate) spatial.node.pan.value = pan
    else spatial.node.pan.setTargetAtTime(pan, now, MIX_TIME_CONSTANT)
    return
  }
  const { x, y, z } = hrtfPosition(pan, elevation)
  const node = spatial.node
  if (immediate) {
    node.positionX.value = x
    node.positionY.value = y
    node.positionZ.value = z
  } else {
    node.positionX.setTargetAtTime(x, now, MIX_TIME_CONSTANT)
    node.positionY.setTargetAtTime(y, now, MIX_TIME_CONSTANT)
    node.positionZ.setTargetAtTime(z, now, MIX_TIME_CONSTANT)
  }
}

/** 把每个通道的增益 / 方位平滑推到目标值（切前台、闪避起落、改后台音量、气泡挪位时调） */
function applyMix(): void {
  if (!audioContext) return
  const now = audioContext.currentTime
  for (const ch of channels.values()) {
    if (!ch.gain || !ch.spatial) continue
    const { gain, pan, elevation } = mixFor(ch)
    ch.gain.gain.setTargetAtTime(gain, now, MIX_TIME_CONSTANT)
    placeSpatial(ch.spatial, pan, elevation, now, false)
  }
}

/** 前台出不出声变了：出声立刻压低后台；停下等 DUCK_RELEASE_MS 仍没出声才抬回（句间停顿不抬） */
function onAudibleChange(): void {
  const frontAudible = [...channels.values()].some((ch) => ch.current && isFront(ch.id))
  if (frontAudible) {
    if (duckTimer) {
      clearTimeout(duckTimer)
      duckTimer = null
    }
    if (!ducking) {
      ducking = true
      applyMix()
    }
  } else if (ducking && !duckTimer) {
    duckTimer = setTimeout(() => {
      duckTimer = null
      if ([...channels.values()].some((ch) => ch.current && isFront(ch.id))) return
      ducking = false
      applyMix()
    }, DUCK_RELEASE_MS)
  }
  updatePhase()
}

/** 按当前模式建定位节点：耳机 = HRTF（距离不衰减，音量全由闪避管），外放 = 左右声像 */
function createSpatial(context: AudioContext): Spatial {
  if (!ttsSpatialHeadphones.value) return { kind: 'stereo', node: context.createStereoPanner() }
  const node = context.createPanner()
  node.panningModel = 'HRTF'
  node.distanceModel = 'inverse'
  node.refDistance = 1
  node.rolloffFactor = 0
  return { kind: 'hrtf', node }
}

/** 通道自己那段 gain → 定位节点（接到公共主增益上），首次出声时建；初值直接落位不做渐变 */
function ensureChannelNodes(context: AudioContext, ch: SpeechChannel): GainNode {
  if (!ch.gain || !ch.spatial) {
    ch.gain = context.createGain()
    ch.spatial = createSpatial(context)
    const { gain, pan, elevation } = mixFor(ch)
    ch.gain.gain.value = gain
    placeSpatial(ch.spatial, pan, elevation, context.currentTime, true)
    ch.gain.connect(ch.spatial.node)
    ch.spatial.node.connect(ensureGraph(context))
  }
  return ch.gain
}

/** 切耳机模式：已建好的各路把定位节点就地换掉（gain 断开重接，正在播的 source 不受影响） */
function rebuildSpatial(): void {
  const context = audioContext
  if (!context) return
  for (const ch of channels.values()) {
    if (!ch.gain || !ch.spatial) continue
    ch.gain.disconnect()
    ch.spatial.node.disconnect()
    ch.spatial = createSpatial(context)
    const { pan, elevation } = mixFor(ch)
    placeSpatial(ch.spatial, pan, elevation, context.currentTime, true)
    ch.gain.connect(ch.spatial.node)
    ch.spatial.node.connect(ensureGraph(context))
  }
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

function playSamples(ch: SpeechChannel, token: number, samples: Float32Array, sampleRate: number): Promise<void> {
  return new Promise((resolve) => {
    if (!audioContext) {
      audioContext = new AudioContext()
      void applySink() // 新 context 建好立即落到已选的输出设备（'' = 系统默认，无感）
    }
    const context = audioContext
    // Electron 默认 autoplay 无手势要求；被挂起（输出设备被拔/被独占，罕见）时先恢复。
    // 恢复被拒（设备真没了）时 start 的 onended 不会派发——靠看门狗按音频时长兜底放弃
    // 这句，泵才能继续走：后续句子照常合成入队，设备回来后自动恢复出声，
    // 不至于整个会话从此哑掉（2026-10 修；此前泵会永久挂在等待里，增量只入队不播）
    const resume = context.state === 'suspended' ? context.resume().catch(() => {}) : Promise.resolve()
    void resume.then(() => {
      if (token !== ch.token) return resolve() // 恢复期间这路被停了
      const input = ensureChannelNodes(context, ch)
      const buffer = context.createBuffer(1, samples.length, sampleRate)
      buffer.getChannelData(0).set(samples)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(input)
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(watchdog)
        if (ch.current === source) {
          ch.current = null
          onAudibleChange()
        }
        resolve()
      }
      // 看门狗：onended 丢失（context 卡 suspended 等）时按时长 + 3s 放弃，不挂播放循环
      const watchdog = setTimeout(finish, (samples.length / sampleRate) * 1000 + 3000)
      source.onended = finish
      ch.current = source
      onAudibleChange()
      source.start()
    })
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

/** 播一段文本（分句流水线：首句 1-2 秒出声，后续句边播边合成）。
 *  source：属于哪一路（会话 id / ASSISTANT_SPEECH_SOURCE；不给 = 前台默认路，试听用）。
 *  整条播报（默认）：停掉并清空所有正在播的再入队（试听优先）。
 *  流式增量（append: true）：只把片段接到这一路的队尾不打断——回复气泡边显示边念，
 *  别的会话同时在念也不互相打断（前台居中、后台压低偏到一侧）。
 *  开关关着时不播（试听用 force 跳过）；后台音量调到 0 时后台会话不播。 */
export function speakText(
  text: string,
  options?: { voice?: VoiceOption; force?: boolean; append?: boolean; source?: string }
): void {
  // 首句上限只对非流式的整条播报生效（一次性给全文时首句切短、快开口）。
  // 流式 append 的句子已在 SpeechIncrement 攒到自然句边界，一律整句送合成——
  // 再按 16 字切会把每句话剁成「半句 + 孤儿标点」两段，串行合成两遍，中间的
  // 合成间隙听感就是「一句话中间停顿分两次说」（2026-12 修）。
  const firstLimit = options?.append ? Infinity : 16
  const parts = splitForSpeech(cleanForSpeech(text), firstLimit)
  if (!parts.length) return
  if (!options?.force && !replySpeakEnabled.value) return
  const source = options?.source ?? DEFAULT_SOURCE
  // 后台不播：直接丢，不攒着——攒下来等切过去再念的是过时的内容
  if (!options?.force && !isFront(source) && ttsBackgroundVolume.value === 0) return
  const ch = channelFor(source)
  const now = Date.now()
  if (ch.collapsed && options?.append) {
    // 已压成「有新回复」的那条回复：后面的文本照丢，直到这一路安静 COLLAPSE_RESET_MS（那就是新回复了）
    const quietFor = now - ch.inputAt
    ch.inputAt = now
    if (quietFor < COLLAPSE_RESET_MS) return
    ch.collapsed = false
  }
  ch.inputAt = now
  if (!options?.append) {
    stopSpeaking() // 先全停、清空，再取新 token：此后任何新打断都会使 token 失配
    ch.voice = options?.voice
    ch.chars = 0
    ch.since = ++arrivals
    ch.startedAt = now
  } else if (!channelBusy(ch)) {
    // 这一路闲着（刚被打断 / 上一轮播完）：这次 append 启动新一轮
    ch.voice = options?.voice
    ch.chars = 0
    ch.since = ++arrivals
    ch.startedAt = now
  }
  if (ch.id === backgroundHolder && holderTimer) {
    // 占麦的后台在让出前等到了新句子：接着说，不让
    clearTimeout(holderTimer)
    holderTimer = null
  }
  failed = false
  ch.queue.push(...parts)
  ch.chars += parts.reduce((sum, part) => sum + part.length, 0)
  schedule()
  sweepStale() // 后台一下攒了太多字：当场压成提示，别等下一轮检查
  updatePhase()
}

/** 下一个合成名额给谁：前台垫着的不够 FRONT_LOOKAHEAD 句先给前台；够了才给占后台麦的 */
function nextToSynthesize(): SpeechChannel | null {
  let front: SpeechChannel | null = null
  for (const ch of channels.values()) {
    if (!isFront(ch.id) || !ch.queue.length || ch.ready.length >= FRONT_LOOKAHEAD) continue
    if (!front || ch.since < front.since) front = ch
  }
  if (front) return front
  const back = claimBackground()
  return back && back.queue.length && back.ready.length < BACK_LOOKAHEAD ? back : null
}

/** 合成调度：引擎里同时只放一句（主进程本来就串行，多塞只会让优先级失效）；
 *  一句回来就派下一句。合成与播放各走各的——播放循环从 ready 里取，取走一句就再调度。 */
function schedule(): void {
  if (inFlight) return
  const ch = nextToSynthesize()
  if (!ch) return
  const text = ch.queue.shift()!
  const gen = engineGen
  const token = ch.token
  inFlight = { channel: ch.id, gen }
  ch.synthesizing = true
  const done = (audio: SynthAudio | null, error?: unknown) => {
    if (gen !== engineGen) return // 全停过：这句作废，名额早已放出
    inFlight = null
    ch.synthesizing = false
    if (token === ch.token) {
      if (audio && audio.samples.length) ch.ready.push(audio)
      if (error !== undefined) {
        // 失败时清掉这一路没播到的句子：不清的话下一轮 append 会先播这些旧句（串台），
        // 而引擎故障时它们也只会再失败一遍。新回复的句子照常入队重试——serve 死亡由
        // 主进程回收句柄，下次合成会重新拉起引擎，自动恢复。
        ch.queue = []
        failed = true
        ttsDetail.value = error instanceof Error ? error.message : String(error)
      }
    }
    if (ch.ready.length && !ch.playing) void runPlayback(ch)
    settle(ch)
    schedule()
    updatePhase()
  }
  void synthesize(ch, text).then(
    (audio) => done(audio),
    (error: unknown) => done(null, error ?? new Error('合成失败'))
  )
  updatePhase()
}

/** 后台用的音色：开了「后台换音色」就挑一个和前台不同的快女声（RTF 最低的两个） */
function backgroundVoice(): VoiceOption {
  const main = activeVoice()
  if (!ttsBackgroundVoiceSwap.value) return main
  return main.voice === PRESET_VOICES[0].voice ? PRESET_VOICES[1] : PRESET_VOICES[0]
}

/** 一句送引擎：音色、语速按合成这一刻是前台还是后台取（切前台后下一句就换回来） */
function synthesize(ch: SpeechChannel, text: string): Promise<SynthAudio> {
  const front = isFront(ch.id)
  const voice = ch.voice ?? (front ? activeVoice() : backgroundVoice())
  // 动态语速开时按这一路本轮要念的总字数插值（流式追加会变多，后续句子自动提速）；关时就是固定 ttsSpeed
  const base = ttsDynamicSpeed.value ? dynamicSpeedFor(ch.chars, ttsSpeedMin.value, ttsSpeedMax.value) : ttsSpeed.value
  // 结尾完全没标点的片段（硬切截断 / 尾句）补个句号收韵律；逗号、冒号等
  // 未完标点结尾的保持原样——引擎实测都能出声，保留自然的未完语气，
  // 别叠加出「，。」「：。」这种连续标点
  const spoken = /[,，、:：;；.。!！?？…]\s*$/.test(text) ? text : `${text}。`
  return window.fridayBridge.speakReply({
    text: spoken,
    speed: speechSpeedFor(voice.speed, front ? base : base * BACKGROUND_SPEED_BOOST),
    voice: voice.voice,
    instruction: voice.instruction
  })
}

/** 一路的播放循环：按序播 ready 里的句子；后台的每句开口前确认自己还占着麦
 *  （切前台后旧前台变成后台、麦在别人手里：说完这句就停下排队）。
 *  token 失配（被 stopSpeaking 打断）即退出。 */
async function runPlayback(ch: SpeechChannel): Promise<void> {
  if (ch.playing || !ch.ready.length || !mayPlay(ch)) return
  const token = ch.token
  ch.playing = true
  try {
    while (ch.ready.length && token === ch.token && mayPlay(ch)) {
      const audio = ch.ready.shift()!
      ch.spokeAt = Date.now()
      schedule() // 垫着的少了一句：空着的合成名额可以给这一路补上
      await playSamples(ch, token, audio.samples, audio.sampleRate)
    }
  } finally {
    // 自然播完 / 让麦才归还；被打断的（token 失配）不动——stopSpeaking 已复位，
    // 免得迟到的 finally 把新一轮的标志清掉（那会让后续增量只排队不出声）
    if (token === ch.token) {
      ch.playing = false
      settle(ch)
      kick()
    }
  }
}

// MARK: 流式增量游标（回复气泡的实时播报）

/** 流式增量攒到句边界再入队：增量片常在句中截断，直接播会一字一顿；攒到句末
 *  标点 / 换行才成句送播（append 接队），长时间没有句末标点（无标点长文）就
 *  兜底直送（splitForSpeech 会按逗号 / 60 字硬切，不会憋着不出声）。
 *  ``` 代码块、$$ 公式块是跨行结构：按句切开后每片都凑不齐成对围栏，cleanForSpeech
 *  认不出来，代码会被逐行念出（2026-10 修）。所以游标自己记着「在不在围栏里」：
 *  围栏里的内容直接丢、不参与切句，闭合后接着按句攒；收尾时还没闭合就整段丢掉。
 *  中途起播（已有文本当历史不念）也得让游标过一遍历史：历史停在围栏里时，后面长出来
 *  的是代码的下半截，不过一遍游标就当成正文念了——所以历史走 skip 而不是直接跳过。 */
export interface SpeechIncrement {
  /** 流式又来了一片：接进缓冲，攒出完整句就送播 */
  push(chunk: string): void
  /** 不念的一片（历史 / 不该播的增量）：只用来跟踪围栏状态，正文丢掉、已攒的半句也作废 */
  skip(chunk: string): void
  /** 结束（消息完成）：把还没等到句末标点的尾巴整段播完 */
  flush(): void
}

const SENTENCE_END = '。！？!?；;：\n'
/** 跨行结构的围栏（开闭同一个记号）：里面的内容不念 */
const SPEECH_FENCES = ['```', '$$']

/** source：这个游标的句子送哪一路（会话 id / ASSISTANT_SPEECH_SOURCE；不给 = 前台默认路） */
export function createSpeechIncrement(source: string = DEFAULT_SOURCE): SpeechIncrement {
  let buffer = '' // 围栏外、还没成句的文本
  let pending = '' // 还没判定的原始增量（可能卡着半个围栏记号，如片尾的「``」）
  let muted = 0 // pending 开头有几个字来自 skip：只参与围栏判定，不进句缓冲
  let fence: string | null = null // 当前所在围栏的记号；null = 在围栏外

  /** 从 pending 头上取走 n 个字，返回其中可念的部分（skip 来的那段不算） */
  const take = (n: number): string => {
    const piece = pending.slice(0, n)
    const drop = Math.min(muted, piece.length)
    muted -= drop
    pending = pending.slice(piece.length)
    return piece.slice(drop)
  }

  /** 围栏外的文本接进句缓冲：攒到句末就送播，太长兜底直送 */
  const feed = (text: string) => {
    if (!text) return
    buffer += text
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (SENTENCE_END.includes(buffer[i])) {
        speakText(buffer.slice(0, i + 1), { append: true, source })
        buffer = buffer.slice(i + 1)
        break
      }
    }
    if (buffer.length >= 120) {
      speakText(buffer, { append: true, source })
      buffer = ''
    }
  }

  /** 消化 pending：围栏外的交给 feed，围栏里的丢掉；片尾可能是半个记号的留到下一片再判 */
  const drain = () => {
    while (pending) {
      if (fence) {
        const close = pending.indexOf(fence)
        if (close < 0) {
          // 没闭合：内容丢掉，只留可能是半个闭合记号的尾巴
          take(Math.max(0, pending.length - (fence.length - 1)))
          return
        }
        take(close + fence.length)
        fence = null
        // 围栏占位当空白（和 cleanForSpeech 整段清理一致），句子在围栏两侧接着攒
        if (buffer) buffer += ' '
        continue
      }
      let open = -1
      let marker = ''
      for (const candidate of SPEECH_FENCES) {
        const at = pending.indexOf(candidate)
        if (at >= 0 && (open < 0 || at < open)) {
          open = at
          marker = candidate
        }
      }
      if (open >= 0) {
        feed(take(open))
        take(marker.length)
        fence = marker
        continue
      }
      // 片尾的 ` / `` / $ 可能是下一片记号的前半，先扣住
      const hold = /(?:`{1,2}|\$)$/.exec(pending)?.[0].length ?? 0
      feed(take(pending.length - hold))
      return
    }
  }

  return {
    push(chunk: string) {
      if (!chunk) return
      pending += chunk
      drain()
    },
    skip(chunk: string) {
      if (!chunk) return
      buffer = '' // 中间隔了不念的一段，前面攒的半句接不上了
      pending += chunk
      muted = pending.length
      drain()
    },
    flush() {
      // 扣住的半个记号到收尾也没凑成围栏：当普通字符；还在围栏里：未闭合部分整段丢
      if (!fence) buffer += pending.slice(muted)
      pending = ''
      muted = 0
      fence = null
      if (buffer.trim()) speakText(buffer, { append: true, source })
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
