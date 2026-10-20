<script setup lang="ts">
// 桌面气泡（2026-10 布局改版）：会话的思考 / 文本输出直接投在桌面随机位置，
// 随流式增长，5 秒无新内容渐隐消失。数据与定时全在 store（pushBubble / fadeBubble）。
import { useAppStore } from '../stores/app.js'

const store = useAppStore()

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
        class="bubble"
        :class="[bubble.kind, { fading: bubble.fading }]"
        :style="{ left: `${bubble.x}px`, top: `${bubble.y}px` }"
        @click="store.fadeBubble(bubble.id)"
      >
        <span class="tag">{{ bubble.kind === 'thinking' ? '思考' : '回复' }} · {{ titleOf(bubble.conversationID) }}</span>
        <span class="text">{{ bubble.text }}</span>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.bubble-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 40;
}

.bubble {
  position: absolute;
  pointer-events: auto;
  max-width: 360px;
  max-height: 300px;
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
  font-family: var(--font-hud);
  font-size: 9.5px;
  letter-spacing: 2px;
  color: var(--accent);
  opacity: 0.75;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bubble.thinking .tag {
  color: var(--warn);
}

.text {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 10;
  -webkit-box-orient: vertical;
  overflow: hidden;
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
