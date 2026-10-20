<script setup lang="ts">
// 实时对话（方案 §6.2 M3-B 的客户端：voice.* 协议）
//   本机只做麦克风和喇叭：16k PCM16 喂给远端 → 远端听写 → 助手 → 边写边念 → PCM16 回来播。
//   听写、插话判断、说完判断、声纹、回声全在远端 Friday 上（docs/REMOTE.md §6「语音」）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { host, rpc } from '../lib/host.js'
import { useAppStore } from '../stores/app.js'
import { VoiceMedia, pcmFromBase64 } from '../lib/voiceMedia.js'

const store = useAppStore()

const running = ref(false)
const starting = ref(false)
const error = ref('')
const stateName = ref('off')
const caption = ref('')
const pending = ref('')
const serverError = ref('')
const level = ref(0)

const media = new VoiceMedia()
let unsubscribe: (() => void) | null = null
let levelTimer = 0

const phaseText = computed(() => {
  switch (stateName.value) {
    case 'starting': return '正在连听写…'
    case 'listening': return '在听（说话就行）'
    case 'hearing': return '听着呢…'
    case 'thinking': return '它在想…'
    case 'speaking': return '它在说（你可以插话）'
    case 'off': return running.value ? '已连上' : '未开始'
    default: return stateName.value
  }
})

async function call(method: string, params?: unknown): Promise<unknown> {
  if (!store.currentMachine) throw new Error('还没连上机器')
  return rpc(store.currentMachine, method, params ?? {})
}

/** 远端来的 voice.* 事件 */
function onEvent(event: { type?: string; machineID?: string; method?: string; params?: unknown }): void {
  if (event.type !== 'event' || event.machineID !== store.currentMachine) return
  const method = event.method ?? ''
  if (!method.startsWith('voice.')) return
  const params = (event.params ?? {}) as Record<string, unknown>

  if (method === 'voice.state') {
    stateName.value = String(params.state ?? 'off')
    caption.value = String(params.caption ?? '')
    pending.value = String(params.pending ?? '')
    serverError.value = String(params.error ?? '')
    if (params.active === false && running.value) stateName.value = 'off'
    return
  }
  if (method === 'voice.audio') {
    const pcm = String(params.pcm ?? '')
    if (!pcm) return
    media.play(pcm, (samples) => {
      void call('voice.played', { samples }).catch(() => {})
      void call('voice.playing', { playing: media.isPlaying() }).catch(() => {})
    })
    void call('voice.playing', { playing: true }).catch(() => {})
    return
  }
  if (method === 'voice.clearAudio') {
    media.stopPlayback()
    return
  }
}

async function start(): Promise<void> {
  if (running.value || starting.value) return
  starting.value = true
  error.value = ''
  try {
    // 先拿麦克风：没麦克风就别去惊动服务端（否则那边刚起来又得停）
    await media.start((base64) => {
      void call('voice.feed', { pcm: base64 }).catch(() => {})
      // 电平只是给界面看的
      const view = new DataView(pcmFromBase64(base64))
      let peak = 0
      for (let i = 0; i < view.byteLength; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)) / 32768)
      level.value = peak
    })
    const state = (await call('voice.start', { inputSampleRate: 16000, outputSampleRate: 16000 })) as {
      state?: string
      caption?: string
      error?: string
    }
    stateName.value = state?.state ?? 'starting'
    serverError.value = state?.error ?? ''
    running.value = true
    // 麦克风电平回落（没人说话就归零）
    levelTimer = window.setInterval(() => {
      level.value = Math.max(0, level.value * 0.75)
    }, 120) as unknown as number
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    const message = e instanceof Error ? e.message : String(e)
    if (name === 'NotFoundError' || /Requested device not found/.test(message)) {
      error.value = '这台电脑没有麦克风：实时对话要有麦克风（能听不能说的用上面的按住说话）'
    } else if (name === 'NotAllowedError') {
      error.value = '麦克风没被允许：在系统设置里给 Friday 开麦克风权限'
    } else {
      error.value = message
    }
    media.stop()
    await call('voice.stop').catch(() => {})
  } finally {
    starting.value = false
  }
}

async function stop(): Promise<void> {
  if (!running.value) return
  running.value = false
  window.clearInterval(levelTimer)
  media.stop()
  await call('voice.stop').catch(() => {})
  stateName.value = 'off'
  caption.value = ''
  pending.value = ''
  level.value = 0
}

async function interrupt(): Promise<void> {
  media.stopPlayback()
  await call('voice.interrupt').catch((e) => {
    error.value = e instanceof Error ? e.message : String(e)
  })
}

onMounted(() => {
  unsubscribe = host.onEvent(onEvent as (event: unknown) => void)
})

onBeforeUnmount(() => {
  unsubscribe?.()
  window.clearInterval(levelTimer)
  void stop()
})
</script>

<template>
  <div class="rt">
    <div class="rt-head">
      <span class="rt-title">实时对话</span>
      <span class="rt-phase">{{ phaseText }}</span>
      <span class="spacer" />
      <button v-if="!running" class="rt-btn primary" :disabled="starting" @click="start">
        {{ starting ? '连接中…' : '开始' }}
      </button>
      <template v-else>
        <button class="rt-btn" @click="interrupt">停一下</button>
        <button class="rt-btn danger" @click="stop">结束</button>
      </template>
    </div>

    <div v-if="running" class="rt-level">
      <span class="dot" :class="{ hot: level > 0.05 }" :style="{ transform: `scale(${1 + level * 1.6})` }" />
      <span class="rt-caption">{{ caption || pending || '说话就行，它在听着' }}</span>
    </div>

    <div v-if="error || serverError" class="rt-error">{{ error || serverError }}</div>
  </div>
</template>

<style scoped>
.rt {
  flex: none;
  border-bottom: 1px solid var(--border);
  padding: 10px 12px 12px;
}

.rt-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rt-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.rt-phase {
  font-size: 11.5px;
  color: var(--text-2);
}

.spacer {
  flex: 1;
}

.rt-btn {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
}

.rt-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.rt-btn.danger {
  color: var(--fail);
  border-color: var(--fail);
}

.rt-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.rt-level {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--text-3);
  transition: transform 90ms ease-out, background 200ms;
}

.dot.hot {
  background: var(--ok);
}

.rt-caption {
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.6;
  min-height: 20px;
}

.rt-error {
  margin-top: 8px;
  font-size: 12px;
  color: var(--fail);
}
/* 贾维斯界面：实时语音条变通讯链路面板 */
[data-theme='jarvis'] .rt {
  border-color: var(--accent-a25);
  background: var(--panel-card-deep);
}

[data-theme='jarvis'] .rt-head {
  border-bottom-color: var(--accent-a20);
}

[data-theme='jarvis'] .rt-title {
  font-family: var(--font-hud);
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--accent);
}

[data-theme='jarvis'] .rt-phase,
[data-theme='jarvis'] .rt-caption {
  font-family: var(--font-hud);
  letter-spacing: 1px;
}

[data-theme='jarvis'] .rt-caption {
  color: #9adcf2;
}
</style>
