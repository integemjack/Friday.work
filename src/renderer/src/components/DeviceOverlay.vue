<script setup lang="ts">
// 客户端设备浮层（方案-客户端设备 §4）：
//   授权卡：远端机器第一次要用本机的串口 / 摄像头 / 烧录时问人——允许这次 / 始终允许 / 拒绝（60 秒没人理 = 拒绝）；
//   使用中：正在被远端用着的设备常亮一条，串口会话可以一键断开，烧录显示进度。
// 状态全在 lib/devices/broker.ts 的 deviceUi 里。

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { deviceBroker, deviceUi } from '../lib/devices/broker.js'
import { CAPABILITY_LABEL } from '../lib/devices/grants.js'

const now = ref(Date.now())
let ticker = 0
onMounted(() => {
  ticker = window.setInterval(() => {
    now.value = Date.now()
  }, 500)
})
onBeforeUnmount(() => window.clearInterval(ticker))

const prompts = computed(() => deviceUi.prompts)
const activity = computed(() => deviceUi.activity)

const KIND_LABEL = { serial: '串口', flash: '烧录', info: '读芯片', camera: '摄像头' } as const

function secondsLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - now.value) / 1000))
}
</script>

<template>
  <div v-if="prompts.length || activity.length" class="device-overlay">
    <div v-for="prompt in prompts" :key="prompt.id" class="card prompt" role="alertdialog">
      <div class="title">
        <span class="who">{{ prompt.machineName }}</span> 要用本机的{{ CAPABILITY_LABEL[prompt.capability] }}
      </div>
      <div class="device">{{ prompt.deviceLabel }}</div>
      <div class="action">{{ prompt.action }}</div>
      <div class="actions">
        <button class="btn strong" @click="deviceBroker.answerPrompt(prompt.id, 'once')">允许这次</button>
        <button class="btn" @click="deviceBroker.answerPrompt(prompt.id, 'always')">始终允许</button>
        <button class="btn" @click="deviceBroker.answerPrompt(prompt.id, 'deny')">拒绝（{{ secondsLeft(prompt.expiresAt) }}）</button>
      </div>
    </div>

    <div v-for="item in activity" :key="item.key" class="card busy" role="status">
      <span class="dot" />
      <span class="busy-text">
        {{ item.machineName }} 正在用 {{ KIND_LABEL[item.kind] }} · {{ item.deviceLabel }}
        <span class="detail">{{ item.detail }}</span>
      </span>
      <span v-if="item.progress !== undefined" class="pct">{{ Math.round(item.progress * 100) }}%</span>
      <button v-if="item.kind === 'serial'" class="btn" @click="deviceBroker.stopActivity(item.key)">断开</button>
      <div v-if="item.progress !== undefined" class="progress">
        <div class="bar" :style="{ width: `${Math.round(item.progress * 100)}%` }" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.device-overlay {
  position: fixed;
  top: 56px;
  left: 50%;
  transform: translateX(-50%);
  width: min(380px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 90001; /* 和更新浮层同一层级，授权卡要压过桌面窗口 */
  font-size: 12.5px;
  color: var(--text-2);
}

.card {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
  animation: overlay-in 0.22s ease;
}

@keyframes overlay-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.title {
  color: var(--text);
  line-height: 1.45;
}

.who {
  font-weight: 600;
}

.device {
  margin-top: 4px;
  color: var(--text);
  font-family: 'Cascadia Code', Consolas, monospace;
  word-break: break-all;
}

.action {
  margin-top: 2px;
  color: var(--text-3);
}

.actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  flex-wrap: wrap;
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
  background: var(--chip);
}

.btn.strong {
  color: var(--text);
  background: var(--chip);
}

.busy {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 7px 10px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fail);
  flex: none;
  animation: pulse 1.6s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.busy-text {
  flex: 1;
  min-width: 0;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail {
  color: var(--text-3);
  margin-left: 4px;
}

.pct {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.progress {
  flex-basis: 100%;
  height: 3px;
  border-radius: 2px;
  background: var(--chip);
  overflow: hidden;
}

.bar {
  height: 100%;
  background: var(--text-3);
  transition: width 0.2s ease;
}
</style>
