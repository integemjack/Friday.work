<script setup lang="ts">
// 桌面（用户 2026-10-19 定稿的范式）：应用本身是一个桌面，
// 会话 / 终端 / 文件 / 浏览器 / 子 Agent / 活动总览 / 机器与会话 都以窗口显示：
// 可拖动、可缩放、可最小化/最大化、可层叠，底部任务栏切换。
import { onMounted } from 'vue'
import type { WindowKind } from './stores/app.js'
import { useAppStore } from './stores/app.js'
import TitleBar from './components/TitleBar.vue'
import ConversationView from './components/ConversationView.vue'
import TerminalCard from './components/TerminalCard.vue'
import FilesCard from './components/FilesCard.vue'
import BrowserCard from './components/BrowserCard.vue'
import AgentsCard from './components/AgentsCard.vue'
import ActivityOverview from './components/ActivityOverview.vue'
import VoiceWindow from './components/VoiceWindow.vue'
import SettingsWindow from './components/SettingsWindow.vue'
import SchatWindow from './components/SchatWindow.vue'
import CallWindow from './components/CallWindow.vue'
import TimelineWindow from './components/TimelineWindow.vue'
import MachinesWindow from './desktop/MachinesWindow.vue'
import TaskBar from './desktop/TaskBar.vue'
import WindowFrame from './desktop/WindowFrame.vue'

const store = useAppStore()

onMounted(() => {
  store.bindHost()
  // 没有窗口时先开「机器与会话」，桌面不至于空着
  if (!store.windows.length) store.openWindow('machines')
})

const componentFor: Record<WindowKind, unknown> = {
  conversation: ConversationView,
  terminals: TerminalCard,
  files: FilesCard,
  browser: BrowserCard,
  agents: AgentsCard,
  activity: ActivityOverview,
  machines: MachinesWindow,
  voice: VoiceWindow,
  settings: SettingsWindow,
  schat: SchatWindow,
  call: CallWindow,
  timeline: TimelineWindow
}

const sizeLimits: Record<WindowKind, { minWidth: number; minHeight: number }> = {
  conversation: { minWidth: 420, minHeight: 340 },
  terminals: { minWidth: 420, minHeight: 260 },
  files: { minWidth: 360, minHeight: 300 },
  browser: { minWidth: 420, minHeight: 320 },
  agents: { minWidth: 360, minHeight: 240 },
  activity: { minWidth: 320, minHeight: 240 },
  machines: { minWidth: 320, minHeight: 280 },
  voice: { minWidth: 360, minHeight: 320 },
  settings: { minWidth: 420, minHeight: 320 },
  schat: { minWidth: 420, minHeight: 360 },
  call: { minWidth: 300, minHeight: 380 },
  timeline: { minWidth: 380, minHeight: 300 }
}
</script>

<template>
  <div class="app">
    <TitleBar />

    <div class="desktop" @mousedown.self="store.activeConversationID = store.activeConversationID">
      <!-- 桌面上没有窗口时的提示 -->
      <div v-if="!store.windows.length" class="desktop-empty">
        <div class="desktop-title">Friday</div>
        <div class="desktop-sub">连上那台跑着 Friday 的机器，会话和工具都在窗口里</div>
        <div class="desktop-actions">
          <button class="btn primary" @click="store.openWindow('machines')">打开机器与会话</button>
        </div>
      </div>

      <WindowFrame
        v-for="item in store.allWindows"
        :id="item.id"
        :key="item.id"
        :title="item.title"
        :icon="item.icon"
        :rect="{ x: item.x, y: item.y, w: item.w, h: item.h }"
        :z="item.z"
        :minimized="item.minimized"
        :maximized="item.maximized"
        :min-width="sizeLimits[item.kind].minWidth"
        :min-height="sizeLimits[item.kind].minHeight"
        @focus="store.focusWindow(item.id)"
        @close="store.closeWindow(item.id)"
        @minimize="store.minimizeWindow(item.id)"
        @toggle-maximize="store.toggleMaximizeWindow(item.id)"
        @move="(rect) => store.moveWindow(item.id, rect)"
        @resize="(rect) => store.resizeWindow(item.id, rect)"
      >
        <component
          :is="componentFor[item.kind]"
          :conversation-id="item.conversationID"
        />
      </WindowFrame>
    </div>

    <TaskBar />

    <!-- 全局错误横幅 -->
    <div v-if="store.error" class="error-toast" @click="store.error = ''">
      {{ store.error }}
      <span class="close-hint">（点一下关掉）</span>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg);
}

.desktop {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  /* 桌面底：纯色 + 极淡的点阵，不抢窗口的注意力 */
  background-color: var(--bg);
  background-image: radial-gradient(var(--border) 1px, transparent 1px);
  background-size: 22px 22px;
  background-position: -1px -1px;
}

.desktop-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-2);
  pointer-events: none;
}

.desktop-empty > * {
  pointer-events: auto;
}

.desktop-title {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--text-3);
}

.desktop-sub {
  font-size: 13px;
  color: var(--text-3);
}

.desktop-actions {
  margin-top: 12px;
}

.error-toast {
  position: fixed;
  left: 50%;
  bottom: 56px;
  transform: translateX(-50%);
  max-width: 70vw;
  padding: 8px 14px;
  border-radius: 8px;
  background: var(--fail);
  color: #fff;
  font-size: 12.5px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.24);
  cursor: pointer;
  z-index: 100000;
}

.close-hint {
  opacity: 0.75;
  font-size: 11.5px;
}
</style>
