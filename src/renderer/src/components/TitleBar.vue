<script setup lang="ts">
// 标题栏：应用名 │ 当前机器（点开机器列表）│ 连接状态点
import { computed, ref } from 'vue'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()

const stateDot = computed(() => {
  switch (store.currentMachineInfo?.state) {
    case 'ready': return 'ok'
    case 'connecting': return 'run'
    case 'failed': case 'versionMismatch': return 'fail'
    default: return 'off'
  }
})

const stateText = computed(() => {
  switch (store.currentMachineInfo?.state) {
    case 'ready': return '已连接'
    case 'connecting': return '连接中'
    case 'failed': return '连接失败'
    case 'versionMismatch': return '版本不匹配'
    default: return '未连接'
  }
})

const machineMenuOpen = ref(false)

function toggleMachineMenu() {
  machineMenuOpen.value = !machineMenuOpen.value
}

async function pickMachine(id: string) {
  machineMenuOpen.value = false
  await store.selectMachine(id)
}

const hasNoMachine = computed(() => store.machines.length === 0)

// 无边框窗口的窗控（preload 暴露的 IPC；模板里拿不到 window 全局，setup 里取一次）
const bridge = window.fridayBridge
</script>

<template>
  <header class="titlebar">
    <div class="brand">Friday</div>
    <div class="machine" @click="toggleMachineMenu">
      <span class="dot" :class="stateDot" />
      <span class="machine-name">{{ store.currentMachineInfo?.name ?? (hasNoMachine ? '还没有机器' : '选一台机器') }}</span>
      <span class="machine-state">{{ stateText }}</span>
      <span class="chevron">▾</span>
    </div>
    <div class="spacer" />
    <!-- 无边框窗口的窗控钮（frame:false；整个标题栏是拖拽区） -->
    <div class="win-controls">
      <button class="win-btn" title="最小化" @click="bridge.winMinimize()">─</button>
      <button class="win-btn" title="最大化 / 还原" @click="bridge.winMaximizeToggle()">▢</button>
      <button class="win-btn close" title="关闭" @click="bridge.winClose()">×</button>
    </div>

    <teleport to="body">
      <div v-if="machineMenuOpen" class="menu-mask" @click="machineMenuOpen = false">
        <div class="menu" @click.stop>
          <div class="menu-title">机器</div>
          <button
            v-for="machine in store.machines"
            :key="machine.id"
            class="menu-item"
            :class="{ active: machine.id === store.currentMachine }"
            @click="pickMachine(machine.id)"
          >
            <span class="dot" :class="machine.state === 'ready' ? 'ok' : machine.state === 'disconnected' ? 'off' : 'run'" />
            <span class="menu-item-name">{{ machine.name }}</span>
            <span class="menu-item-detail">{{ machine.detail ?? machine.targetText }}</span>
          </button>
          <div v-if="hasNoMachine" class="menu-empty">还没有机器：在左边「添加机器」里连第一台</div>
        </div>
      </div>
    </teleport>
  </header>
</template>

<style scoped>
.titlebar {
  height: 44px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 14px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
  user-select: none;
}

.titlebar button,
.titlebar .machine {
  -webkit-app-region: no-drag;
}

.win-controls {
  display: flex;
  gap: 2px;
  margin-left: 6px;
}

.win-btn {
  width: 36px;
  height: 30px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
}

.win-btn:hover {
  background: var(--hover);
  color: var(--text);
}

.win-btn.close:hover {
  background: rgba(251, 95, 125, 0.85);
  color: #fff;
}

.brand {
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0.5px;
}

.machine {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 10px;
  border-radius: 8px;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.machine:hover {
  background: var(--panel-2);
}

.machine-name {
  font-weight: 500;
}

.machine-state {
  color: var(--text-2);
  font-size: 12.5px;
}

.chevron {
  color: var(--text-3);
  font-size: 11px;
}

.spacer {
  flex: 1;
}

.menu-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
}

.menu {
  position: absolute;
  top: 48px;
  left: 120px;
  min-width: 320px;
  max-width: 460px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.14);
  padding: 6px;
}

.menu-title {
  font-size: 12px;
  color: var(--text-2);
  padding: 6px 10px 4px;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border-radius: 8px;
}

.menu-item:hover {
  background: var(--panel-2);
}

.menu-item.active {
  background: var(--accent-weak);
}

.menu-item-name {
  font-weight: 500;
  flex: none;
}

.menu-item-detail {
  color: var(--text-3);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-empty {
  padding: 10px;
  color: var(--text-2);
  font-size: 13px;
}

/* 贾维斯界面：顶部标题栏变成 HUD 主控条——品牌发光、底部青色渐变线、状态等宽化 */
[data-theme='jarvis'] .titlebar {
  border-bottom-color: rgba(34, 211, 238, 0.28);
  background:
    linear-gradient(90deg, rgba(34, 211, 238, 0.09), transparent 28%, transparent 72%, rgba(34, 211, 238, 0.09)),
    var(--panel);
}

[data-theme='jarvis'] .brand {
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 5px;
  text-shadow: 0 0 12px rgba(34, 211, 238, 0.5);
}

[data-theme='jarvis'] .machine {
  border: 1px solid transparent;
  border-radius: 8px;
  transition: border-color 0.15s, background 0.15s;
}

[data-theme='jarvis'] .machine:hover {
  border-color: rgba(34, 211, 238, 0.3);
}

[data-theme='jarvis'] .machine-state,
[data-theme='jarvis'] .menu-item-detail {
  font-family: var(--font-hud);
  letter-spacing: 1px;
}
</style>
