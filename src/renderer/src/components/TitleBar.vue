<script setup lang="ts">
// 标题栏：应用名 │ 当前机器（点开机器列表）│ 连接状态点
import { computed, ref } from 'vue'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()

const stateDot = computed(() => {
  switch (store.currentMachineInfo?.state) {
    case 'ready': return 'ok'
    case 'connecting': case 'probing': return 'run'
    case 'failed': case 'versionMismatch': return 'fail'
    case 'unpaired': return 'warn'
    default: return 'off'
  }
})

const stateText = computed(() => {
  switch (store.currentMachineInfo?.state) {
    case 'ready': return '已连接'
    case 'connecting': return '连接中'
    case 'probing': return '探测远端'
    case 'failed': return '连接失败'
    case 'unpaired': return '未配对'
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
</style>
