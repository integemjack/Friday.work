<script setup lang="ts">
// 配对设备（M4，方案 §10「二维码配对」；REMOTE.md §6 server.pair）：
// 在这台机器上生成一次性配对链接（含令牌，只给这一次），展示二维码和链接，手机/另一台电脑扫码或粘贴即可连上。
// 注意：server.pair 需要 SSH/WSL 连接（WebSocket 配对设备不能自己再配对），协议里写明了。
import QRCode from 'qrcode'
import { ref } from 'vue'
import { useAppStore } from '../stores/app.js'

const emit = defineEmits<{ close: [] }>()
const store = useAppStore()

const deviceName = ref(defaultName())
const link = ref('')
const svg = ref('')
const deviceID = ref('')
const fingerprint = ref('')
const error = ref('')
const busy = ref(false)

function defaultName(): string {
  const platform = navigator.userAgent.includes('Mac') ? 'Mac' : 'Windows'
  return `${platform} 上的 Friday 客户端`
}

async function generate(): Promise<void> {
  if (!store.currentMachine || busy.value) return
  busy.value = true
  error.value = ''
  link.value = ''
  svg.value = ''
  try {
    const result = (await store.rpc(store.currentMachine, 'server.pair', {
      name: deviceName.value.trim() || 'Friday 客户端'
    })) as { deviceID: string; link: string; fingerprint?: string }
    link.value = result.link
    fingerprint.value = result.fingerprint ?? ''
    deviceID.value = result.deviceID
    svg.value = await QRCode.toString(result.link, { type: 'svg', margin: 1, width: 220 })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function copyLink(): Promise<void> {
  if (!link.value) return
  try {
    await navigator.clipboard.writeText(link.value)
  } catch {
    // 剪贴板不可用时用户自己选中复制
  }
}
</script>

<template>
  <teleport to="body">
    <div class="mask" @click="emit('close')">
      <div class="dialog" @click.stop>
        <div class="dialog-title">配对一台新设备</div>
        <div class="dialog-body">
          <label>
            设备名字
            <input v-model="deviceName" placeholder="比如「办公室的 Mac」" @keydown.enter="generate" />
          </label>

          <button class="btn primary" :disabled="busy || !store.connected" @click="generate">
            {{ busy ? '生成中…' : link ? '重新生成' : '生成配对二维码' }}
          </button>

          <p v-if="error" class="error">{{ error }}</p>

          <div v-if="svg" class="pairing">
            <div class="qr" v-html="svg" />
            <div class="link-box">
              <textarea :value="link" readonly rows="3" />
              <div class="link-actions">
                <button class="btn" @click="copyLink">复制链接</button>
                <span class="hint">令牌只显示这一次</span>
              </div>
              <div v-if="fingerprint" class="fingerprint">
                证书指纹：<code>{{ fingerprint }}</code>
              </div>
              <div class="hint">
                在另一台电脑的 Friday 里「添加机器」粘贴这条链接；或在手机上扫码。设备连上后可在远端的
                <code>friday-server --devices</code> 里查看和吊销。
              </div>
            </div>
          </div>

          <p v-if="!store.connected" class="hint">先连上一台机器（用 SSH 或 WSL），再从这台机器上生成配对。</p>
        </div>
        <div class="dialog-foot">
          <button class="btn" @click="emit('close')">关闭</button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 90;
}

.dialog {
  width: 620px;
  max-width: calc(100vw - 40px);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}

.dialog-title {
  font-weight: 600;
  padding: 14px 18px 0;
}

.dialog-body {
  padding: 12px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 13px;
  color: var(--text-2);
}

input,
textarea {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--panel-2);
  color: var(--text);
  outline: none;
  font-family: inherit;
}

input:focus {
  border-color: var(--accent);
}

textarea {
  font-size: 11.5px;
  resize: vertical;
  word-break: break-all;
}

.pairing {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  padding-top: 6px;
}

.qr {
  flex: none;
  padding: 8px;
  background: #fff;
  border-radius: 8px;
  border: 1px solid var(--border);
}

.qr :deep(svg) {
  display: block;
}

.link-box {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.link-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fingerprint {
  font-size: 11.5px;
  color: var(--text-2);
  word-break: break-all;
}

.hint {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.6;
  margin: 0;
}

.error {
  color: var(--fail);
  font-size: 12.5px;
  margin: 0;
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  padding: 0 18px 16px;
}
</style>
