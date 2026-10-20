<script setup lang="ts">
// 通话面板（常驻版，右上）：进入工作台（机器连上）就自动与助手 bot 建立实时视频通话，
// 可以直接开口对话；面板钉在右栏顶部——
//   通话中：远端画面（视频通话）+ 本端小窗 + 静麦 / 静扬声器 / 摄像头开关（没有挂断：挂断=结束程序）
//   未接通：显示原因 + 「接通」按钮（结束后不自动重拨，点它重拨）
// 媒体引擎（WebRTC PC / getUserMedia / 音视频渲染）全在这里；信令在协议进程（schat-ws p2p_*）。
// 音频口径：Opus 48 kHz 单声道；对方没摄像头时退回头像 + 电平脉冲。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app.js'

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
/** 挂件常驻：进了工作台（机器连着）就一直在；没进工作台时只在通话中出现，结束几秒后收起 */
const visible = computed(() => store.connected || inCall.value || phase.value === 'ended')

/** 空闲态（工作台里没在通话）：给出接通入口 */
const idleState = computed(() => store.connected && !inCall.value && phase.value !== 'incoming')

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

/**
 * 建 PC。incoming=true 表示我是被叫：等对端的 offer，收到后 answer。
 * 视频通话（callType=video）：一起开摄像头；麦克风不可用时尽力只发视频。
 */
async function buildPeer(asCallee = false): Promise<void> {
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

// MARK: 进工作台 → 自动与助手视频通话

/** 当前机器对应的助手 bot（work:<botID>） */
const assistantBotID = computed<number>(() => {
  const target = String(store.currentMachineInfo?.targetText ?? '')
  const matched = /^work:(\d+)$/.exec(target)
  if (matched) return Number(matched[1])
  const bots = (store.schat as { bots?: Array<{ id: number }> }).bots ?? []
  return bots[0]?.id ?? 0
})

/** 哪台机器这次连接会话已经自动拨过了（断开重连算新会话，会再拨） */
let autoDialedMachine = ''

/** 主动接通（自动进工作台/挂件上的「接通」按钮共用） */
async function startAssistantCall(): Promise<void> {
  const botID = assistantBotID.value
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

/** 自动接通：机器连上后缓 3 秒再拨——工作通道刚握手时机器人那头还占着会话，立刻拨会回 busy；
 *  被 busy/超时拒掉的话同一连接会话里再补一次（挂断后不自动重拨，点挂件上的接通） */
let autoTimer = 0
let autoRetries = 0

function scheduleAutoDial(delayMs: number): void {
  window.clearTimeout(autoTimer)
  autoTimer = window.setTimeout(() => void tryAutoDial(), delayMs)
}

async function tryAutoDial(): Promise<void> {
  // 登录页盖着（换账号/重新扫码）时不自动打；通话已在进行也不用打
  if (!store.connected || store.loginOverlay || !store.workbenchReady) return
  if (store.schat.phase !== 'online') return
  if (phase.value !== 'idle' && phase.value !== 'ended') return
  await startAssistantCall()
}

watch(
  [() => store.connected, () => store.schat.phase],
  () => {
    if (!store.connected) {
      autoDialedMachine = ''
      autoRetries = 0
      window.clearTimeout(autoTimer)
      return
    }
    if (autoDialedMachine === store.currentMachine) return
    if (store.schat.phase !== 'online') return
    autoDialedMachine = store.currentMachine
    autoRetries = 0
    scheduleAutoDial(3000)
  },
  { immediate: true }
)

// 自动那通被拒（busy/没人接）：同一连接会话里再补一次
watch(phase, (now, before) => {
  if (now !== 'ended' || before === 'idle') return
  if (!store.connected || autoDialedMachine !== store.currentMachine) return
  const code = String((store.schat.call as { endedCode?: string }).endedCode ?? '')
  if ((code === 'busy' || code === 'timeout') && autoRetries < 1) {
    autoRetries += 1
    scheduleAutoDial(5000)
  }
})

/** 轮询信令队列（协议进程 → 渲染进程） */
function pump(): void {
  const signals = store.drainCallSignals() as CallSignal[]
  for (const signal of signals) void handleSignal(signal)
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
  <div v-if="visible" class="call-widget" data-testid="call-widget" @click="void remoteVideoEl?.play().catch(() => {}); audioEl?.play().catch(() => {})">
    <!-- 画面区：视频通话显示远端画面（+本端小窗）；语音/未接通显示头像电平 -->
    <div class="media">
      <video v-show="remoteVideoLive" ref="remoteVideoEl" class="remote-video" autoplay playsinline />
      <div v-if="!remoteVideoLive" class="avatar" :class="{ live: phase === 'active' }">
        <span class="avatar-glyph">{{ idleState ? '💤' : peerName.slice(0, 1) }}</span>
        <span class="pulse" :style="{ transform: `scale(${1 + level * 0.5})`, opacity: 0.25 + level * 0.6 }" />
      </div>
      <video v-show="remoteVideoLive && localVideoLive && cameraOn" ref="localVideoEl" class="local-video" autoplay playsinline muted />
      <div v-if="remoteVideoLive" class="video-tag">{{ peerName }}</div>
      <!-- 摄像头关着（本端不发送）时的小角标 -->
      <div v-if="inCall && !cameraOn && callType === 'video'" class="cam-off-tag">摄像头已关</div>
    </div>

    <!-- 信息行：对方 + 实时状态 -->
    <div class="info">
      <span class="name" :title="peerName">{{ peerName }}</span>
      <span class="phase" :class="phase === 'active' ? 'active' : phase === 'ended' ? 'ended' : ''">{{ phaseText() }}</span>
    </div>
    <div v-if="error || remoteMuted" class="hints">
      <span v-if="error">{{ error }}</span>
      <span v-if="remoteMuted">对方静音了</span>
      <span v-if="iceState === 'failed'">NAT 穿透失败</span>
    </div>

    <!-- 控制行：通话中=静麦/静扬声器/摄像头/挂断；空闲=接通；来电=接听/拒接 -->
    <div class="controls">
      <template v-if="phase === 'incoming'">
        <button class="cbtn reject" title="拒接" @click="reject">✕</button>
        <button class="cbtn accept" title="接听" @click="accept">📞</button>
      </template>
      <template v-else-if="idleState">
        <button class="cbtn connect" title="与助手接通实时视频通话" @click="startAssistantCall">
          📹 <span class="cbtn-text">接通</span>
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
          {{ muted ? '🔇' : '🎙' }}
        </button>
        <button
          class="cbtn"
          :class="{ off: speakerMuted }"
          :title="speakerMuted ? '打开扬声器' : '静扬声器（听不到对方）'"
          @click="toggleSpeaker"
        >
          {{ speakerMuted ? '🔈' : '🔊' }}
        </button>
        <button
          v-if="callType === 'video'"
          class="cbtn"
          :class="{ off: !cameraOn }"
          :disabled="phase === 'ended' || phase === 'idle'"
          :title="cameraOn ? '关闭摄像头' : '打开摄像头'"
          @click="toggleCamera"
        >
          📹
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 常驻在右栏顶部，融在桌面上：无卡片壳（透明、无边框、无阴影）；画面区本身保留一块播放面 */
.call-widget {
  position: relative;
  flex: none;
  background: transparent;
  border: none;
  overflow: hidden;
  user-select: none;
}

.media {
  position: relative;
  height: 138px;
  border-radius: 12px;
  /* 半透明暗底：无画面时背景网格透出来；有画面时被视频帧盖住，不影响观看 */
  background: rgba(6, 11, 20, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.remote-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
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
  bottom: 8px;
  width: 84px;
  height: 56px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: #000;
}

.video-tag {
  position: absolute;
  top: 6px;
  left: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 10.5px;
  max-width: 80%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cam-off-tag {
  position: absolute;
  right: 8px;
  top: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.5);
  color: var(--warn);
  font-size: 10px;
}

.info {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px 0;
}

.name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.phase {
  flex: none;
  font-size: 11.5px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.phase.active {
  color: var(--ok);
}

.phase.ended {
  color: var(--fail);
}

.hints {
  padding: 2px 12px 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.hints span {
  font-size: 10.5px;
  color: var(--warn);
}

.controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 9px 12px 11px;
}

.cbtn {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--panel-2);
  font-size: 15px;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: transform 0.12s, box-shadow 0.12s, border-color 0.12s;
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
  border-color: color-mix(in srgb, var(--warn) 55%, transparent);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}

.cbtn.accept,
.cbtn.connect {
  background: var(--ok);
  border-color: var(--ok);
  width: auto;
  padding: 0 14px;
  gap: 6px;
  display: inline-flex;
  align-items: center;
  font-size: 13px;
}

.cbtn.reject {
  background: var(--fail);
  border-color: var(--fail);
}

.cbtn-text {
  color: #fff;
  font-weight: 600;
}
</style>
