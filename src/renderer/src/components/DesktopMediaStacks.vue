<script setup lang="ts">
// 桌面媒体叠（2026-10）：看图/看视频成功的媒体自动归档——图片一叠、视频一叠，
// 压在桌面最底层（气泡/操作卡/浮动窗口都在它上面，被盖住就点不到，同桌面图标）。
// 收起是一张小叠卡：最新一张做封面 + 数量角标；点一下展开成缩略格（在叠上方浮出），
// 再点一下（或点桌面空白处）收起。点格里的单张媒体进灯箱放大（MediaLightbox）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore, type StackMediaItem } from '../stores/app.js'
import StackThumb from './StackThumb.vue'

const store = useAppStore()

const images = computed(() => store.stackMedia.filter((item) => item.kind === 'image'))
const videos = computed(() => store.stackMedia.filter((item) => item.kind === 'video'))

// 主区底部居中悬浮着输入台（.composer-dock，占满窄主区的底边）：
// 叠得在它上方，不然被它盖住点不到。监听它的高度变化（输入框展开/收起）自动抬升。
const root = ref<HTMLElement | null>(null)
const bottomPx = ref(14)
let dockObserver: ResizeObserver | null = null

function updateBottom(): void {
  const area = root.value?.parentElement
  const dock = area?.querySelector('.composer-dock')
  if (!area || !(dock instanceof HTMLElement)) return
  const dr = dock.getBoundingClientRect()
  const ar = area.getBoundingClientRect()
  bottomPx.value = dr.height > 0 ? Math.max(14, ar.bottom - dr.top + 10) : 14
}

onMounted(() => {
  updateBottom()
  const dock = root.value?.parentElement?.querySelector('.composer-dock')
  if (dock instanceof HTMLElement) {
    dockObserver = new ResizeObserver(updateBottom)
    dockObserver.observe(dock)
  }
  window.addEventListener('resize', updateBottom)
})

onBeforeUnmount(() => {
  dockObserver?.disconnect()
  window.removeEventListener('resize', updateBottom)
})

function itemsOf(kind: 'image' | 'video'): StackMediaItem[] {
  return kind === 'image' ? images.value : videos.value
}

/** 封面：归档得最晚的那张（数组尾部） */
function coverOf(kind: 'image' | 'video'): StackMediaItem | undefined {
  const list = itemsOf(kind)
  return list.length ? list[list.length - 1] : undefined
}

const LABEL: Record<'image' | 'video', string> = { image: '图片', video: '视频' }

/** 当前展开的是哪一叠（同一时刻至多一叠展开；'' = 全收起） */
const expanded = ref<'' | 'image' | 'video'>('')

function toggle(kind: 'image' | 'video'): void {
  expanded.value = expanded.value === kind ? '' : kind
}

/** 展开格里的顺序：新归档的排前面（叠封面也是最新，对得上） */
function newestFirst(kind: 'image' | 'video'): StackMediaItem[] {
  return itemsOf(kind).slice().reverse()
}

function zoom(item: StackMediaItem): void {
  store.openMediaZoom(item)
}

// 点桌面空白处收起展开的叠（点在叠上不收，缩略格/封面按钮里已 stop）
function onDocMouseDown(event: MouseEvent): void {
  if (!expanded.value) return
  if (!(event.target instanceof Element)) return
  if (event.target.closest('.media-stacks')) return
  expanded.value = ''
}

onMounted(() => document.addEventListener('mousedown', onDocMouseDown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMouseDown))
</script>

<template>
  <div ref="root" class="media-stacks" :style="{ bottom: bottomPx + 'px' }">
    <!-- 没媒体的叠不渲染：桌面上不摆空占位 -->
    <div
      v-for="kind in (['image', 'video'] as const)"
      v-show="itemsOf(kind).length"
      :key="kind"
      class="stack"
      :class="{ open: expanded === kind }"
    >
      <!-- 展开的缩略格：浮在叠上方，超高内部滚动 -->
      <Transition name="pop">
        <div v-if="expanded === kind" class="stack-panel cast-scroll" @mousedown.stop>
          <div class="panel-head">
            <span class="panel-title">{{ LABEL[kind] }}叠 · {{ itemsOf(kind).length }}</span>
            <button class="clear" title="清空这一叠" @click.stop="store.clearStack(kind)">清空</button>
          </div>
          <div v-if="newestFirst(kind).length" class="thumbs">
            <button
              v-for="item in newestFirst(kind)"
              :key="item.id"
              class="thumb-btn"
              :title="item.src"
              @click.stop="zoom(item)"
            >
              <StackThumb :item="item" size="grid" />
            </button>
          </div>
          <div v-else class="empty">空了</div>
        </div>
      </Transition>

      <!-- 收起的叠卡：最新一张做封面 + 数量角标（空叠整体被 v-show 藏掉，这里只是兑底） -->
      <button class="pile" :title="`${LABEL[kind]}叠（${itemsOf(kind).length}）`" @click="toggle(kind)">
        <span class="cover">
          <StackThumb v-if="coverOf(kind)" :item="coverOf(kind)!" size="pile" />
          <span v-else class="cover-empty">🖼</span>
          <span v-if="itemsOf(kind).length" class="count">{{ itemsOf(kind).length }}</span>
        </span>
        <span class="pile-label">{{ LABEL[kind] }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 压在最底层：层本身不接鼠标（空白处不挡），只有叠卡/展开格接 */
.media-stacks {
  position: absolute;
  left: 16px;
  /* bottom 由脚本按输入台顶缘动态给出（默认 14px） */
  z-index: 1;
  display: flex;
  align-items: flex-end;
  gap: 10px;
  pointer-events: none;
}

.stack {
  position: relative;
  pointer-events: auto;
}

/* ---- 收起的叠卡 ---- */
.pile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 86px;
  padding: 6px 6px 5px;
  border: 1px solid var(--accent-a22);
  border-radius: 10px;
  background: rgba(6, 10, 16, 0.72);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
  cursor: pointer;
  color: var(--text-3);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.pile:hover {
  border-color: var(--accent-a45);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.55);
}

.cover {
  position: relative;
  width: 100%;
  height: 54px;
  border-radius: 7px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cover-empty {
  font-size: 22px;
  opacity: 0.4;
}

.count {
  position: absolute;
  top: 3px;
  right: 3px;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--bg, #05080d);
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
}

.pile-label {
  font-size: 10.5px;
  letter-spacing: 1px;
  color: var(--text-3);
}

/* ---- 展开的缩略格 ---- */
.stack-panel {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  width: 284px;
  max-height: min(46vh, 420px);
  overflow-y: auto;
  padding: 8px 10px 10px;
  border: 1px solid var(--accent-a22);
  border-radius: 10px;
  background: rgba(4, 8, 14, 0.86);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.55);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 7px;
}

.panel-title {
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--text-2);
}

.clear {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text-3);
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 5px;
  cursor: pointer;
}

.clear:hover {
  border-color: var(--fail);
  color: var(--fail);
}

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
  padding: 10px 0 4px;
}
</style>
