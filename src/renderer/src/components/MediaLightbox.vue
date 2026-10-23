<script setup lang="ts">
// 媒体灯箱：桌面媒体叠里点单张图片放大看、点视频大窗播放。
// 图片再点一下就关；视频里点的是控件不能关，关靠背景/×/Esc。
// 加载复用 useToolMedia（http(s)/data 直连、本地文件 fs.read 拉 Blob），进来就拉（整屏可见）。
import { computed, onBeforeUnmount, onMounted } from 'vue'
import type { ToolEvent } from '../../../protocol/rpc/protocol.js'
import { useToolMedia } from '../lib/toolMedia.js'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()

// 把灯箱里的媒体包成一次已成功的看图/看视频调用
const tool = computed<ToolEvent>(() => ({
  id: '',
  name: store.zoomMedia?.kind === 'video' ? 'analyze_video' : 'analyze_image',
  arguments: store.zoomMedia ? JSON.stringify({ [store.zoomMedia.kind]: store.zoomMedia.src }) : '',
  status: 'succeeded',
  result: ''
}))

const { url, state, note, setMediaEl } = useToolMedia(tool, {
  conversationID: () => store.zoomMedia?.conversationID ?? ''
})

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && store.zoomMedia) {
    event.preventDefault() // 这次 Esc 已用来关灯箱，别再取消选中会话（App.vue）
    store.closeMediaZoom()
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Transition name="veil">
    <div v-if="store.zoomMedia" class="lightbox" @click="store.closeMediaZoom()">
      <div class="frame" :ref="setMediaEl" @click.stop>
        <img
          v-if="store.zoomMedia.kind === 'image' && url"
          class="zoom-img"
          :src="url"
          :alt="store.zoomMedia.src"
          title="点一下关掉"
          @click="store.closeMediaZoom()"
        />
        <video
          v-else-if="store.zoomMedia.kind === 'video' && url"
          class="zoom-video"
          :src="url"
          controls
          autoplay
          playsinline
        />
        <div v-if="state === 'loading'" class="note">媒体加载中…</div>
        <div v-else-if="state === 'error' || state === 'skipped'" class="note">{{ note }}</div>
        <div class="caption" :title="store.zoomMedia.src">{{ store.zoomMedia.src }}</div>
        <button class="close" title="关掉（Esc）" @click="store.closeMediaZoom()">×</button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* 盖过一切面板/窗口（登录页 9000 之上、错误横幅 100000 之下） */
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 9500;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(2, 4, 8, 0.82);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  cursor: zoom-out;
}

.frame {
  position: relative;
  max-width: 92vw;
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  cursor: default;
}

.zoom-img {
  max-width: 92vw;
  max-height: 84vh;
  border-radius: 10px;
  border: 1px solid var(--accent-a22);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.65);
  display: block;
  cursor: zoom-out;
}

.zoom-video {
  max-width: 92vw;
  max-height: 84vh;
  border-radius: 10px;
  border: 1px solid var(--accent-a22);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.65);
  background: #000;
  display: block;
}

.note {
  font-size: 13px;
  color: var(--text-2);
  padding: 12px 18px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
}

.caption {
  max-width: 80vw;
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.close {
  position: absolute;
  top: -14px;
  right: -14px;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--accent-a45);
  background: rgba(4, 8, 14, 0.92);
  color: var(--fg);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.close:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.veil-enter-active,
.veil-leave-active {
  transition: opacity 0.16s ease;
}

.veil-enter-from,
.veil-leave-to {
  opacity: 0;
}
</style>
