<script setup lang="ts">
// 桌面上的一个窗口（用户 2026-10-19 要求：每一样都以窗口形式显示）：
// 标题栏拖动、右下角/边角缩放、最小化/最大化/关闭、点击置顶。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface WindowRect {
  x: number
  y: number
  w: number
  h: number
}

const props = defineProps<{
  id: string
  title: string
  icon: string
  rect: WindowRect
  z: number
  minimized: boolean
  maximized: boolean
  minWidth?: number
  minHeight?: number
  /** 外框朴素：不画四角括号与顶缘光线、不加青色外发光（终端用，2026-10-21）。
   *  背景与模糊不走这里——和文件窗口同一套（见 styles 里的 .win） */
  plainChrome?: boolean
}>()

const emit = defineEmits<{
  focus: []
  close: []
  minimize: []
  toggleMaximize: []
  move: [rect: WindowRect]
  resize: [rect: WindowRect]
}>()

const MIN_WIDTH = props.minWidth ?? 360
const MIN_HEIGHT = props.minHeight ?? 260

type DragMode = 'move' | 'e' | 's' | 'se' | 'w' | 'n' | 'sw' | 'ne' | 'nw' | null
const dragging = ref<DragMode>(null)

let startPointer = { x: 0, y: 0 }
let startRect: WindowRect = { x: 0, y: 0, w: 0, h: 0 }
const rootEl = ref<HTMLElement | null>(null)

/** 窗口至少露在桌面里的部分：横向 120px、纵向整条标题栏——拖出右/下边缘也抓得回来 */
const KEEP_VISIBLE_X = 120
const TITLE_H = 34

/** 窗口层（定位父级）的尺寸；拿不到时退回视口 */
function layerSize(): { w: number; h: number } {
  const layer = rootEl.value?.offsetParent as HTMLElement | null
  return { w: layer?.clientWidth || window.innerWidth, h: layer?.clientHeight || window.innerHeight }
}

function clampPosition(x: number, y: number, w: number): { x: number; y: number } {
  const layer = layerSize()
  return {
    x: Math.min(Math.max(-w + KEEP_VISIBLE_X, x), Math.max(0, layer.w - KEEP_VISIBLE_X)),
    y: Math.min(Math.max(0, y), Math.max(0, layer.h - TITLE_H))
  }
}

const style = computed(() => {
  if (props.maximized) {
    return { left: '0px', top: '0px', width: '100%', height: '100%', zIndex: props.z }
  }
  return {
    left: `${props.rect.x}px`,
    top: `${props.rect.y}px`,
    width: `${props.rect.w}px`,
    height: `${props.rect.h}px`,
    zIndex: props.z
  }
})

function beginDrag(mode: DragMode, event: MouseEvent): void {
  if (event.button !== 0) return
  if (props.maximized && mode === 'move') return
  event.preventDefault()
  emit('focus')
  dragging.value = mode
  startPointer = { x: event.clientX, y: event.clientY }
  startRect = { ...props.rect }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function onMove(event: MouseEvent): void {
  const mode = dragging.value
  if (!mode) return
  const dx = event.clientX - startPointer.x
  const dy = event.clientY - startPointer.y
  if (mode === 'move') {
    // 原来只限了左/上：往右/下拖能把整个窗口连标题栏一起拖出桌面，再也抓不回来
    const next = clampPosition(startRect.x + dx, startRect.y + dy, startRect.w)
    emit('move', { x: next.x, y: next.y, w: startRect.w, h: startRect.h })
    return
  }
  let { x, y, w, h } = startRect
  if (mode.includes('e')) w = Math.max(MIN_WIDTH, startRect.w + dx)
  if (mode.includes('s')) h = Math.max(MIN_HEIGHT, startRect.h + dy)
  if (mode.includes('w')) {
    const nextW = Math.max(MIN_WIDTH, startRect.w - dx)
    x = startRect.x + (startRect.w - nextW)
    w = nextW
  }
  if (mode.includes('n')) {
    const nextH = Math.max(MIN_HEIGHT, startRect.h - dy)
    y = startRect.y + (startRect.h - nextH)
    h = nextH
  }
  // 缩放的四个方向也要钳回桌面：w/n 手柄能把标题栏推出桌面外，
  // 整个窗口再也抓不回来（move 有钳，缩放没有）
  const clamped = clampPosition(x, y, w)
  emit('resize', { x: clamped.x, y: clamped.y, w, h })
}

function onUp(): void {
  dragging.value = null
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onUp)
}

// 主窗口缩小后，原来在右/下边的浮动窗口可能整个落到桌面外：缩放时收回来
let resizeRaf = 0
function onWindowResize(): void {
  cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => {
    if (props.maximized || props.minimized) return
    const next = clampPosition(props.rect.x, props.rect.y, props.rect.w)
    if (next.x !== props.rect.x || next.y !== props.rect.y) emit('move', { ...props.rect, ...next })
  })
}

onMounted(() => window.addEventListener('resize', onWindowResize))
onBeforeUnmount(() => {
  onUp()
  cancelAnimationFrame(resizeRaf)
  window.removeEventListener('resize', onWindowResize)
})
</script>

<template>
  <div
    v-show="!minimized"
    ref="rootEl"
    class="win"
    :class="{ maximized, dragging, 'plain-chrome': plainChrome }"
    :style="style"
    @mousedown="emit('focus')"
  >
    <div class="win-title" @mousedown="beginDrag('move', $event)" @dblclick="emit('toggleMaximize')">
      <span class="win-icon">{{ icon }}</span>
      <span class="win-text">{{ title }}</span>
      <div class="win-buttons" @mousedown.stop>
        <button class="win-btn" title="最小化" @click="emit('minimize')">─</button>
        <button class="win-btn" :title="maximized ? '还原' : '最大化'" @click="emit('toggleMaximize')">
          {{ maximized ? '❐' : '□' }}
        </button>
        <button class="win-btn close" title="关闭" @click="emit('close')">✕</button>
      </div>
    </div>

    <div class="win-body">
      <slot />
    </div>

    <!-- 缩放热区（最大化时不要） -->
    <template v-if="!maximized">
      <div class="handle e" @mousedown.stop="beginDrag('e', $event)" />
      <div class="handle s" @mousedown.stop="beginDrag('s', $event)" />
      <div class="handle se" @mousedown.stop="beginDrag('se', $event)" />
      <div class="handle w" @mousedown.stop="beginDrag('w', $event)" />
      <div class="handle n" @mousedown.stop="beginDrag('n', $event)" />
      <div class="handle sw" @mousedown.stop="beginDrag('sw', $event)" />
      <div class="handle ne" @mousedown.stop="beginDrag('ne', $event)" />
      <div class="handle nw" @mousedown.stop="beginDrag('nw', $event)" />
    </template>
  </div>
</template>

<style scoped>
.win {
  position: absolute;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16), 0 1px 2px rgba(0, 0, 0, 0.08);
  overflow: hidden;
  min-width: 0;
  min-height: 0;
}

.win.maximized {
  border-radius: 0;
  border: none;
}

.win.dragging {
  user-select: none;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.24);
}

/* 终端窗外框朴素：不画四角括号与顶缘光线，也不加青色外发光（只留一道描边 + 投影）。
   背景与模糊和文件窗口同一套（默认 .win 的 --panel、jarvis 的 blur(14px)），这里不再另设——
   终端画布本身是透明的，磨砂效果由窗体这层给 */
[data-theme='jarvis'] .win.plain-chrome,
[data-theme='jarvis'] .win.plain-chrome.dragging {
  box-shadow:
    0 0 0 1px var(--accent-a10),
    0 12px 30px rgba(0, 0, 0, 0.45);
}

[data-theme='jarvis'] .win.plain-chrome::before,
[data-theme='jarvis'] .win.plain-chrome::after {
  content: none;
}

.win-title {
  flex: none;
  height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 6px 0 12px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
  cursor: default;
  user-select: none;
}

.win-icon {
  font-size: 13px;
  opacity: 0.85;
}

.win-text {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.win-buttons {
  display: flex;
  gap: 2px;
}

.win-btn {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-2);
  border-radius: 5px;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}

.win-btn:hover {
  background: var(--hover);
  color: var(--text);
}

.win-btn.close:hover {
  background: var(--fail);
  color: #fff;
}

/* 贾维斯界面：窗口像悬浮的全息面板——半透明磨砂玻璃 + 青色描边 + 外发光，打开时全息展开 */
[data-theme='jarvis'] .win {
  border-color: var(--accent-a32);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  animation: jarvis-boot 0.26s ease-out;
  box-shadow:
    0 0 0 1px var(--accent-a10),
    0 0 22px var(--accent-a9),
    0 14px 36px rgba(0, 0, 0, 0.55);
}

@keyframes jarvis-boot {
  from {
    opacity: 0;
    transform: scale(0.965);
    filter: brightness(1.7);
  }
}

[data-theme='jarvis'] .win.dragging {
  box-shadow:
    0 0 0 1px var(--accent-a20),
    0 0 34px var(--accent-a16),
    0 20px 48px rgba(0, 0, 0, 0.6);
}

[data-theme='jarvis'] .win-title {
  border-bottom-color: var(--accent-a28);
}

[data-theme='jarvis'] .win-text {
  color: var(--accent);
  letter-spacing: 1.5px;
  text-transform: uppercase;
  text-shadow: 0 0 12px var(--accent-a35);
}

/* 窗体四角 HUD 括号 + 顶缘中央光线：全息面板的锁定框感（不拦鼠标）
   注意：background-repeat 必须写在每条 background 简写之后——
   简写会把 repeat 重置回初始值，漏写会让 15px 小条平铺满整个窗口（就出过这个事故） */
[data-theme='jarvis'] .win::before,
[data-theme='jarvis'] .win::after {
  content: '';
  position: absolute;
  inset: 4px;
  z-index: 3;
  pointer-events: none;
}

[data-theme='jarvis'] .win::before {
  background:
    linear-gradient(var(--accent) 0 0) left top / 15px 1.5px,
    linear-gradient(var(--accent) 0 0) left top / 1.5px 15px,
    linear-gradient(var(--accent) 0 0) right bottom / 15px 1.5px,
    linear-gradient(var(--accent) 0 0) right bottom / 1.5px 15px;
  background-repeat: no-repeat;
  opacity: 0.75;
}

[data-theme='jarvis'] .win::after {
  background:
    linear-gradient(var(--accent) 0 0) right top / 15px 1.5px,
    linear-gradient(var(--accent) 0 0) right top / 1.5px 15px,
    linear-gradient(var(--accent) 0 0) left bottom / 15px 1.5px,
    linear-gradient(var(--accent) 0 0) left bottom / 1.5px 15px,
    linear-gradient(90deg, transparent, var(--accent-a55), transparent) center top / 42% 1px;
  background-repeat: no-repeat;
  opacity: 0.75;
}

[data-theme='jarvis'] .win.maximized::before,
[data-theme='jarvis'] .win.maximized::after {
  display: none;
}

.win-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.handle {
  position: absolute;
  z-index: 2;
}

.handle.e { top: 8px; right: -3px; bottom: 8px; width: 7px; cursor: ew-resize; }
.handle.w { top: 8px; left: -3px; bottom: 8px; width: 7px; cursor: ew-resize; }
.handle.s { left: 8px; right: 8px; bottom: -3px; height: 7px; cursor: ns-resize; }
.handle.n { left: 8px; right: 8px; top: -3px; height: 7px; cursor: ns-resize; }
.handle.se { right: -3px; bottom: -3px; width: 14px; height: 14px; cursor: nwse-resize; }
.handle.sw { left: -3px; bottom: -3px; width: 14px; height: 14px; cursor: nesw-resize; }
.handle.ne { right: -3px; top: -3px; width: 14px; height: 14px; cursor: nesw-resize; }
.handle.nw { left: -3px; top: -3px; width: 14px; height: 14px; cursor: nwse-resize; }
</style>
