<script setup lang="ts">
// 壁纸模式的置顶输入浮层（主进程 ?quick=1 小窗，Ctrl+Alt+F 呼出）：
// 桌面背景层拿不到键盘焦点，打字都在这里——真窗口、永远可点可输入（输入法正常走）。
// Enter 提交（Shift+Enter 换行）后转给主窗口走常规提交路径（会话 / 和助手说）；Esc 或失焦收起。
// 右侧带「退出桌面模式」保底按钮：壁纸层的点击 / 快捷键都指望不上时，这里一定能点到。
import { onMounted, ref } from 'vue'

const text = ref('')
const inputEl = ref<HTMLTextAreaElement | null>(null)
const bridge = window.fridayBridge

function submit(): void {
  const value = text.value.trim()
  if (value) bridge.wallpaperQuickSubmit(value)
  else bridge.wallpaperQuickClose()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    bridge.wallpaperQuickClose()
  }
}

onMounted(() => inputEl.value?.focus())
</script>

<template>
  <div class="quick-input">
    <div class="hint">发到当前会话 / 和助手说 · Enter 发送 · Shift+Enter 换行 · Esc 收起 · Ctrl+Alt+F 再唤出</div>
    <div class="input-row">
      <textarea ref="inputEl" v-model="text" rows="2" placeholder="跟 Friday 说…" @keydown="onKeydown" />
      <button class="send" title="发送" @click="submit">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.5 8 13.5 2.8 10.9 13.4 8.2 10.3 5.9 12.4V9z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
        </svg>
      </button>
      <button class="exit" title="退出桌面背景模式，回到普通窗口" @click="bridge.wallpaperExit()">退出桌面</button>
    </div>
  </div>
</template>

<style scoped>
/* 跟主界面同款深空底（主进程建窗时 backgroundColor 已同色），窗口本身无边框 */
.quick-input {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 8px 10px 10px;
  box-sizing: border-box;
  background: #0a1420ee;
  border: 1px solid #2a5a78;
  border-radius: 10px;
  overflow: hidden;
}
.hint {
  font-size: 11px;
  color: #6f97ad;
  padding: 0 2px 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.input-row {
  flex: 1;
  display: flex;
  gap: 8px;
  min-height: 0;
}
textarea {
  flex: 1;
  resize: none;
  background: #081018;
  color: #d8ecf7;
  border: 1px solid #24485f;
  border-radius: 8px;
  padding: 8px 10px;
  font: 13px/1.5 'MiSans', 'Segoe UI', sans-serif;
  outline: none;
}
textarea:focus {
  border-color: #35c8e8;
  box-shadow: 0 0 0 1px #35c8e855;
}
button {
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font: 12px 'MiSans', 'Segoe UI', sans-serif;
  color: #9fc6d8;
  background: #12293a;
  transition: background 0.15s, color 0.15s;
}
button:hover {
  background: #1a3a52;
  color: #d8ecf7;
}
.send {
  width: 44px;
  display: grid;
  place-items: center;
}
.send svg {
  width: 16px;
  height: 16px;
}
.exit {
  padding: 0 12px;
}
</style>
