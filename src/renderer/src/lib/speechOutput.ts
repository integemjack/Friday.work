// 助手回复的语音播报（输出侧）：偏好（开关 / 音色 / 自定义音色）、回复文本的朗读清理、
// WebAudio 播放与打断。合成在主进程，这里只管「播什么、用哪个引擎和音色播、什么时候停」：
//   - kokoro v1.1（main/TtsService.ts）：CPU 推理、103 个音色、模型包约 350MB，无需显卡；
//   - CosyVoice3（main/CosyVoiceService.ts）：服务端本地语音 Power 同款模型和加载方式，
//     本机 GPU（Vulkan）推理、5 个音色 + 语气指令，约 1.2GB、需显式下载。
// 两者返回格式一致（Float32Array + sampleRate），播放不用分叉；选了 CosyVoice3 但引擎
// 没下好 / 显卡不支持时自动回落 kokoro，不会因这个而静默。
//
// kokoro v1.1 共 103 个音色：sid 0-2 英文女声，3-57 中文女声（zf_001-zf_055），
// 58-102 中文男声（zm_001-zm_045）。预置里的 kokoro 档是按本机实测挑的「清亮」音：
// 把 103 个 sid 用同一句话各合成一遍，逐帧量了基频 F0（自相关）和 3kHz 以上能量占比
// （亮度）。中文女声 55 个里 F0 中位数 248Hz、最高 347Hz；旧预置（zf_001/010/020/035/050）
// 音高只在中游（14-23 名）、亮度普遍倒数（zf_001、zf_050 的 3k+ 占比 0.6%，排 46/47 名），
// 听着就是「低沉发闷」；现在换成音高 300Hz 上下 + 亮度前四的几档。
//
// CosyVoice3 那五个的排序也是实测来的（RTX 2060、Vulkan、同一句 5 句连播）：
// default / lively-female RTF 0.52-0.74、首块 0.53-0.82s（边播边合成完全跟得上）；
// gentle-female RTF 1.04-1.08（临界）；两个男声 RTF 1.15-1.30（长句会断 0.3s）。
// 同一句话在 CUDA 后端是 RTF 1.42-1.56、首块 1.6-1.8s（会断流），所以引擎走 Vulkan。
//
// 偏好落 localStorage（本机 UI 偏好，和主题一样：这台机器上的客户端行为，不随远程机器变）。

import { ref, type Ref } from 'vue'
import { blockCase, blockPayload, type MessageBlock } from '../../../protocol/rpc/protocol.js'

// MARK: 音色

/** kokoro v1.1 的 sid → 音色代号（af_maple / zf_001 / zm_001…，映射来自 k2-fsa PR #1942） */
export function sidToVoiceCode(sid: number): string {
  if (sid === 0) return 'af_maple'
  if (sid === 1) return 'af_sol'
  if (sid === 2) return 'bf_vale'
  if (sid >= 3 && sid <= 57) return `zf_${String(sid - 2).padStart(3, '0')}`
  if (sid >= 58 && sid <= 102) return `zm_${String(sid - 57).padStart(3, '0')}`
  return `sid_${sid}`
}

export interface VoiceOption {
  /** 稳定 id（预置 = 音色代号 / cv3:<音色名>；自定义 = custom:<uuid>） */
  id: string
  name: string
  /** 界面上标注的性别/语言 */
  tag: string
  /** kokoro 的音色编号；CosyVoice3 音色用 voice 字段，这里给 -1 */
  sid: number
  /** 合成引擎：缺省 = kokoro（CPU）；'cosyvoice3' = 本机 GPU、服务端同款模型 */
  engine?: 'kokoro' | 'cosyvoice3'
  /** CosyVoice3 的音色名（voices/<name>.gguf） */
  voice?: string
  /** CosyVoice3 独有的自然语言语气指令（空 = 平常念法） */
  instruction?: string
  /** 语速倍率（1 = 原速；实测 speed 越大时长越短、说得越快：0.9/1.0/1.2 → 2.10s/1.87s/1.59s） */
  speed: number
  custom?: boolean
}

/** CosyVoice3 未就绪 / 合成失败时的回落音色（kokoro 实测最清亮的一档） */
const FALLBACK_SID = 44

/** 预置：CosyVoice3（本机 GPU、音质最自然）5 个 + kokoro 清亮档 7 个 + 轻男声 2 个 + 英文女 1 个 */
export const PRESET_VOICES: VoiceOption[] = [
  { id: 'cv3:default', name: '素绢', tag: 'CosyVoice3 · 女声 · 默认', sid: -1, engine: 'cosyvoice3', voice: 'default', speed: 1.0 },
  { id: 'cv3:lively-female', name: '朗晴', tag: 'CosyVoice3 · 女声 · 明快', sid: -1, engine: 'cosyvoice3', voice: 'lively-female', speed: 1.0 },
  { id: 'cv3:gentle-female', name: '柔蓝', tag: 'CosyVoice3 · 女声 · 温柔', sid: -1, engine: 'cosyvoice3', voice: 'gentle-female', speed: 1.0 },
  { id: 'cv3:young-male', name: '晓川', tag: 'CosyVoice3 · 男声', sid: -1, engine: 'cosyvoice3', voice: 'young-male', speed: 1.0 },
  { id: 'cv3:calm-male', name: '砂青', tag: 'CosyVoice3 · 男声 · 沉稳', sid: -1, engine: 'cosyvoice3', voice: 'calm-male', speed: 1.0 },
  { id: 'zf_042', name: '莺晴', tag: '中文 · 女声 · 清亮', sid: 44, speed: 1.0 },
  { id: 'zf_021', name: '晓晴', tag: '中文 · 女声 · 高亮', sid: 23, speed: 1.0 },
  { id: 'zf_039', name: '云雀', tag: '中文 · 女声 · 最高亢', sid: 41, speed: 1.0 },
  { id: 'zf_052', name: '新荷', tag: '中文 · 女声 · 清亮', sid: 54, speed: 1.0 },
  { id: 'zf_037', name: '浅夏', tag: '中文 · 女声 · 明亮', sid: 39, speed: 1.0 },
  { id: 'zf_034', name: '清漪', tag: '中文 · 女声 · 亮而稳', sid: 36, speed: 1.0 },
  { id: 'zf_041', name: '初萤', tag: '中文 · 女声 · 通透', sid: 43, speed: 1.0 },
  { id: 'zm_018', name: '初阳', tag: '中文 · 男声 · 轻', sid: 75, speed: 1.0 },
  { id: 'zm_009', name: '清和', tag: '中文 · 男声 · 轻', sid: 66, speed: 1.0 },
  { id: 'af_maple', name: 'Maple', tag: '英文 · 女声', sid: 0, speed: 1.0 }
]

/** 自定义音色可选的底层音色（按组分好，设置页下拉用） */
export const CUSTOM_VOICE_GROUPS: Array<{ label: string; sids: number[] }> = [
  { label: '中文女声', sids: Array.from({ length: 55 }, (_, i) => 3 + i) },
  { label: '中文男声', sids: Array.from({ length: 45 }, (_, i) => 58 + i) },
  { label: '英文女声', sids: [0, 1, 2] }
]

// MARK: 偏好（localStorage + 响应式单例；设置页和聊天面板共用）

const KEY_ENABLED = 'voice.replySpeak'
const KEY_CURRENT = 'voice.tts.current'
const KEY_CUSTOM = 'voice.tts.custom'

function readCustom(): VoiceOption[] {
  try {
    const raw = localStorage.getItem(KEY_CUSTOM)
    if (!raw) return []
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    return list.filter(
      (item): item is VoiceOption =>
        item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.sid === 'number' &&
        typeof item.speed === 'number'
    )
  } catch {
    return []
  }
}

/** 回复语音播报总开关（默认开；合成本地免费、不联网，开着没有成本） */
export const replySpeakEnabled = ref<boolean>(loadEnabled())

/** 自定义音色列表（预置之外用户自己加的） */
export const customVoices = ref<VoiceOption[]>(readCustom())

/** 当前选中的音色 id */
export const currentVoiceId = ref<string>(loadCurrentId())

/** CosyVoice3 引擎是否可用（本机平台有包且已下好）；不可用时选它也会回落 kokoro */
export const cosyVoiceReady = ref(false)
export const cosyVoiceStatus = ref<{ supported: boolean; installed: boolean; serving: boolean; voices: string[]; version: string } | null>(null)

/** 拉一次引擎状态（启动时、下载后、选 CosyVoice3 音色时调） */
export async function refreshCosyVoiceStatus(): Promise<void> {
  try {
    const status = await window.fridayBridge.cosyVoiceStatus()
    cosyVoiceStatus.value = status
    cosyVoiceReady.value = status.supported && status.installed
  } catch {
    cosyVoiceReady.value = false
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
    if (saved && (PRESET_VOICES.some((voice) => voice.id === saved) || saved.startsWith('custom:'))) return saved
  } catch {
    // localStorage 不可用：默认
  }
  return PRESET_VOICES[0].id
}

/** 当前生效的音色（自定义条目被删后回落到预置第一个） */
export function activeVoice(): VoiceOption {
  const fromCustom = customVoices.value.find((voice) => voice.id === currentVoiceId.value)
  return fromCustom ?? PRESET_VOICES.find((voice) => voice.id === currentVoiceId.value) ?? PRESET_VOICES[0]
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

function saveCustom(): void {
  try {
    localStorage.setItem(KEY_CUSTOM, JSON.stringify(customVoices.value))
  } catch {
    // 不可写：本次会话内生效即可
  }
}

export function addCustomVoice(name: string, sid: number, speed: number): VoiceOption {
  const voice: VoiceOption = {
    id: `custom:${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    name,
    tag: sidToVoiceCode(sid),
    sid,
    speed,
    custom: true
  }
  customVoices.value = [...customVoices.value, voice]
  saveCustom()
  return voice
}

export function removeCustomVoice(id: string): void {
  customVoices.value = customVoices.value.filter((voice) => voice.id !== id)
  saveCustom()
  if (currentVoiceId.value === id) setCurrentVoice(PRESET_VOICES[0].id)
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

/** 待播片段队列 + 播放泵：整条播报（新回复 / 试听）先清队再入队（后到的优先）；
 *  流式增量（append）只接到队尾、不打断正在播的——回复气泡的文本一片片来，
 *  句子按先后接播，这才是「跟气泡实时」。 */
let speechQueue: string[] = []
let pumping = false
/** 本轮泵指定音色（试听时非空）；流式增量为空 → 每句跟当前选中的音色 */
let pumpVoice: VoiceOption | undefined
/** 当前正在等哪套引擎出声（stopSpeaking 靠它决定要不要 cancel CosyVoice3 的合成） */
let activeEngine: 'kokoro' | 'cosyvoice3' = 'kokoro'

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
      // CosyVoice3 下载/启动完成：刷新状态，选了它的音色就能真用上了
      void refreshCosyVoiceStatus()
    } else if (state.phase === 'error') {
      ttsPhase.value = 'error'
    }
  })
}

/** 停掉当前播放并清空待播队列（新整条回复到来 / 开关关闭 / 手动停止时调用）。
 *  CosyVoice3 正在合成这句时一并 cancel（实测 7ms 就回 cancelled，不会让下一句排队等它）。 */
export function stopSpeaking(): void {
  speakToken += 1
  speechQueue = []
  pumping = false
  if (activeEngine === 'cosyvoice3') void window.fridayBridge.cancelCosyVoice?.().catch(() => {})
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

function playSamples(samples: Float32Array, sampleRate: number): Promise<void> {
  return new Promise((resolve) => {
    if (!audioContext) audioContext = new AudioContext()
    const context = audioContext
    // Electron 默认 autoplay 无手势要求；被挂起（罕见）时恢复
    if (context.state === 'suspended') void context.resume()
    const buffer = context.createBuffer(1, samples.length, sampleRate)
    buffer.getChannelData(0).set(samples)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => {
      if (activeSource === source) activeSource = null
      resolve()
    }
    activeSource = source
    source.start()
  })
}

/** 分句：按句末标点/换行切，超长句再按逗号顿号切；返回非空片段（首句短、首音快）。
 *  片段逐句送主进程合成（串行队列保序），播放与下一句的合成并行——
 *  kokoro RTF 0.30-0.43（fp32 实测）、CosyVoice3 女声 RTF 0.52-0.74（Vulkan 实测）都 < 1，
 *  播放追得上合成。firstLimit：首句上限——CosyVoice3 是整句合成完才返回，首句切短
 *  才能把开口压到 2-3 秒（kokoro 不用切那么细）。 */
export function splitForSpeech(clean: string, firstLimit = 60): string[] {
  const parts: string[] = []
  for (const paragraph of clean.split(/\n+/)) {
    const trimmed = paragraph.trim()
    if (!trimmed) continue
    for (const sentence of trimmed.split(/(?<=[。！？!?；;])/)) {
      const s = sentence.trim()
      if (!s) continue
      const limit = parts.length === 0 ? firstLimit : 60
      if (s.length <= limit) {
        parts.push(s)
        continue
      }
      for (const clause of s.split(/(?<=[，,、])/)) {
        const c = clause.trim()
        if (!c) continue
        // 兜底：没有逗号也超长的（罕见，比如一长串无标点文本），按上限硬切（首句更短）
        const limit = parts.length === 0 ? firstLimit : 60
        for (let at = 0; at < c.length; at += limit) parts.push(c.slice(at, at + limit))
      }
    }
  }
  return parts
}

/** 播一段文本（用当前选中的音色；分句流水线：首句 1-2 秒出声，后续句边播边合成）。
 *  整条播报（默认）：停掉并清空正在播的再入队（新回复 / 试听优先）。
 *  流式增量（append: true）：只把片段接到队尾不打断——回复气泡边显示边念，
 *  收尾的整条播报也不冲掉前面还没播完的句子。
 *  开关关着时不播（试听用 force 跳过）。 */
export function speakText(text: string, options?: { voice?: VoiceOption; force?: boolean; append?: boolean }): void {
  const voice = options?.voice ?? pumpVoice ?? activeVoice()
  const parts = splitForSpeech(cleanForSpeech(text), voice.engine === 'cosyvoice3' ? 16 : 60)
  if (!parts.length) return
  if (!options?.force && !replySpeakEnabled.value) return
  if (!options?.append) {
    stopSpeaking() // 先停旧的、清空队列，再取新 token：此后任何新打断都会使 token 失配
    pumpVoice = options?.voice
  } else if (!pumping) {
    pumpVoice = options?.voice // 泵停着（刚被打断 / 上一轮播完）：这次 append 启动新一轮
  }
  speechQueue.push(...parts)
  if (!pumping) void pumpSpeech()
}

/** 播放泵：逐句「合成下一句与播放并行」地消费队列（RTF 0.3-0.43 < 1，播放始终
 *  追得上合成）；流式增量随时往队尾加。token 失配（被 stopSpeaking 打断）即退出，
 *  残留队列已由 stopSpeaking 清空。 */
async function pumpSpeech(): Promise<void> {
  const token = speakToken
  pumping = true
  ttsPhase.value = 'loading'
  try {
    const synth = async (text: string) => {
      const voice = pumpVoice ?? activeVoice()
      const cv3 = voice.engine === 'cosyvoice3'
      if (cv3 && cosyVoiceReady.value) {
        activeEngine = 'cosyvoice3'
        try {
          return await window.fridayBridge.speakReply({
            text,
            speed: voice.speed,
            engine: 'cosyvoice3',
            voice: voice.voice,
            instruction: voice.instruction
          })
        } catch (error) {
          // 显卡不支持 Vulkan / 引擎抱错：本轮改走 kokoro，并把原因显出来（不静默）
          cosyVoiceReady.value = false
          ttsDetail.value = `CosyVoice3 合成失败（${(error as Error).message}），已改用本地 kokoro 音色`
        }
      }
      activeEngine = 'kokoro'
      // 选了 CosyVoice3 但引擎没下好：用实测最清亮的 kokoro 档兜底，不至于不出声
      return window.fridayBridge.speakReply({ text, sid: cv3 ? FALLBACK_SID : voice.sid, speed: voice.speed })
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

const SENTENCE_END = '。！？!?；;\n'

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

/** 设置页「立即下载」：只下模型不合成 */
export function prefetchTtsModel(): void {
  window.fridayBridge?.prefetchTtsModel?.()
}
