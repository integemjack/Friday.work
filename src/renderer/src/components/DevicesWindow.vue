<script setup lang="ts">
// 设备窗口（方案-客户端设备）：这台电脑上有什么能交给远端用、现在谁在用、哪些「始终允许」了。
//   服务端：所连机器接不接得住（Friday 2.78 起）、装没装「客户端设备」能力（设置 › 能力里装，装了智能体才有工具）；
//   本机设备：串口（ESP / Arduino / STM32 板子）、摄像头、安卓手机（adb）、iOS 设备（usbmuxd）、UF2 盘；
//   使用中：同桌面上的提示条，可断开；始终允许：可撤销（同设置 › 本机设备授权）。
// 这里只列、不动设备：真正打开设备都是远端发请求、这边问过人之后。

import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'
import { deviceBroker, deviceUi } from '../lib/devices/broker.js'
import { CAPABILITY_LABEL, deviceGrants, revokeGrant } from '../lib/devices/grants.js'

const store = useAppStore()

interface LocalDevice {
  id: string
  kind: string
  label: string
  state?: string
}

const devices = ref<LocalDevice[]>([])
const loading = ref(false)
const error = ref('')

const KIND_TITLE: Record<string, string> = {
  serial: '串口（开发板）',
  camera: '摄像头',
  android: '安卓手机',
  ios: 'iOS 设备',
  uf2: 'UF2 烧录盘'
}
const KIND_HINT: Record<string, string> = {
  serial: '远端可开成 rfc2217 端口（esptool / PlatformIO 直接用），也能在这台本机烧 ESP / Arduino / STM32',
  camera: '远端可以拍一张照片看',
  android: '远端的 adb 能用这台手机（要打开 USB 调试，这台电脑装 platform-tools）',
  ios: '远端的 libimobiledevice 能用（Windows 要装 Apple 设备 / iTunes）',
  uf2: '树莓派 Pico 等按住 BOOTSEL 插上出现的盘，远端可以直接烧 .uf2'
}
const ACTIVITY_LABEL: Record<string, string> = { serial: '串口', flash: '烧录', info: '读芯片', camera: '摄像头', tunnel: '连接', tool: '工具' }

const groups = computed(() => {
  const order = ['serial', 'uf2', 'camera', 'android', 'ios']
  return order
    .map((kind) => ({ kind, items: devices.value.filter((device) => device.kind === kind) }))
    .filter((group) => group.items.length > 0)
})

const server = computed(() => {
  const info = store.currentMachineInfo
  if (!info || info.state !== 'ready') return { tone: 'muted', text: '还没连上机器：连上以后远端才能用这里的设备' }
  const serverInfo = info.serverInfo as (typeof info.serverInfo & { clientDevices?: { power?: boolean } }) | undefined
  if (!serverInfo?.features?.includes('clientDevices')) {
    return { tone: 'warn', text: `${info.name} 的 Friday 太旧（${serverInfo?.version ?? '?'}），要 2.78 以上才能用这台电脑的设备` }
  }
  if (!serverInfo.clientDevices?.power) {
    return { tone: 'warn', text: `${info.name} 还没装「客户端设备」能力：在它的设置 › 能力里装上，智能体才有串口 / 烧录 / adb / 隧道这些工具` }
  }
  return { tone: 'ok', text: `${info.name} 已装「客户端设备」能力：它的智能体能用下面这些设备（每样第一次用都会先问你）` }
})

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    devices.value = await deviceBroker.localDevices()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

// 本机设备清单变了（手机插拔、串口、摄像头）会自动刷新，不用手点
let offLocalDevices: (() => void) | null = null
onMounted(() => {
  void refresh()
  offLocalDevices = deviceBroker.onLocalDevicesChanged(() => void refresh())
})
onUnmounted(() => offLocalDevices?.())
</script>

<template>
  <div class="devices">
    <section>
      <div class="server" :class="server.tone">{{ server.text }}</div>
    </section>

    <section>
      <div class="head">
        <h3>这台电脑的设备</h3>
        <button class="small-btn" :disabled="loading" @click="refresh">{{ loading ? '在看…' : '刷新' }}</button>
      </div>
      <div v-if="error" class="error">{{ error }}</div>
      <div v-if="!loading && groups.length === 0" class="empty-line">没找到设备（插上手机会自动出现；开发板可点刷新）</div>
      <div v-for="group in groups" :key="group.kind" class="group">
        <div class="group-title">{{ KIND_TITLE[group.kind] ?? group.kind }}</div>
        <div class="group-hint">{{ KIND_HINT[group.kind] }}</div>
        <div v-for="device in group.items" :key="device.id" class="row">
          <span class="key">{{ device.label }}</span>
          <span class="value mono">{{ device.id }}</span>
        </div>
      </div>
    </section>

    <section>
      <h3>使用中</h3>
      <div v-if="deviceUi.activity.length === 0" class="empty-line">没有设备在被远端用</div>
      <div v-for="item in deviceUi.activity" :key="item.key" class="row">
        <span class="key">{{ item.machineName }} · {{ ACTIVITY_LABEL[item.kind] ?? item.kind }} · {{ item.deviceLabel }}</span>
        <span class="value">
          {{ item.detail }}<template v-if="item.progress !== undefined"> {{ Math.round(item.progress * 100) }}%</template>
          <button
            v-if="item.kind === 'serial' || item.kind === 'tunnel' || (item.kind === 'tool' && item.detail === '后台运行')"
            class="small-btn"
            @click="deviceBroker.stopActivity(item.key)"
          >
            {{ item.kind === 'tool' ? '停止' : '断开' }}
          </button>
        </span>
      </div>
    </section>

    <section>
      <h3>始终允许</h3>
      <div v-if="!deviceGrants.list.length" class="empty-line">没有（远端第一次用某样设备时会问你，选「始终允许」的记在这里）</div>
      <div v-for="grant in deviceGrants.list" :key="`${grant.machineID}|${grant.capability}|${grant.deviceId}`" class="row">
        <span class="key">{{ grant.machineName }} · {{ CAPABILITY_LABEL[grant.capability] }}</span>
        <span class="value">
          {{ grant.deviceLabel }}
          <button class="small-btn" @click="revokeGrant(grant)">撤销</button>
        </span>
      </div>
      <div class="note">在这台电脑上跑工具（avrdude、openocd……）每次都要你点头，不能「始终允许」。</div>
    </section>
  </div>
</template>

<style scoped>
.devices {
  height: 100%;
  overflow: auto;
  padding: 12px 16px 16px;
  font-size: 12.5px;
  color: var(--text-2);
}

section {
  margin-bottom: 16px;
}

h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.head h3 {
  margin: 0;
}

.server {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  line-height: 1.5;
}

.server.ok {
  color: var(--text);
}

.server.warn {
  color: var(--text);
  border-color: var(--fail);
}

.server.muted {
  color: var(--text-3);
}

.group {
  margin-bottom: 10px;
}

.group-title {
  color: var(--text);
  font-weight: 600;
}

.group-hint {
  color: var(--text-3);
  margin: 2px 0 4px;
  line-height: 1.4;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
}

.key {
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.value {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-3);
  flex: none;
}

.mono {
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 11.5px;
}

.empty-line,
.note {
  color: var(--text-3);
  line-height: 1.5;
}

.note {
  margin-top: 6px;
}

.error {
  color: var(--fail);
  margin-bottom: 6px;
}

.small-btn {
  padding: 2px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}

.small-btn:hover:not(:disabled) {
  color: var(--text);
  background: var(--chip);
}

.small-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
