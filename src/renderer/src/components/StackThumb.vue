<script setup lang="ts">
// 媒体叠里单条媒体的缩略块：图片拉真图缩着显示（useToolMedia 自带懒加载，
// 只在滚进视口才拉，收起的叠只有封面那一张在拉）；视频不整段拉下来做缩略图
// （一条视频几十 MB 不值得）——给胶片图标卡，点开进灯箱才真正加载播放。
// 拉不到/太大的给 ⚠ 角标（悬停看原因）。
import { computed } from 'vue'
import type { ToolEvent } from '../../../protocol/rpc/protocol.js'
import { useToolMedia } from '../lib/toolMedia.js'
import type { StackMediaItem } from '../stores/app.js'

const props = defineProps<{
  item: StackMediaItem
  /** 缩略块尺寸档：pile=叠封面（56px 高）、grid=展开格（72px） */
  size?: 'pile' | 'grid'
}>()

// 把叠里的条目包成一次已成功的看图/看视频调用，直接复用 useToolMedia 的解析与拉取
const tool = computed<ToolEvent>(() => ({
  id: '',
  name: props.item.kind === 'image' ? 'analyze_image' : 'analyze_video',
  arguments: JSON.stringify({ [props.item.kind]: props.item.src }),
  status: 'succeeded',
  result: ''
}))

const { url, state, note, setMediaEl } = useToolMedia(tool, {
  conversationID: () => props.item.conversationID
})
</script>

<template>
  <div class="stack-thumb" :class="size ?? 'grid'" :ref="setMediaEl" :title="item.src">
    <img v-if="item.kind === 'image' && url" class="thumb-img" :src="url" :alt="item.src" draggable="false" />
    <span v-else-if="item.kind === 'video'" class="thumb-fallback">🎞</span>
    <span v-else-if="state === 'loading'" class="thumb-fallback dim">…</span>
    <span
      v-else-if="state === 'error' || state === 'skipped'"
      class="thumb-fallback broken"
      :title="note || '媒体加载失败'"
      >⚠</span
    >
  </div>
</template>

<style scoped>
.stack-thumb {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.04);
}

.thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  user-select: none;
}

.thumb-fallback {
  font-size: 22px;
  line-height: 1;
  opacity: 0.85;
}

.thumb-fallback.dim {
  opacity: 0.4;
}

.thumb-fallback.broken {
  opacity: 0.75;
  font-size: 16px;
}
</style>
