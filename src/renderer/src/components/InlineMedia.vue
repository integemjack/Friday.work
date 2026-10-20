<script setup lang="ts">
// 内嵌媒体（看图 / 看视频共用的展示块）：图片直接显示；视频静音循环自动播放（带控件，可点开声音）。
// 只传工具名 + 参数 JSON：useToolMedia 负责 http(s)/data URL 直连、本地文件 fs.read 拉 Blob、
// 滚进视口才拉的懒加载与重试。不是看图/看视频（或参数还没流完整）就整体不渲染。
// 聊天面板的工具卡（ToolCard）与桌面投层的操作卡（DesktopOps）都用这一份。
import { computed } from 'vue'
import type { ToolEvent } from '../../../protocol/rpc/protocol.js'
import { useToolMedia } from '../lib/toolMedia.js'

const props = defineProps<{
  /** 工具名（analyze_image / analyze_video） */
  name: string
  /** 参数 JSON 文本（媒体路径在 image / video 字段里） */
  args: string
  /** 相对路径按哪段会话的工作目录解析（桌面操作卡可能不属于活动会话）；不给按活动会话 */
  conversationID?: string
  /** 桌面操作卡里的紧凑尺寸：图/视频限高更小，别把 400px 高的卡撑满 */
  compact?: boolean
}>()

const tool = computed<ToolEvent>(() => ({
  id: '',
  name: props.name,
  arguments: props.args,
  status: 'succeeded',
  result: ''
}))

const { source, url, state, note, setMediaEl } = useToolMedia(tool, {
  conversationID: () => props.conversationID ?? ''
})
</script>

<template>
  <!-- 点击不冒泡：点视频控件 / 点图片不会触发外层卡片的折叠或渐隐 -->
  <div v-if="source" :ref="setMediaEl" class="inline-media" @click.stop>
    <img
      v-if="source.kind === 'image' && url"
      class="media-image"
      :class="{ compact }"
      :src="url"
      :alt="source.src"
      draggable="false"
    />
    <video
      v-else-if="source.kind === 'video' && url"
      class="media-video"
      :class="{ compact }"
      :src="url"
      autoplay
      muted
      loop
      playsinline
      controls
    />
    <div v-if="state === 'loading'" class="media-note">媒体加载中…</div>
    <div v-else-if="state === 'error' || state === 'skipped'" class="media-note">{{ note }}</div>
  </div>
</template>

<style scoped>
.inline-media {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.media-image {
  max-width: 100%;
  max-height: 320px;
  width: auto;
  border-radius: 8px;
  border: 1px solid var(--border);
  align-self: flex-start;
}

.media-video {
  width: 100%;
  max-height: 420px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: #000;
  display: block;
}

/* 桌面操作卡（400px 宽、限高 400）里的紧凑尺寸 */
.media-image.compact {
  max-height: 200px;
}

.media-video.compact {
  max-height: 220px;
}

.media-note {
  font-size: 12px;
  color: var(--text-3);
}
</style>
