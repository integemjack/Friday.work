<script setup lang="ts">
// 桌面气泡（2026-10 布局改版）：会话的思考 / 文本输出直接投在桌面随机位置，
// 随流式增长，5 秒无新内容渐隐消失。数据与定时全在 store（pushBubble / fadeBubble）。
// 高度规则：底边不出桌面——长到底就整体上移；高到顶就内部滚动，自动滚到最新一条。
import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import { useAppStore } from '../stores/app.js'
import { renderMarkdown } from '../lib/markdown.js'

const store = useAppStore()

/** 气泡的 Markdown 缓存：流式每续一片都会重渲染整条，按 text 是否变化免重复解析 */
const mdHtml = new Map<string, { text: string; html: string }>()
function mdOf(bubble: { id: string; text: string }): string {
  const cached = mdHtml.get(bubble.id)
  if (cached && cached.text === bubble.text) return cached.html
  const html = renderMarkdown(bubble.text)
  mdHtml.set(bubble.id, { text: bubble.text, html })
  return html
}

const TOP_SAFE = 60 // 桌面顶部安全边（HUD 之下）
const BOTTOM_SAFE = 12 // 桌面底部安全边

const elOf = new Map<string, HTMLElement>()
/** 用户滚轮上翻过的气泡：流式跟随滚动要让路（别把正在看旧内容的人拽回底部）；
 *  滚回底部附近时清除标记，恢复跟随 */
const scrolledUp = new Map<string, true>()
function setEl(id: string, el: unknown) {
  if (el instanceof HTMLElement) {
    elOf.set(id, el)
    el.addEventListener('wheel', () => scrolledUp.set(id, true), { passive: true })
  } else elOf.delete(id)
}

/** 越界修正 + 跟底：底边超出气泡层就整体上移；内部能滚时滚到最底（新内容从下面滚上来）。
 *  统一用气泡层内坐标（offsetTop/offsetHeight，不随进出场动画的 transform 抖动） */
async function adjust() {
  await nextTick()
  const first = store.bubbles.map((b) => elOf.get(b.id)).find(Boolean)
  const layer = first ? (first.offsetParent as HTMLElement | null) : null
  if (!layer) return
  const limit = layer.clientHeight - BOTTOM_SAFE
  const maxH = Math.max(120, limit - TOP_SAFE)
  for (const bubble of store.bubbles) {
    const el = elOf.get(bubble.id)
    if (!el) continue
    // 思考与回复气泡都限高 400px（超长内部滚动、自动滚到最新）；窗口矮时再按窗口高收紧
    el.style.maxHeight = `${Math.min(400, maxH)}px`
    if (el.offsetTop + el.offsetHeight > limit) {
      store.shiftBubbleY(bubble.id, limit - el.offsetTop - el.offsetHeight)
    }
    const body = el.querySelector('.text')
    if (body instanceof HTMLElement && body.scrollHeight > body.clientHeight + 1) {
      const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 48
      if (nearBottom) scrolledUp.delete(bubble.id)
      // 只在用户没有上翻（或已翻回底）时跟随到最新；用户停在上方看旧内容时不拽
      if (!scrolledUp.has(bubble.id)) body.scrollTop = body.scrollHeight
    }
  }
}

function onResize() {
  void adjust()
}

watch(
  () => store.bubbles.map((b) => `${b.id}:${b.text.length}:${b.fading}:${b.y}`).join('|'),
  () => {
    // 顺手回收已删气泡的 md 缓存与上翻标记（气泡 5 秒渐隐后从数组移除，缓存不能跟着漏）
    const alive = new Set(store.bubbles.map((b) => b.id))
    for (const id of mdHtml.keys()) if (!alive.has(id)) mdHtml.delete(id)
    for (const id of scrolledUp.keys()) if (!alive.has(id)) scrolledUp.delete(id)
    void adjust()
  },
  { immediate: true }
)
onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => window.removeEventListener('resize', onResize))

function titleOf(conversationID: string): string {
  return store.summaries.find((item) => item.id === conversationID)?.title ?? '会话'
}
</script>

<template>
  <div class="bubble-layer">
    <transition-group name="pop">
      <div
        v-for="bubble in store.bubbles"
        :key="bubble.id"
        :ref="(el) => setEl(bubble.id, el)"
        class="bubble"
        :class="[bubble.kind, { fading: bubble.fading }]"
        :style="{ left: `${bubble.x}px`, top: `${bubble.y}px`, zIndex: bubble.z }"
        @click="store.fadeBubble(bubble.id)"
      >
        <span class="tag">{{ bubble.kind === 'thinking' ? '思考' : '回复' }} · {{ titleOf(bubble.conversationID) }}</span>
        <!-- 思考/回复气泡统一 Markdown 渲染（renderMarkdown 已禁透传 HTML、breaks 保换行） -->
        <div class="text md" v-html="mdOf(bubble)" />
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.bubble-layer {
  /* 不设 z-index（auto 不建层叠上下文）：与操作卡层同在投层里，气泡/卡的 z 才能跨类比较（最近活动的置顶） */
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.bubble {
  position: absolute;
  pointer-events: auto;
  max-width: 360px;
  /* 底边不出桌面：超高先上移，顶到头再内部滚动（maxHeight 由 adjust() 按窗口高度设置） */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 8px 12px 9px;
  border-radius: 14px;
  border: 1px solid var(--accent-a35);
  background: var(--panel-card-deep-a80, rgba(10, 16, 28, 0.82));
  box-shadow:
    0 0 16px var(--accent-a12),
    0 12px 30px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tag {
  /* 标题行不参与收缩：气泡限高、内容超高时 .text 内部滚动，标题不能被压扁遮挡 */
  flex-shrink: 0;
  font-family: var(--font-hud);
  font-size: 9.5px;
  letter-spacing: 2px;
  color: var(--accent);
  opacity: 0.75;
  /* 占满整宽，超出的会话名在右缘渐隐，不用 ... 截断 */
  overflow: hidden;
  white-space: nowrap;
  -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);
  mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);
}

.bubble.thinking .tag {
  color: var(--warn);
}

/* 气泡限高 400px：超长内部滚动（adjust() 会再按窗口高度收紧）；思考/回复一致 */
.bubble {
  max-height: 400px;
}

.text {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-word;
  /* 气泡顶到头后内部滚动：flex 子项缩到 0 起滚，adjust() 自动滚到最新一条 */
  min-height: 0;
  overflow-y: auto;
  /* 滚动条贴紧气泡右边框：右拉到边（负 margin 抵消气泡右内边距），文字再补回右内边距；
     槽位常驻，出现滚动条时文字宽度不跳变 */
  margin-right: -12px;
  padding-right: 12px;
  scrollbar-gutter: stable;
}

/* 气泡内的滚动条：比全局窄一半，贴着右边框立一道细光条 */
.text::-webkit-scrollbar {
  width: 6px;
}

.text::-webkit-scrollbar-thumb {
  background: var(--accent-a45);
  border: none;
  border-radius: 3px;
}

.text::-webkit-scrollbar-thumb:hover {
  background: var(--accent-a70);
}

.text::-webkit-scrollbar-track {
  background: transparent;
}

/* 回复气泡的 Markdown：块级标签之间的源码换行不是文本，必须关掉 .text 的 pre-wrap */
.text.md {
  white-space: normal;
}

.text.md :deep(p) {
  margin: 0 0 6px;
}

.text.md :deep(p:last-child) {
  margin-bottom: 0;
}

.text.md :deep(h1),
.text.md :deep(h2),
.text.md :deep(h3),
.text.md :deep(h4) {
  margin: 8px 0 4px;
  line-height: 1.35;
  font-weight: 650;
  font-size: 1.08em;
}

.text.md :deep(h1:first-child),
.text.md :deep(h2:first-child),
.text.md :deep(h3:first-child) {
  margin-top: 0;
}

.text.md :deep(ul),
.text.md :deep(ol) {
  margin: 4px 0;
  padding-left: 18px;
}

.text.md :deep(li) {
  margin: 2px 0;
}

.text.md :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.text.md :deep(a:hover) {
  text-decoration: underline;
}

.text.md :deep(blockquote) {
  margin: 4px 0;
  padding: 0 10px;
  border-left: 2px solid var(--accent-a35);
  opacity: 0.88;
}

.text.md :deep(code) {
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 11.5px;
  background: var(--code-bg);
  border-radius: 4px;
  padding: 1px 4px;
}

.text.md :deep(pre) {
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 11.5px;
  background: var(--code-bg);
  border-radius: 8px;
  padding: 7px 9px;
  margin: 4px 0;
  overflow: auto;
  white-space: pre;
}

.text.md :deep(pre code) {
  background: none;
  padding: 0;
  font-size: inherit;
}

.text.md :deep(table) {
  border-collapse: collapse;
  margin: 4px 0;
  font-size: 12px;
}

.text.md :deep(th),
.text.md :deep(td) {
  border: 1px solid var(--border);
  padding: 3px 8px;
}

/* 渐隐：5 秒计时到 → fadeBubble 加 fading → 动画完从数组里删 */
.bubble.fading {
  animation: bubble-out 0.6s ease forwards;
}

@keyframes bubble-out {
  to {
    opacity: 0;
    transform: translateY(6px) scale(0.97);
  }
}

.pop-enter-active {
  animation: bubble-in 0.22s ease;
}

@keyframes bubble-in {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.96);
  }
}
</style>
