<script setup lang="ts">
// 附件（顶部导航栏的一颗按钮）：看图/看视频/听录音成功归档的媒体统一收进这里
// （原桌面媒体叠 DesktopMediaStacks 的替代——两张叠卡浮在输入台上方，整合成这一颗按钮）。
// 点按钮在按钮正下方弹出浮窗：最上面一排标签（图片/视频/音频，各带数量）切换分类，
// 标签下缩略格（新归档的在前），点单条进灯箱放大/播放；右上「清空」两步确认
// （连本地缓存一起删，误点找不回来）。Esc / 点浮窗外收起。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore, type StackMediaItem } from '../stores/app.js'
import StackThumb from './StackThumb.vue'

type Kind = 'image' | 'video' | 'audio'

const store = useAppStore()

const KINDS: Array<{ kind: Kind; label: string }> = [
  { kind: 'image', label: '图片' },
  { kind: 'video', label: '视频' },
  { kind: 'audio', label: '音频' }
]

/** 一类附件的条目（新归档的排前面） */
function itemsOf(kind: Kind): StackMediaItem[] {
  return store.stackMedia.filter((item) => item.kind === kind).reverse()
}

/** 附件总数（按钮角标） */
const total = computed(() => store.stackMedia.length)

/** 当前展开的标签 */
const active = ref<Kind>('image')

/** 浮窗开合 + 定位（贴按钮左缘、按钮正下方） */
const btnEl = ref<HTMLElement | null>(null)
const open = ref(false)
const popLeft = ref(0)

function toggle(): void {
  open.value = !open.value
  if (open.value) {
    const rect = btnEl.value?.getBoundingClientRect()
    popLeft.value = Math.max(8, rect ? rect.left : 8)
    // 打开时落到有内容的第一个标签；全空停在「图片」
    const first = KINDS.find((k) => itemsOf(k.kind).length)
    active.value = first?.kind ?? 'image'
    confirmClear.value = false
  }
}

// 当前标签被清空后自动跳到还有内容的标签（全空就停在原处显示空态）
function syncActive(): void {
  if (!itemsOf(active.value).length) {
    const first = KINDS.find((k) => itemsOf(k.kind).length)
    if (first) active.value = first.kind
  }
}

// 清空要点两下：第一下按钮变成「再点确认」，3 秒内再点才真清（会连本地缓存文件一起删，误点找不回来）
const confirmClear = ref(false)
let confirmTimer = 0
function onClear(): void {
  window.clearTimeout(confirmTimer)
  if (confirmClear.value) {
    confirmClear.value = false
    store.clearStack(active.value)
    syncActive()
    return
  }
  confirmClear.value = true
  confirmTimer = window.setTimeout(() => (confirmClear.value = false), 3000)
}
onBeforeUnmount(() => window.clearTimeout(confirmTimer))

function pick(kind: Kind): void {
  active.value = kind
  confirmClear.value = false
}

function zoom(item: StackMediaItem): void {
  store.openMediaZoom(item)
}

// 灯箱（MediaLightbox）开着吗——用 DOM 判断而不是 store.zoomMedia：Esc 按下时灯箱的
// 监听器可能已先把 zoomMedia 置空（同步赋值），但 DOM 要到 nextTick 才卸——同一个
// 事件循环里查 .lightbox 总能看出灯箱刚才还开着，两种监听顺序都判得对
function lightboxOpen(): boolean {
  return document.querySelector('.lightbox') !== null
}

// Esc 收起（抢在 App 的会话取消之前，照机器菜单的做法 preventDefault）。
// 灯箱开着时这次 Esc 归灯箱——只关灯箱，浮窗留着继续点别的附件
function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !open.value) return
  if (lightboxOpen()) return
  event.preventDefault()
  open.value = false
}

// 点浮窗外收起（点按钮自身不算——那是开关；浮窗内部 @mousedown.stop）。
// 点的是灯箱（关灯箱）时不动浮窗
function onDocMouseDown(event: MouseEvent): void {
  if (!open.value) return
  if (!(event.target instanceof Element)) return
  if (event.target.closest('.lightbox')) return
  if (event.target.closest('.attachments-pop, .attachments-btn')) return
  open.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <button
    ref="btnEl"
    class="launch-btn attachments-btn"
    :class="{ open }"
    :title="`附件：看过的图片 / 视频 / 听过的录音归档（共 ${total} 条），点开按标签查看`"
    @click="toggle"
  >
    <svg class="ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M12.9 7.6 7.8 12.7a3.1 3.1 0 0 1-4.4-4.4l5.5-5.5a2.1 2.1 0 0 1 3 3l-5.5 5.5a1.1 1.1 0 0 1-1.5-1.5l5-5"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <span v-if="total" class="launch-badge">{{ total > 99 ? '99+' : total }}</span>
  </button>

  <teleport to="body">
    <Transition name="pop">
      <div v-if="open" class="attachments-pop cast-scroll" :style="{ left: popLeft + 'px' }" @mousedown.stop>
        <!-- 顶部标签栏：图片 / 视频 / 音频（各带数量）+ 右侧清空 -->
        <div class="pop-head">
          <div class="pop-tabs">
            <button
              v-for="k in KINDS"
              :key="k.kind"
              class="pop-tab"
              :class="{ active: active === k.kind, none: !itemsOf(k.kind).length }"
              @click="pick(k.kind)"
            >
              {{ k.label }}<span class="tab-count">{{ itemsOf(k.kind).length }}</span>
            </button>
          </div>
          <button
            class="clear"
            :class="{ armed: confirmClear }"
            :title="confirmClear ? '再点一次清空（本地缓存一起删）' : `清空${KINDS.find((k) => k.kind === active)?.label}附件`"
            @click="onClear"
          >
            {{ confirmClear ? '再点确认' : '清空' }}
          </button>
        </div>

        <div v-if="itemsOf(active).length" class="thumbs">
          <button
            v-for="item in itemsOf(active)"
            :key="item.id"
            class="thumb-btn"
            :title="item.src"
            @click="zoom(item)"
          >
            <StackThumb :item="item" size="grid" />
          </button>
        </div>
        <div v-else class="empty">这一类还没有归档</div>
      </div>
    </Transition>
  </teleport>
</template>

<style scoped>
/* 按钮照标题栏启动器同款（28px 圆角钮、悬停点亮、点亮态青色描底）——
   TitleBar 的 .launch-btn 是 scoped 样式，这里自己带一份 */
.launch-btn {
  width: 28px;
  height: 28px;
  position: relative;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  opacity: 0.62;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s, box-shadow 0.12s;
}

.launch-btn .ico {
  width: 15px;
  height: 15px;
  display: block;
}

.launch-btn:hover {
  background: var(--hover);
  opacity: 1;
}

.launch-btn.open {
  opacity: 1;
  background: var(--accent-weak);
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--accent) 65%, transparent);
}

.launch-badge {
  position: absolute;
  top: 1px;
  right: 0;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--accent);
  color: var(--accent-foreground);
  font-size: 9px;
  font-weight: 700;
  line-height: 13px;
  text-align: center;
}

/* ---- 浮窗：贴在按钮正下方（teleport 到 body，left 由脚本按按钮位置给出） ---- */
.attachments-pop {
  position: fixed;
  top: 48px;
  z-index: 60; /* 盖过标题栏机器菜单（50），不压灯箱（9500） */
  width: 316px;
  max-height: min(56vh, 480px);
  overflow-y: auto;
  padding: 9px 10px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
}

.pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 9px;
  position: sticky;
  top: -9px; /* 头部抵着浮窗内边距顶：缩略格滚动时标签栏钉在最上面 */
  padding-top: 9px;
  margin-top: -9px;
  background: var(--panel);
  z-index: 1;
}

.pop-tabs {
  display: flex;
  gap: 3px;
}

.pop-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.pop-tab:hover {
  background: var(--hover);
}

.pop-tab.active {
  background: var(--accent-weak);
  color: var(--text);
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--accent) 65%, transparent);
}

.pop-tab.none {
  opacity: 0.55;
}

.tab-count {
  font-size: 10.5px;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}

.clear {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text-3);
  font-size: 10.5px;
  padding: 2px 8px;
  border-radius: 5px;
  cursor: pointer;
  flex: none;
}

.clear:hover,
.clear.armed {
  border-color: var(--fail);
  color: var(--fail);
}

.clear.armed {
  background: color-mix(in srgb, var(--fail) 14%, transparent);
}

/* ---- 缩略格（照原媒体叠展开格：3 列 72px 高） ---- */
.thumbs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 7px;
}

.thumb-btn {
  height: 72px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  cursor: zoom-in;
  background: transparent;
  transition: border-color 0.15s ease;
}

.thumb-btn:hover {
  border-color: var(--accent);
}

.empty {
  font-size: 11.5px;
  color: var(--text-3);
  text-align: center;
  padding: 16px 0 8px;
}
</style>
