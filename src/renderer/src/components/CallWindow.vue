<script setup lang="ts">
// 通话窗口（M3-D，方案 §6.3：媒体走 WebRTC，信令走 schat-ws 的 p2p_*）。
// 信令在协议进程，媒体在渲染进程（Chromium）：
//   dial → p2p_request → p2p_response{accepted} → 建 PC → offer → p2p_signaling
//   → answer → setRemoteDescription → 接通；ICE 逐条互送；挂断发 hangup/request_cancel。
// 媒体口径（契约）：音频 Opus 48 kHz 单声道、20 ms 一帧。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()

interface CallSignal {
  requestId: string
  fromUserId: number
  type: string
  payload: string
}

const phase = computed(() => String((store.schat.call as { phase?: string }).phase ?? 'idle'))
const peerName = computed(() => String((store.schat.call as { peerName?: string }).peerName ?? '机器人'))
const muted = computed(() => Boolean((store.schat.call as { muted?: boolean }).muted))
const endedReason = computed(() => String((store.schat.call as { endedReason?: string }).endedReason ?? ''))

const seconds = ref(0)
const iceState = ref('')
const connState = ref('')
const error = ref('')
const level = ref(0)

let pc: RTCPeerConnection | null = null
let localStream: MediaStream | null = null
let audioEl: HTMLAudioElement | null = null
let ticker: number | null = null
let poller: number | null = null
let audioCtx: AudioContext | null = null
let rafID = 0
/** 已经为哪个 requestId 建过 PC（避免重复建） */
let builtFor = ''

/** 接通的秒数（从 connectedAt 算） */
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

/** 麦克风电平（给界面一点反馈，也让用户知道真的在录） */
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

/** 麦克风不可用（没设备 / 被拒）：退回只收音频，通话照样能听 */
const receiveOnly = ref(false)

async function buildPeer(): Promise<void> {
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
      video: false
    })
    for (const track of localStream.getAudioTracks()) pc.addTrack(track, localStream)
    startMeter(localStream)
  } catch (err) {
    // 这台机器没有麦克风（很多台式机/远程桌面就是这样）：
    // 用 recvonly 的 audio transceiver —— offer 里仍有 m=audio，对方照常发；我们只能听。
    const name = err instanceof Error ? err.name : ''
    receiveOnly.value = true
    error.value = name === 'NotAllowedError' ? '没有麦克风权限，只能听' : '这台机器没有麦克风，只能听'
    pc.addTransceiver('audio', { direction: 'recvonly' })
  }

  pc.onicecandidate = (event) => {
    if (!event.candidate) return
    // 线上口径：type 是 ice_candidate，payload 是 {sdpMid, sdpMLineIndex, candidate}
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
    connState.value = pc?.connectionState ?? ''
    if (pc?.connectionState === 'connected') {
      void store.callActive()
      startTicker()
    }
    if (pc?.connectionState === 'failed') error.value = '媒体连不上（NAT 穿透失败）'
  }
  pc.ontrack = (event) => {
    const [stream] = event.streams
    if (!stream) return
    remoteAudio.value = true
    if (!audioEl) {
      audioEl = new Audio()
      audioEl.autoplay = true
    }
    audioEl.srcObject = stream
    void audioEl.play().catch(() => {
      // 自动播放被拦：用户点一下窗口即可
    })
  }

  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false })
  await pc.setLocalDescription(offer)
  await store.callSignal('offer', offer.sdp ?? '')
}

async function handleSignal(signal: CallSignal): Promise<void> {
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

const remoteMuted = ref(false)
/** 收到对方的音轨了（ICE 通了但对方没发音频时用来区分） */
const remoteAudio = ref(false)

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
  connState.value = ''
}

async function hangup(): Promise<void> {
  await store.callHangup()
  teardownMedia()
}

async function toggleMute(): Promise<void> {
  const next = !muted.value
  await store.callMute(next)
  for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !next
}

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
  teardownMedia()
})

/** 上次看到的阶段（只在变化时做一次处理，避免天天重置计时器） */
let lastPhase = ''

// 状态推进：协议进程说「对方接了」（connecting）就建 PC 发 offer
const unwatch = setInterval(async () => {
  const state = store.schat.call as { phase?: string; requestId?: string }
  const phaseNow = state.phase ?? 'idle'
  if (phaseNow === lastPhase) return
  lastPhase = phaseNow
  if (phaseNow === 'connecting' && state.requestId && !pc && state.requestId !== builtFor) {
    builtFor = state.requestId
    try {
      await buildPeer()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }
  if (phaseNow === 'active') startTicker()
  if (phaseNow === 'ended') teardownMedia()
}, 200)
onBeforeUnmount(() => clearInterval(unwatch))

function phaseText(): string {
  switch (phase.value) {
    case 'outgoing':
      return '正在呼叫…'
    case 'connecting':
      return '正在接通…'
    case 'active':
      return timeText(seconds.value)
    case 'ended':
      return endedReason.value || '通话已结束'
    default:
      return '没有通话'
  }
}
</script>

<template>
  <div class="call">
    <div class="stage">
      <div class="avatar" :class="{ live: phase === 'active' }">
        <span class="avatar-name">{{ peerName.slice(0, 1) }}</span>
        <span class="pulse" :style="{ transform: `scale(${1 + level * 0.5})`, opacity: 0.25 + level * 0.6 }" />
      </div>
      <div class="peer">{{ peerName }}</div>
      <div class="phase" :class="phase">{{ phaseText() }}</div>
      <div v-if="error" class="error">{{ error }}</div>
      <div v-if="remoteMuted" class="hint">对方静音了</div>
      <div v-if="receiveOnly" class="hint">本机没有麦克风：能听对方，说不了话</div>
      <div class="diag">
        <span v-if="iceState">ICE：{{ iceState }}</span>
        <span v-if="connState"> · 连接：{{ connState }}</span>
        <span v-if="remoteAudio"> · 已收到对方声音</span>
      </div>
    </div>

    <div class="controls">
      <button class="round" :class="{ off: muted }" :disabled="phase === 'ended' || phase === 'idle'" @click="toggleMute">
        {{ muted ? '🔇' : '🎙' }}
        <span>{{ muted ? '已静音' : '静音' }}</span>
      </button>
      <button class="round hangup" :disabled="phase === 'ended' || phase === 'idle'" @click="hangup">
        📞
        <span>挂断</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.call {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--panel);
}
.stage {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 18px;
}
.avatar {
  position: relative;
  width: 92px;
  height: 92px;
  border-radius: 50%;
  background: var(--accent-weak);
  display: grid;
  place-items: center;
}
.avatar.live {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}
.avatar-name {
  font-size: 34px;
  font-weight: 600;
  color: var(--accent);
}
.pulse {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  transition: transform 90ms linear, opacity 90ms linear;
}
.peer {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.phase {
  font-size: 13px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.phase.active {
  color: var(--ok);
}
.phase.ended {
  color: var(--fail);
}
.error {
  font-size: 12px;
  color: var(--fail);
}
.hint {
  font-size: 12px;
  color: var(--text-3);
}
.diag {
  font-size: 11px;
  color: var(--text-3);
  min-height: 14px;
}
.controls {
  flex: none;
  display: flex;
  justify-content: center;
  gap: 16px;
  padding: 14px;
  border-top: 1px solid var(--border);
}
.round {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 72px;
  padding: 10px 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}
.round:hover:not(:disabled) {
  background: var(--panel-2);
}
.round:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.round.off {
  background: var(--chip);
}
.round.hangup {
  color: #fff;
  background: #dc2626;
  border-color: #dc2626;
}
</style>
