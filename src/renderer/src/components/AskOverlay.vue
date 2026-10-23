<script setup lang="ts">
// ask_user 的置顶提问浮层：有待答的问题时，弹在屏幕正中间、压过桌面/窗口/投层的一切（z 8500，
// 让位给登录页/更新/全局错误），并且整个窗口切到系统级置顶（preload setAskPinned → 主进程
// setAlwaysOnTop）——用户在别的应用里干活也压在最前面，不会被挡住。
// 点「稍后再说」的这个不再弹（dismissedAsks），新问题来了照常弹；聊天横幅和桌面操作卡里的面板照旧。
import { onBeforeUnmount, watch } from 'vue'
import { useAppStore } from '../stores/app.js'
import AskPanel from './AskPanel.vue'

const store = useAppStore()

// 有待答的问题 → 窗口置顶；没了（答完/跳过/稍后/在别处答掉）→ 恢复
watch(
  () => store.pendingAsks.length,
  (count) => window.fridayBridge?.setAskPinned(count > 0),
  { immediate: true }
)
onBeforeUnmount(() => window.fridayBridge?.setAskPinned(false))
</script>

<template>
  <div v-if="store.pendingAsks.length > 0" class="ask-overlay" data-testid="ask-overlay">
    <div class="ask-card">
      <header class="ask-card-head">
        <span class="ask-card-badge">?</span>
        <span class="ask-card-title">Friday 想问你</span>
        <span v-if="store.pendingAsks.length > 1" class="ask-card-count">{{ store.pendingAsks.length }} 个问题</span>
      </header>
      <div class="ask-card-list cast-scroll">
        <section v-for="ask in store.pendingAsks" :key="ask.approval.eventID" class="ask-card-item">
          <div class="ask-card-src">{{ ask.conversationTitle }}</div>
          <AskPanel
            :questions="ask.approval.questions ?? []"
            @answer="(payload) => store.answerQuestion(ask.approval.eventID, payload)"
            @skip="store.skipQuestion(ask.approval.eventID)"
          />
          <button type="button" class="ask-later" @click="store.dismissAsk(ask.approval.eventID)">稍后再说</button>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩不挡操作（pointer-events none）：桌面照常用，只有卡本身接住点击 */
.ask-overlay {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  /* 压过桌面/应用内窗口/投层气泡，让位给登录页（9000）/媒体灯箱（9500）/更新（90000）/全局错误（100000） */
  z-index: 8500;
  pointer-events: none;
  /* 轻微暗化四角，把视线引到中间的问题上 */
  background: radial-gradient(ellipse at center, transparent 30%, rgba(0, 0, 0, 0.28) 100%);
}

.ask-card {
  pointer-events: auto;
  width: min(440px, calc(100vw - 48px));
  max-height: min(78vh, 720px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--accent, #4c8dff);
  border-radius: 14px;
  /* 近乎不透明 + 磨砂：--panel 是半透明的（贾维斯下 45%），没有模糊时问题文字直接压在转动的 HUD 上，读不清 */
  background: color-mix(in srgb, var(--bg) 84%, transparent);
  -webkit-backdrop-filter: blur(20px) saturate(1.3);
  backdrop-filter: blur(20px) saturate(1.3);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.4);
  animation: ask-pop 0.22s ease;
  overflow: hidden;
}

@keyframes ask-pop {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.ask-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 8px;
}

.ask-card-badge {
  flex: none;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--accent);
  border-radius: 50%;
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
}

.ask-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text, var(--fg));
  letter-spacing: 1px;
}

.ask-card-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 0 7px;
}

.ask-card-list {
  min-height: 0;
  overflow-y: auto;
  padding: 0 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ask-card-item {
  /* 深色面板上的一套 AskPanel 变量 */
  --ask-line: var(--line);
  --ask-accent: var(--accent);
  --ask-picked: var(--accent-a15, rgba(80, 170, 255, 0.15));
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
}

.ask-card-item + .ask-card-item {
  border-top: 1px dashed var(--line);
  padding-top: 12px;
}

.ask-card-src {
  font-size: 11px;
  color: var(--text-2, var(--fg-2, inherit));
  opacity: 0.8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ask-later {
  align-self: flex-end;
  border: none;
  background: transparent;
  color: var(--text-2, var(--fg-2, inherit));
  font-size: 11px;
  padding: 2px 4px;
  cursor: pointer;
  text-decoration: underline dotted;
  opacity: 0.75;
}

.ask-later:hover {
  opacity: 1;
  color: var(--text, var(--fg));
}

/* 贾维斯：深色全息卡 + 青色辉光，标题走 HUD 字体（与浮动窗口同一套语言） */
[data-theme='jarvis'] .ask-card {
  background: var(--panel-card-deep-a92);
  border-color: var(--accent-a55);
  box-shadow:
    0 0 28px var(--accent-a15),
    inset 0 0 18px var(--accent-a5),
    0 18px 48px rgba(0, 0, 0, 0.55);
}

[data-theme='jarvis'] .ask-card-title {
  font-family: var(--font-hud);
  letter-spacing: 3px;
  color: var(--accent);
  text-shadow: 0 0 10px var(--accent-a40);
}

[data-theme='jarvis'] .ask-card-badge {
  box-shadow: 0 0 10px var(--accent-a45);
}
</style>
