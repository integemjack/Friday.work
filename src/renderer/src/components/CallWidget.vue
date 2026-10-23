<script setup lang="ts">
// 通话面板（右栏顶部）：拨打视频/语音时才占右栏上部 1/3（聊天缩到 2/3）；空闲/挂断后整个收起、
// 聊天占满整栏。进入工作台（机器连上）默认不自动拨打（lib/autoCall.ts 的开关，默认关）——
// 想通话用聊天面板头部的视频/语音按钮；设置 › 通话里打开开关后恢复自动拨。
// 媒体引擎（WebRTC PC / getUserMedia / 音视频渲染）全在这里；信令在协议进程（schat-ws p2p_*）。
// 音频口径：Opus 48 kHz 单声道；对方没摄像头时退回头像 + 电平脉冲。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app.js'
import { autoCallEnabled } from '../lib/autoCall.js'

const store = useAppStore()

interface CallSignal {
  requestId: string
  fromUserId: number
  type: string
  payload: string
}

const phase = computed(() => String((store.schat.call as { phase?: string }).phase ?? 'idle'))
const peerName = computed(() => String((store.schat.call as { peerName?: string }).peerName ?? '助手'))
const muted = computed(() => Boolean((store.schat.call as { muted?: boolean }).muted))
const endedReason = computed(() => String((store.schat.call as { endedReason?: string }).endedReason ?? ''))
const callType = computed(() => String((store.schat.call as { callType?: string }).callType ?? 'audio'))

const inCall = computed(() => phase.value === 'incoming' || phase.value === 'outgoing' || phase.value === 'connecting' || phase.value === 'active')
/** 只在通话中出现（来电/呼出/接通中/通话中）；空闲/挂断后整个收起，聊天占满右栏。
 *  v-show 而不是 v-if：组件要常驻——自动拨号、busy 重拨、断线补接的 watch 全挂在这 */
const visible = computed(() => inCall.value)

const seconds = ref(0)
const iceState = ref('')
const error = ref('')
const level = ref(0)
/** 扬声器静音（本端播放层面，不上信令） */
const speakerMuted = ref(false)
/** 摄像头开/关（本端发送层面） */
const cameraOn = ref(false)
const remoteMuted = ref(false)
/** 收到对方的音轨了 */
const remoteAudio = ref(false)
/** 远端视频流来了（画面区从头像切成视频） */
const remoteVideoLive = ref(false)
/** 本端摄像头开出来了（预览小窗用） */
const localVideoLive = ref(false)

const remoteVideoEl = ref<HTMLVideoElement | null>(null)
const localVideoEl = ref<HTMLVideoElement | null>(null)

let pc: RTCPeerConnection | null = null
let localStream: MediaStream | null = null
let audioEl: HTMLAudioElement | null = null
let ticker: number | null = null
let poller: number | null = null
let audioCtx: AudioContext | null = null
let rafID = 0
/** 已经为哪个 requestId 建过 PC（避免重复建） */
let builtFor = ''
/** 麦克风/摄像头不可用（没设备 / 被拒）：退回只收，通话照样能听 */
const receiveOnly = ref(false)

/** 线性图标（Feather 风、24 viewBox stroke）：所有按钮统一 16px 渲染，大小一致 */
const ICONS = {
  mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
  micOff: '<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
  volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  volumeOff: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>',
  cam: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
  camOff: '<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  // 挂断：电话图标旋转 135°（听筒朝下的传统挂断样式）
  hangup: '<g transform="rotate(135 12 12)"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></g>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
} as const

/** 悬停提示（文字不常驻显示）：对方 · 阶段/时长 · 对方静音 · 连接异常 · 错误 */
const stateTip = computed(() =>
  [
    peerName.value,
    phaseText(),
    remoteMuted.value ? '对方静音了' : '',
    iceState.value === 'failed' ? 'NAT 穿透失败' : '',
    error.value
  ]
    .filter(Boolean)
    .join(' · ')
)

function startTicker(): void {
  stopTicker()
  ticker = window.setInterval(() => {
    const connectedAt = Number((store.schat.call as { connectedAt?: number }).connectedAt ?? 0)
    seconds.value = connectedAt ? Math.max(0, Math.round((Date.now() - connectedAt) / 1000)) : 0
  }, 500)
}
function stopTicker(): void {
  if (ticker !== null) window.clearInterval(ticker)
  ticker = null
}

function timeText(total: number): string {
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function phaseText(): string {
  switch (phase.value) {
    case 'incoming':
      return '来电…'
    case 'outgoing':
      return '正在呼叫…'
    case 'connecting':
      return '正在接通…'
    case 'active':
      return timeText(seconds.value)
    case 'ended':
      return endedReason.value || '通话已结束'
    default:
      return '未接通'
  }
}

function startMeter(stream: MediaStream): void {
  try {
    audioCtx = new AudioContext()
    const source = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    const loop = (): void => {
      analyser.getByteTimeDomainData(data)
      let peak = 0
      for (const value of data) peak = Math.max(peak, Math.abs(value - 128) / 128)
      level.value = peak
      rafID = requestAnimationFrame(loop)
    }
    loop()
  } catch {
    // 拿不到电平不影响通话
  }
}

function stopMeter(): void {
  if (rafID) cancelAnimationFrame(rafID)
  rafID = 0
  level.value = 0
  void audioCtx?.close().catch(() => {})
  audioCtx = null
}

async function attachLocalPreview(): Promise<void> {
  if (!localStream?.getVideoTracks().length) return
  localVideoLive.value = true
  await nextTick()
  if (localVideoEl.value) localVideoEl.value.srcObject = localStream
}

/** 建 PC。incoming=true 表示我是被叫：等对端的 offer，收到后 answer。
 *  视频通话（callType=video）：一起开摄像头；麦克风不可用时尽力只发视频。
 *  并发重入共用同一次构建：轮询刚进 buildPeer、offer 信令同时到达时，
 *  各建一个 PC + 各开一次麦，先建的那套泄漏还照常采集 */
let building: Promise<void> | null = null

function buildPeer(asCallee = false): Promise<void> {
  if (building) return building
  building = doBuildPeer(asCallee).finally(() => {
    building = null
  })
  return building
}

async function doBuildPeer(asCallee = false): Promise<void> {
  const wantVideo = callType.value === 'video'
  const iceServers = (await store.callIce()) as RTCIceServer[]
  pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' })

  // 音频口径：Opus 48 kHz、单声道、回声消除 + 降噪（桌面/手机同一套）
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
        channelCount: 1
      },
      video: wantVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false
    })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (wantVideo) {
      // 麦克风挂了但摄像头可能有：再试一次只发视频
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { width: { ideal: 1280 }, height: { ideal: 720 } }
        })
        receiveOnly.value = true
        error.value = '没有麦克风，只能听'
      } catch {
        receiveOnly.value = true
        error.value = name === 'NotAllowedError' ? '没有麦克风/摄像头权限，只能听' : '这台机器没有可用的麦克风摄像头，只能听'
      }
    } else {
      receiveOnly.value = true
      error.value = name === 'NotAllowedError' ? '没有麦克风权限，只能听' : '这台机器没有麦克风，只能听'
    }
  }

  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream)
    if (localStream.getAudioTracks().length) startMeter(localStream)
    if (localStream.getVideoTracks().length) {
      cameraOn.value = true
      void attachLocalPreview()
    }
  }
  if (!pc.getSenders().some((sender) => sender.track)) {
    // 一个轨道都没发出去：补 recvonly（音频必补，视频按需），对方照常发、我们能收
    pc.addTransceiver('audio', { direction: 'recvonly' })
    if (wantVideo) pc.addTransceiver('video', { direction: 'recvonly' })
  }

  pc.onicecandidate = (event) => {
    if (!event.candidate) return
    void store.callSignal(
      'ice_candidate',
      JSON.stringify({
        sdpMid: event.candidate.sdpMid ?? '0',
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? 0,
        candidate: event.candidate.candidate
      })
    )
  }
  pc.oniceconnectionstatechange = () => {
    iceState.value = pc?.iceConnectionState ?? ''
  }
  pc.onconnectionstatechange = () => {
    if (pc?.connectionState === 'connected') {
      void store.callActive()
      startTicker()
    }
    if (pc?.connectionState === 'failed') error.value = '媒体连不上（NAT 穿透失败）'
  }
  pc.ontrack = (event) => {
    const [stream] = event.streams
    if (event.track.kind === 'video') {
      remoteVideoLive.value = true
      void nextTick(() => {
        if (remoteVideoEl.value) remoteVideoEl.value.srcObject = stream ?? new MediaStream([event.track])
        void remoteVideoEl.value?.play().catch(() => {})
      })
      return
    }
    if (!stream) return
    remoteAudio.value = true
    if (!audioEl) {
      audioEl = new Audio()
      audioEl.autoplay = true
    }
    audioEl.muted = speakerMuted.value
    audioEl.srcObject = stream
    void audioEl.play().catch(() => {
      // 自动播放被拦：点一下挂件即可
    })
  }

  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: wantVideo })
  if (asCallee) {
    builtFor = builtFor || 'callee'
    return
  }
  await pc.setLocalDescription(offer)
  await store.callSignal('offer', offer.sdp ?? '')
}

async function handleSignal(signal: CallSignal): Promise<void> {
  if (signal.type === 'offer') {
    if (!pc) await buildPeer(true)
    if (!pc) return
    await pc.setRemoteDescription({ type: 'offer', sdp: signal.payload })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await store.callSignal('answer', answer.sdp ?? '')
    return
  }
  if (!pc) return
  if (signal.type === 'answer') {
    await pc.setRemoteDescription({ type: 'answer', sdp: signal.payload })
    void store.callActive()
    startTicker()
    return
  }
  if (signal.type === 'ice_candidate') {
    try {
      const parsed = JSON.parse(signal.payload) as { sdpMid?: string; sdpMLineIndex?: number; candidate: string }
      await pc.addIceCandidate({
        candidate: parsed.candidate,
        sdpMid: parsed.sdpMid ?? '0',
        sdpMLineIndex: parsed.sdpMLineIndex ?? 0
      })
    } catch {
      // 候选来早了或已过期：忽略
    }
    return
  }
  if (signal.type === 'media_state') {
    try {
      const parsed = JSON.parse(signal.payload) as { video?: boolean; muted?: boolean }
      // 对方静音只用于显示，不改变本端
      if (parsed.muted !== undefined) remoteMuted.value = parsed.muted
    } catch {
      // 忽略
    }
  }
}

function teardownMedia(): void {
  stopTicker()
  stopMeter()
  if (audioEl) {
    audioEl.srcObject = null
    audioEl = null
  }
  if (localStream) {
    for (const track of localStream.getTracks()) track.stop()
    localStream = null
  }
  if (pc) {
    pc.onicecandidate = null
    pc.ontrack = null
    pc.onconnectionstatechange = null
    pc.oniceconnectionstatechange = null
    pc.close()
    pc = null
  }
  seconds.value = 0
  iceState.value = ''
  remoteVideoLive.value = false
  localVideoLive.value = false
  remoteAudio.value = false
  cameraOn.value = false
}

async function accept(): Promise<void> {
  await store.callAccept()
}

async function reject(): Promise<void> {
  await store.callReject()
  teardownMedia()
}

/** 挂断通话（控制条上的红色按钮）：结束信令 + 停媒体；想再打点挂件上的「接通」 */
async function hangup(): Promise<void> {
  try {
    await store.callHangup()
  } catch {
    // 连接已断时挂不了：直接把本地媒体收掉
  }
  teardownMedia()
}

async function toggleMute(): Promise<void> {
  const next = !muted.value
  await store.callMute(next)
  for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !next
}

function toggleSpeaker(): void {
  speakerMuted.value = !speakerMuted.value
  if (audioEl) audioEl.muted = speakerMuted.value
}

/** 摄像头开关：本端视频轨 enabled 切换（关=发黑帧，不重协商） */
function toggleCamera(): void {
  const tracks = localStream?.getVideoTracks() ?? []
  if (!tracks.length) {
    error.value = '这台机器没有摄像头'
    return
  }
  cameraOn.value = !cameraOn.value
  for (const track of tracks) track.enabled = cameraOn.value
}

// MARK: 进工作台 → 自动与助手视频通话（默认关，设置 › 通话里开）

// 助手 bot（work:<botID>）的取法在 store.assistantBotID（聊天头部的手动拨打入口也用同一份）

/** 哪台机器这次连接会话已经自动拨过了（断开重连算新会话，会再拨；开关关着时不标记，
 *  这样中途打开开关也能立刻按当前会话补拨） */
let autoDialedMachine = ''

/** 主动拨号（进工作台后自动拨那通用的就是它） */
async function startAssistantCall(): Promise<void> {
  const botID = store.assistantBotID
  if (!botID) {
    error.value = '找不到助手机器人'
    return
  }
  error.value = ''
  try {
    await store.callDial(botID, 'video')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

/** 自动接通（开关开着时）：机器连上后缓 3 秒再拨——工作通道刚握手时机器人那头还占着会话，立刻拨会回 busy；
 *  被 busy/超时拒掉的话同一连接会话里再补一次（挂断后不自动重拨，点挂件上的接通） */
let autoTimer = 0
let autoRetries = 0
/** 断线弄断的通话自动补接的次数（同一连接会话；正常挂断/对方拒接不补） */
let disconnectRetries = 0

function scheduleAutoDial(delayMs: number): void {
  window.clearTimeout(autoTimer)
  autoTimer = window.setTimeout(() => void tryAutoDial(), delayMs)
}

async function tryAutoDial(): Promise<void> {
  // 开关关着（默认）一切自动拨号都不打：进工作台不拨、busy/断线的补拨也到这为止
  if (!autoCallEnabled.value) return
  // 登录页盖着（换账号/重新扫码）时不自动打；通话已在进行也不用打
  if (!store.connected || store.loginOverlay || !store.workbenchReady) return
  if (store.schat.phase !== 'online') return
  if (phase.value !== 'idle' && phase.value !== 'ended') return
  await startAssistantCall()
}

watch(
  [() => store.connected, () => store.schat.phase, autoCallEnabled],
  () => {
    if (!store.connected) {
      autoDialedMachine = ''
      autoRetries = 0
      disconnectRetries = 0
      window.clearTimeout(autoTimer)
      return
    }
    if (!autoCallEnabled.value) return // 默认关：进工作台不自动拨（也不标记，开开关时能补拨）
    if (autoDialedMachine === store.currentMachine) return
    if (store.schat.phase !== 'online') return
    autoDialedMachine = store.currentMachine
    autoRetries = 0
    disconnectRetries = 0
    scheduleAutoDial(3000)
  },
  { immediate: true }
)

// 自动那通被拒（busy/没人接）：同一连接会话里再补一次；
// 断线弄断的（schat-ws 掉线把通话一并结束，endedCode=disconnected）：连接恢复后自动接回来，最多两次
// （都在开关开着时才有；关着时 tryAutoDial 直接返回）
watch(phase, (now, before) => {
  if (now !== 'ended' || before === 'idle') return
  if (!store.connected || autoDialedMachine !== store.currentMachine) return
  const code = String((store.schat.call as { endedCode?: string }).endedCode ?? '')
  if ((code === 'busy' || code === 'timeout') && autoRetries < 1) {
    autoRetries += 1
    scheduleAutoDial(5000)
    return
  }
  if (code === 'disconnected' && disconnectRetries < 2) {
    disconnectRetries += 1
    scheduleAutoDial(5000)
  }
})

/** 轮询信令队列（协议进程 → 渲染进程） */
function pump(): void {
  const signals = store.drainCallSignals() as CallSignal[]
  for (const signal of signals) {
    // 不吞拒绝：setRemoteDescription/createAnswer 失败（重复 offer / 信令乱序 / PC 已关）
    // 静默卡死比报错更难查
    handleSignal(signal).catch((err) => {
      error.value = err instanceof Error ? err.message : String(err)
    })
  }
}

onMounted(() => {
  pump()
  poller = window.setInterval(pump, 200)
})

onBeforeUnmount(() => {
  if (poller !== null) window.clearInterval(poller)
  window.clearTimeout(autoTimer)
  teardownMedia()
})

/** 上次看到的阶段（只在变化时做一次处理） */
let lastPhase = ''

// 状态推进：协议进程说「对方接了」（connecting）就建 PC 发 offer
const unwatch = setInterval(async () => {
  const state = store.schat.call as { phase?: string; requestId?: string }
  const phaseNow = state.phase ?? 'idle'
  if (phaseNow === lastPhase) return
  lastPhase = phaseNow
  if (phaseNow === 'connecting' && !state.requestId) return
  if (phaseNow === 'connecting' && state.requestId && !pc && state.requestId !== builtFor) {
    // 来电接听后是 connecting：建 PC 但**不发 offer**（等主叫的 offer）
    const asCallee = Boolean((store.schat.call as { incoming?: boolean }).incoming)
    builtFor = state.requestId
    try {
      await buildPeer(asCallee)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }
  if (phaseNow === 'active') startTicker()
  if (phaseNow === 'ended') {
    teardownMedia()
  }
}, 200)
onBeforeUnmount(() => clearInterval(unwatch))
</script>

<template>
  <div
    v-show="visible"
    class="call-widget"
    data-testid="call-widget"
    :title="stateTip"
    @click="void remoteVideoEl?.play().catch(() => {}); audioEl?.play().catch(() => {})"
  >
    <!-- 画面区：视频通话显示远端画面（+本端小窗）；语音/未接通显示头像电平；
         控制按钮直接盖在画面上，文字一律不常驻（状态放悬停提示） -->
    <div class="media">
      <video v-show="remoteVideoLive" ref="remoteVideoEl" class="remote-video" autoplay playsinline />
      <div v-if="!remoteVideoLive" class="avatar" :class="{ live: phase === 'active' }">
        <span class="avatar-glyph">{{ peerName.slice(0, 1) }}</span>
        <span class="pulse" :style="{ transform: `scale(${1 + level * 0.5})`, opacity: 0.25 + level * 0.6 }" />
      </div>
      <video v-show="remoteVideoLive && localVideoLive && cameraOn" ref="localVideoEl" class="local-video" autoplay playsinline muted />

      <!-- 控制按钮（盖在画面顶部）：来电=拒接/接听；通话中=静麦/静扬声器/摄像头/挂断 -->
      <div class="controls">
        <template v-if="phase === 'incoming'">
          <button class="cbtn reject" title="拒接" @click="reject">
            <svg viewBox="0 0 24 24" v-html="ICONS.x" />
          </button>
          <button class="cbtn accept" title="接听" @click="accept">
            <svg viewBox="0 0 24 24" v-html="ICONS.phone" />
          </button>
        </template>
        <template v-else>
          <button
            class="cbtn"
            :class="{ off: muted }"
            :disabled="phase === 'ended' || phase === 'idle'"
            :title="muted ? '取消静音（麦克风）' : '静音（麦克风）'"
            @click="toggleMute"
          >
            <svg viewBox="0 0 24 24" v-html="muted ? ICONS.micOff : ICONS.mic" />
          </button>
          <button
            class="cbtn"
            :class="{ off: speakerMuted }"
            :title="speakerMuted ? '打开扬声器' : '静扬声器（听不到对方）'"
            @click="toggleSpeaker"
          >
            <svg viewBox="0 0 24 24" v-html="speakerMuted ? ICONS.volumeOff : ICONS.volume" />
          </button>
          <button
            v-if="callType === 'video'"
            class="cbtn"
            :class="{ off: !cameraOn }"
            :disabled="phase === 'ended' || phase === 'idle'"
            :title="cameraOn ? '关闭摄像头' : '打开摄像头'"
            @click="toggleCamera"
          >
            <svg viewBox="0 0 24 24" v-html="cameraOn ? ICONS.cam : ICONS.camOff" />
          </button>
          <button class="cbtn hangup" title="挂断" @click="hangup">
            <svg viewBox="0 0 24 24" v-html="ICONS.hangup" />
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 画面区：视频按比例自适应（宽度撑满、高度随视频比例），控制按钮盖在画面顶部 */
.call-widget {
  position: relative;
  /* 通话中占右栏上部 1/3：flex 份数由 App.vue 的 .side-right.calling 统一配（聊天 2 份、这里 1 份）；
     v-show 收起时 display:none 不占位，聊天回到整栏 */
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: transparent;
  border: none;
  overflow: hidden;
  user-select: none;
}

.media {
  position: relative;
  flex: 1;
  /* 1/3 栏高可能不高：不设最低高度，完全随面板比例走（溢出会被裁剪） */
  min-height: 0;
  border-radius: 12px;
  /* 无底色：右栏融进桌面背景（圆角留着裁视频画面的四角）；有画面时视频帧自己盖住 */
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.remote-video {
  width: 100%;
  /* 高度按视频宽高比自适应：从顶部开始显示，不拉伸不居中裁剪。
     竖屏视频超出栏高时 max-height 兜底，contain 保证画面完整（左右留暗边） */
  height: auto;
  max-height: 100%;
  object-fit: contain;
  align-self: flex-start;
  background: #000;
}

.avatar {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--accent-weak);
  display: grid;
  place-items: center;
}

.avatar.live {
  border: 1px solid color-mix(in srgb, var(--ok) 55%, transparent);
}

.avatar-glyph {
  font-size: 22px;
  color: var(--accent);
  z-index: 1;
}

.pulse {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.25;
  transition: transform 0.08s linear;
}

.local-video {
  position: absolute;
  right: 8px;
  top: 8px;
  width: 84px;
  height: 56px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: #000;
}

/* 控制按钮：盖在画面顶部（下半段被聊天覆盖层占住，底部按钮会被盖住点不到），
   渐变底衬保证看得清；容器本身不挡画面点击 */
.controls {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 10px 10px 22px;
  background: linear-gradient(to bottom, rgba(4, 8, 16, 0.7), transparent);
  pointer-events: none;
}

.cbtn {
  pointer-events: auto;
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(10, 16, 26, 0.62);
  color: #fff;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: transform 0.12s, box-shadow 0.12s, border-color 0.12s, background 0.12s;
}

/* 图标统一 16px 线性风，stroke 跟随按钮颜色 */
.cbtn svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.cbtn:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: var(--accent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 25%, transparent);
}

.cbtn:disabled {
  opacity: 0.45;
  cursor: default;
}

.cbtn.off {
  border-color: color-mix(in srgb, var(--warn) 60%, transparent);
  background: color-mix(in srgb, var(--warn) 22%, rgba(10, 16, 26, 0.62));
}

.cbtn.accept,
.cbtn.connect {
  background: var(--ok);
  border-color: var(--ok);
}

.cbtn.reject {
  background: var(--fail);
  border-color: var(--fail);
}

.cbtn.hangup {
  background: var(--fail);
  border-color: var(--fail);
}
</style>
