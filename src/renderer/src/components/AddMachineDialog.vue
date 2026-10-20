<script setup lang="ts">
// 添加机器（0.3）：唯一的方式是 SChat 扫码后的机器人（WebRTC 工作通道）。
// 没登录：提示去设置扫码；登录了：列出机器人，点一个就连。
import { computed, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'

const emit = defineEmits<{ close: [] }>()
const store = useAppStore()
const busy = ref('')
const error = ref('')

/** 已经连成机器人的 bot（work:<id>）：不重复列出（机器列表里已有一份，去那边管理） */
const addedBotIDs = computed(() => {
  const ids = new Set<number>()
  for (const machine of store.machines) {
    if (machine.targetKind !== 'work') continue
    const id = Number.parseInt(machine.targetText.slice(5), 10)
    if (Number.isInteger(id)) ids.add(id)
  }
  return ids
})
const addableBots = computed(() => store.schat.bots.filter((bot) => !addedBotIDs.value.has(bot.id)))

onMounted(() => {
  if (store.schat.phase !== 'online') void store.schatRefresh()
})

async function add(botID: number, name: string) {
  busy.value = String(botID)
  error.value = ''
  try {
    await store.connectWork(botID, name)
    emit('close')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <div class="dialog">
      <h3>添加机器</h3>
      <p class="hint">从 SChat 机器人列表里选一台：扫码连上后走 WebRTC 工作通道，语音 / 视频 / 数据都从这条通道走。</p>

      <template v-if="store.schat.phase === 'online'">
        <div v-if="!addableBots.length" class="empty">
          {{ store.schat.bots.length ? '机器人都在「机器与会话」里了，没有新的可连。' : '好友里还没有机器人。先在手机上把 Friday 机器人加成好友。' }}
        </div>
        <div class="bots">
          <button
            v-for="bot in addableBots"
            :key="bot.id"
            class="bot"
            :disabled="!!busy"
            @click="add(bot.id, bot.name)"
          >
            <span class="name">{{ bot.name }}</span>
            <span class="sub">{{ busy === String(bot.id) ? '连接中…' : 'WebRTC 连接' }}</span>
          </button>
        </div>
      </template>
      <div v-else class="empty">SChat 没登录：先到 设置 → SChat 扫码登录，再回来添加。</div>

      <div v-if="error" class="error">{{ error }}</div>
      <div class="row">
        <button class="primary" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.4);
  display: grid;
  place-items: center;
  z-index: 90;
}
.dialog {
  width: min(420px, 90vw);
  background: var(--bg, #1e1f24);
  color: var(--fg, #e6e6ea);
  border: 1px solid var(--line, #33343c);
  border-radius: 10px;
  padding: 16px;
  display: grid;
  gap: 12px;
}
h3 { margin: 0; font-size: 15px; }
.hint { margin: 0; font-size: 12px; opacity: 0.7; }
.empty { font-size: 13px; opacity: 0.75; padding: 12px 0; }
.bots { display: grid; gap: 6px; max-height: 260px; overflow: auto; }
.bot {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding: 9px 12px;
  background: var(--card, #26272e);
  color: inherit;
  border: 1px solid var(--line, #33343c);
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
}
.bot:disabled { opacity: 0.5; cursor: default; }
.name { font-size: 13px; }
.sub { font-size: 11px; opacity: 0.6; }
.error { color: #ff8a80; font-size: 12px; }
.row { display: flex; justify-content: flex-end; }

/* 贾维斯界面：对话框变全息面板（输入/按钮由全局 jarvis.css 覆盖） */
[data-theme='jarvis'] .dialog-backdrop {
  background: rgba(3, 8, 16, 0.55);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

[data-theme='jarvis'] .dialog {
  background: rgba(10, 25, 45, 0.92);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border-color: rgba(34, 211, 238, 0.35);
  box-shadow:
    0 0 30px rgba(34, 211, 238, 0.12),
    0 20px 50px rgba(0, 0, 0, 0.6);
}

[data-theme='jarvis'] h3 {
  font-family: var(--font-hud);
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--accent);
}
</style>
