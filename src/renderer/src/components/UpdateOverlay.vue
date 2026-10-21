<script setup lang="ts">
// 桌面更新浮层：把主进程 ClientUpdate 的更新进度直接摆到桌面上（右下角小卡），
// 不用开设置窗口就能看见——自动管线（定时检查发现新版本）全程在这里播报：
//   发现新版本 → 下载（进度条）→ 已就绪（倒计时 + 立即重启/稍后）→ 安装中（随后应用自动重启）。
// 手动路径只在下载时露面（进度条）；mac/Linux 没有「装完自启」的路，
// 发现新版本时长驻提示、一键去设置下载。错误只在自动管线里打扰人（手动错误设置页里看得到）。

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()
const update = computed(() => store.update)

// 倒计时显示：restartAt 是主进程给的绝对时刻，本地 250ms 一跳
const now = ref(Date.now())
let ticker = 0
onMounted(() => {
  ticker = window.setInterval(() => {
    now.value = Date.now()
  }, 250)
})
onBeforeUnmount(() => window.clearInterval(ticker))
const secondsLeft = computed(() => Math.max(0, Math.ceil((update.value.restartAt - now.value) / 1000)))
const percent = computed(() => Math.round(update.value.progress * 100))

// 错误/新版本提示的「知道了」：本地记住已读，状态再变才重新出现
const dismissedError = ref('')
const dismissedVersion = ref('')

const visible = computed(() => {
  const { phase, auto, restartAt, platform, version, error } = update.value
  if (phase === 'downloading' || phase === 'installing') return true
  if (phase === 'ready') return restartAt > 0
  if (phase === 'available') {
    // win32 自动管线发现后立刻转下载，available 一闪而过；mac/Linux 长驻提示去设置
    if (platform !== 'win32') return version !== dismissedVersion.value
    return auto
  }
  if (phase === 'error') return auto && !!error && error !== dismissedError.value
  return false
})

const isCountdown = computed(() => update.value.phase === 'ready' && update.value.restartAt > 0)

function openSettings(): void {
  store.openWindow('settings')
  dismissedVersion.value = update.value.version
}
</script>

<template>
  <div v-if="visible" class="update-overlay" role="status">
    <!-- 下载中：标题 + 进度条 + 百分比 -->
    <template v-if="update.phase === 'downloading'">
      <div class="title">下载更新 v{{ update.version }}</div>
      <div class="progress">
        <div class="bar" :style="{ width: `${percent}%` }" />
      </div>
      <div class="meta">{{ percent }}%</div>
    </template>

    <!-- 已就绪：倒计时（可立即重启 / 稍后） -->
    <template v-else-if="isCountdown">
      <div class="title">v{{ update.version }} 已就绪，{{ secondsLeft }} 秒后自动重启更新</div>
      <div class="actions">
        <button class="btn strong" @click="store.applyUpdateNow()">立即重启</button>
        <button class="btn" @click="store.postponeUpdate()">稍后（退出时装）</button>
      </div>
    </template>

    <!-- 安装中：马上就要重启了 -->
    <template v-else-if="update.phase === 'installing'">
      <div class="title">正在安装 v{{ update.version }}，应用即将重启…</div>
    </template>

    <!-- mac / Linux：有新版本，去设置下载 -->
    <template v-else-if="update.phase === 'available'">
      <div class="title">发现新版本 v{{ update.version }}</div>
      <div class="actions">
        <button class="btn strong" @click="openSettings">去设置下载</button>
        <button class="btn" @click="dismissedVersion = update.version">知道了</button>
      </div>
    </template>

    <!-- 自动管线出错：可重试（定时器下一轮也会自己再试） -->
    <template v-else-if="update.phase === 'error'">
      <div class="title err">更新失败：{{ update.error }}</div>
      <div class="actions">
        <button class="btn strong" @click="store.installUpdate()">重试</button>
        <button class="btn" @click="dismissedError = update.error">知道了</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.update-overlay {
  position: fixed;
  /* 底部居中、悬在输入台上方：左下/右下角分别压到主输入台和聊天输入区，
     中间主区是投层气泡的地盘，盖几秒最不挡事 */
  left: 50%;
  bottom: 150px;
  transform: translateX(-50%);
  width: min(340px, calc(100vw - 32px));
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
  font-size: 12.5px;
  color: var(--text-2);
  z-index: 90000; /* 压过桌面/窗口，让位给全局错误横幅（100000） */
  animation: overlay-in 0.22s ease;
}

@keyframes overlay-in {
  from {
    opacity: 0;
    transform: translate(-50%, 8px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

.title {
  color: var(--text);
  line-height: 1.45;
}

.title.err {
  color: var(--fail);
  word-break: break-all;
}

.progress {
  height: 4px;
  border-radius: 2px;
  background: var(--chip);
  overflow: hidden;
  margin: 8px 0 6px;
}

.bar {
  height: 100%;
  border-radius: 2px;
  background: var(--text-3);
  transition: width 0.2s ease;
}

.meta {
  font-size: 11.5px;
  color: var(--text-3);
  text-align: right;
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.btn {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}

.btn:hover {
  color: var(--text);
}

.btn.strong {
  color: var(--text);
  border-color: var(--text-3);
}

/* 贾维斯风：主按钮换成青色描边 + 微光，和设置页等处的强调按钮一致 */
[data-theme='jarvis'] .btn.strong {
  color: var(--accent);
  border-color: var(--accent-a55);
  box-shadow: 0 0 10px var(--accent-a15);
}

[data-theme='jarvis'] .update-overlay {
  border-color: var(--accent-a55);
  box-shadow: 0 0 18px var(--accent-a15), 0 8px 28px rgba(0, 0, 0, 0.4);
}

[data-theme='jarvis'] .bar {
  background: var(--accent);
}
</style>
