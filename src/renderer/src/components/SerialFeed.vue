<script setup lang="ts">
// 串口内容屏：串口会话从开发板读到的文本，按接收顺序一行行往下排（老的在上、新的往下接），
// 每行文本居中对齐。数据在 deviceUi.serialFeed（broker 的串口会话把字节解码成行推进去）。
// 挂在 App 根级的 device-dock 里（输入框上方的串口相关浮窗正上方、水平居中），
// 同 VoiceHud 一套玻璃 HUD 风格，两主题都挂。没有新行 10 秒后整屏渐隐（平时不占桌面）；
// 串口一有动静就重新亮起。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { deviceUi } from '../lib/devices/broker.js'

const SHOW_LINES = 5
const FADE_AFTER_MS = 10_000

/** 屏上显示最近几行（老 → 新，从上往下接） */
const lines = computed(() => deviceUi.serialFeed.slice(-SHOW_LINES))
/** 铭牌：最近一行来自哪个口（多口混投时跟着最新走） */
const deviceLabel = computed(() => deviceUi.serialFeed.at(-1)?.deviceLabel ?? '')

const visible = ref(deviceUi.serialFeed.length > 0)
let fadeTimer = 0

function bump(): void {
  visible.value = true
  window.clearTimeout(fadeTimer)
  fadeTimer = window.setTimeout(() => (visible.value = false), FADE_AFTER_MS)
}

if (deviceUi.serialFeed.length) bump()
watch(() => deviceUi.serialFeed.length, bump)
onBeforeUnmount(() => window.clearTimeout(fadeTimer))
</script>

<template>
  <Transition name="screen">
    <div v-if="visible && lines.length" class="serial-feed">
      <span class="plate">SERIAL·{{ deviceLabel }}</span>
      <TransitionGroup name="line" tag="div" class="lines">
        <div v-for="line in lines" :key="line.id" class="line">{{ line.text }}</div>
      </TransitionGroup>
    </div>
  </Transition>
</template>

<style scoped>
/* device-dock（输入台上方居中）里的子块：定位由浮坞负责，这里只撑内容、限宽。
   纯显示件不收点按（pointer-events none），渐隐后 v-if 移除、让位给下面的串口浮窗 */
.serial-feed {
  max-width: 100%;
  padding: 15px 18px 9px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel) 78%, transparent);
  backdrop-filter: blur(10px);
  overflow: hidden;
  pointer-events: none;
}

/* 四角 HUD 括号（同 VoiceHud 波形屏那套，两块屏呼应） */
.serial-feed::after {
  content: '';
  position: absolute;
  inset: 4px;
  pointer-events: none;
  background:
    linear-gradient(var(--accent) 0 0) left top / 14px 1.5px,
    linear-gradient(var(--accent) 0 0) left top / 1.5px 14px,
    linear-gradient(var(--accent) 0 0) right top / 14px 1.5px,
    linear-gradient(var(--accent) 0 0) right top / 1.5px 14px,
    linear-gradient(var(--accent) 0 0) left bottom / 14px 1.5px,
    linear-gradient(var(--accent) 0 0) left bottom / 1.5px 14px,
    linear-gradient(var(--accent) 0 0) right bottom / 14px 1.5px,
    linear-gradient(var(--accent) 0 0) right bottom / 1.5px 14px;
  background-repeat: no-repeat;
  opacity: 0.45;
}

/* 铭牌：左上角极小的字距拉开的标签（口名太长截断） */
.plate {
  position: absolute;
  top: 5px;
  left: 10px;
  right: 10px;
  z-index: 1;
  font-size: 8px;
  letter-spacing: 2px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
  pointer-events: none;
}

.lines {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 120px;
}

/* 每行：居中对齐、等宽字（串口日志味）；超长省略（broker 已截 200 字，这里双保险） */
.line {
  max-width: 100%;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  line-height: 20px;
  color: var(--text-2);
}

/* 最新一行亮一点（顺序里一眼看出滚到哪了） */
.line:last-child {
  color: var(--text);
}

/* 整屏淡入淡出（出现 / 10 秒无动静渐隐收起）；不位移——在浮坞竖列里，位移会拖动下面的串口浮窗 */
.screen-enter-active,
.screen-leave-active {
  transition: opacity 0.4s ease;
}

.screen-enter-from,
.screen-leave-to {
  opacity: 0;
}

/* 单行进出：新行从下方淡入接上、被挤掉的行向上淡出，中间的行平滑上移 */
.line-enter-active,
.line-leave-active,
.line-move {
  transition: all 0.25s ease;
}

.line-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.line-leave-to {
  opacity: 0;
}

.line-leave-active {
  position: absolute;
  width: 100%;
  transition: opacity 0.15s ease;
}
</style>
