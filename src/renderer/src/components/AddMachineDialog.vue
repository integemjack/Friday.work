<script setup lang="ts">
// 添加机器：粘贴 user@host、user@host:端口、wsl:发行版，或配对链接（friday://pair?…）
import { ref } from 'vue'
import { useAppStore } from '../stores/app.js'

const emit = defineEmits<{ close: [] }>()

const store = useAppStore()
const target = ref('')
const name = ref('')
const identityFile = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')

async function submit() {
  if (!target.value.trim() || busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (password.value) {
      // 密码添加（M4）：一次性装公钥，之后走密钥；密码不落盘
      await store.addMachineWithPassword(target.value.trim(), password.value, name.value.trim() || undefined)
    } else {
      await store.addMachine(target.value.trim(), name.value.trim() || undefined, identityFile.value.trim() || undefined)
    }
    emit('close')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <teleport to="body">
    <div class="mask" @click="emit('close')">
      <div class="dialog" @click.stop>
        <div class="dialog-title">添加机器</div>
        <div class="dialog-body">
          <label>
            地址
            <input
              v-model="target"
              autofocus
              placeholder="user@host、user@host:端口、wsl:发行版，或 friday://pair?… 配对链接"
              @keydown.enter="submit"
            />
          </label>
          <label>
            名字（可选）
            <input v-model="name" placeholder="比如「家里的服务器」" />
          </label>
          <label>
            私钥文件（可选，SSH 用）
            <input v-model="identityFile" placeholder="C:\Users\你\.ssh\id_ed25519" />
          </label>
          <label>
            密码（可选：还不知道密钥时填，只会用这一次把公钥装上去）
            <input v-model="password" type="password" placeholder="不填就用密钥 / ssh-agent" @keydown.enter="submit" />
          </label>
          <p class="hint">
            SSH 默认只支持密钥 / ssh-agent；填了密码会一次性登录把本机公钥装进远端 authorized_keys，之后不再用密码。
            配对链接在远程机器上运行 <code>friday-server --pair</code> 生成。
          </p>
          <p v-if="error" class="error">{{ error }}</p>
        </div>
        <div class="dialog-foot">
          <button class="btn" @click="emit('close')">取消</button>
          <button class="btn primary" :disabled="busy || !target.trim()" @click="submit">
            {{ busy ? '正在连…' : '添加并连接' }}
          </button>
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
  width: 460px;
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
  padding: 10px 18px;
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

input {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--panel-2);
  color: var(--text);
  outline: none;
}

input:focus {
  border-color: var(--accent);
}

.hint {
  font-size: 12px;
  color: var(--text-3);
  margin: 0;
  line-height: 1.6;
}

.error {
  color: var(--fail);
  font-size: 12.5px;
  margin: 0;
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 0 18px 16px;
}
</style>
