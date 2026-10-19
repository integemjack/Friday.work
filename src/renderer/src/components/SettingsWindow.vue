<script setup lang="ts">
// 设置窗口（M4）：看这台远程机器的引擎、Agent 设置、服务状态（只读展示；方案 §10 M4「设置页（远程的 engines/settings 只读版）」）。
import { computed, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()
const loading = ref(false)
const error = ref('')

interface EngineView {
  id: string
  title: string
  model: string
  kind?: string
  supportsTools?: boolean
  subAgentAllowed?: boolean
  disabled?: boolean
}

const engines = ref<EngineView[]>([])
const settings = ref<Record<string, unknown> | null>(null)
const server = ref<Record<string, unknown> | null>(null)

const machine = computed(() => store.currentMachineInfo)

// 客户端更新（主进程 ClientUpdate；状态在 store.update，启动时主进程自动查过一次）
const update = computed(() => store.update)
const updateBusy = computed(() => update.value.phase === 'checking' || update.value.phase === 'downloading')
const canInstall = computed(() => update.value.phase === 'available' || update.value.phase === 'ready')
const installLabel = computed(() =>
  update.value.phase === 'ready' ? '重新下载' : update.value.platform === 'win32' ? '下载并安装' : '下载安装包'
)
const commitText = computed(() => {
  const commit = update.value.currentCommit
  if (!commit || commit === 'dev') return '开发版'
  return commit.slice(0, 7)
})
const percentText = computed(() => `${Math.round(update.value.progress * 100)}%`)

async function load(): Promise<void> {
  if (!store.currentMachine || !store.connected) return
  loading.value = true
  error.value = ''
  try {
    // 引擎没有单独的查询方法：用 hello 快照 + engines 事件维护的那份（REMOTE.md §5）
    engines.value = store.engines as EngineView[]
  } catch {
    engines.value = []
  }
  try {
    settings.value = (await store.rpc(store.currentMachine, 'settings.get', {})) as Record<string, unknown>
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  try {
    server.value = (await store.rpc(store.currentMachine, 'server.status', {})) as Record<string, unknown>
  } catch {
    // 旧服务端没有这个方法
  }
  loading.value = false
}

/** 设置里挑几项给人看的 */
const settingRows = computed<Array<{ key: string; label: string; value: string }>>(() => {
  const value = settings.value
  if (!value) return []
  const rows: Array<{ key: string; label: string; value: string }> = []
  const push = (key: string, label: string): void => {
    const raw = value[key]
    if (raw === undefined || raw === null || raw === '') return
    rows.push({ key, label, value: typeof raw === 'boolean' ? (raw ? '开' : '关') : String(raw) })
  }
  push('defaultPermissionMode', '默认权限模式')
  push('teamMode', '工作方式')
  push('defaultEngineID', '默认引擎')
  push('lightEngineID', '小活用的模型')
  push('subAgentEngineID', '子智能体用的模型')
  push('quotaFallback', '额度用完时')
  push('enableThinking', '默认开思考')
  push('requireApproval', '工具调用要确认')
  push('confirmPaidCalls', '付费调用要确认')
  push('workingDirectory', '默认工作目录')
  return rows
})

const serverRows = computed<Array<{ label: string; value: string }>>(() => {
  const value = server.value
  if (!value) return []
  const rows: Array<{ label: string; value: string }> = []
  const push = (key: string, label: string): void => {
    const raw = value[key]
    if (raw === undefined || raw === null) return
    rows.push({ label, value: typeof raw === 'object' ? JSON.stringify(raw) : String(raw) })
  }
  push('version', '版本')
  push('protocol', '协议版本')
  push('hostname', '主机名')
  push('user', '用户')
  push('dataDirectory', '数据目录')
  push('clients', '客户端数')
  push('host', '服务来源')
  return rows
})

onMounted(load)
</script>

<template>
  <div class="settings">
    <div class="head">
      <span class="title">来自 {{ machine?.name ?? '（未连接）' }} 的只读信息</span>
      <button class="small-btn" :disabled="loading || !store.connected" @click="load">
        {{ loading ? '读取中…' : '刷新' }}
      </button>
    </div>

    <section>
      <h3>客户端更新</h3>
      <div class="row">
        <span class="key">当前版本</span>
        <span class="value">{{ update.currentVersion || '…' }}（{{ commitText }}）</span>
      </div>
      <div v-if="update.version" class="row">
        <span class="key">可用更新</span>
        <span class="value">
          {{ update.version }}<span v-if="update.commit">（{{ update.commit.slice(0, 7) }}）</span>
        </span>
      </div>
      <div v-if="update.phase === 'downloading'" class="progress">
        <div class="bar" :style="{ width: percentText }" />
      </div>
      <div v-if="update.phase === 'uptodate'" class="note">已是最新版本。</div>
      <div v-if="update.note" class="note">{{ update.note }}</div>
      <div v-if="update.error" class="error">{{ update.error }}</div>
      <div class="update-actions">
        <button class="small-btn" :disabled="updateBusy" @click="store.checkUpdate()">
          {{ update.phase === 'checking' ? '检查中…' : '检查更新' }}
        </button>
        <button
          v-if="canInstall"
          class="small-btn strong"
          :disabled="updateBusy"
          @click="store.installUpdate()"
        >
          {{ update.phase === 'downloading' ? `下载中 ${percentText}` : installLabel }}
        </button>
      </div>
    </section>

    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="!store.connected" class="empty">先连上一台机器。</div>

    <template v-else>
      <section>
        <h3>服务</h3>
        <div v-if="!serverRows.length" class="empty-line">没有服务信息</div>
        <div v-for="row in serverRows" :key="row.label" class="row">
          <span class="key">{{ row.label }}</span>
          <span class="value">{{ row.value }}</span>
        </div>
      </section>

      <section>
        <h3>引擎</h3>
        <div v-if="!engines.length" class="empty-line">这台机器没有可用的引擎</div>
        <div v-for="engine in engines" :key="engine.id" class="engine">
          <div class="engine-main">
            <span class="engine-title">{{ engine.title }}</span>
            <span class="engine-model">{{ engine.model }}</span>
          </div>
          <div class="engine-tags">
            <span v-if="engine.kind" class="tag">{{ engine.kind }}</span>
            <span v-if="engine.supportsTools" class="tag">工具</span>
            <span v-if="engine.subAgentAllowed" class="tag">子 Agent 可用</span>
            <span v-if="engine.disabled" class="tag off">已停用</span>
          </div>
        </div>
      </section>

      <section>
        <h3>Agent 设置</h3>
        <div v-if="!settingRows.length" class="empty-line">没有读到设置</div>
        <div v-for="row in settingRows" :key="row.key" class="row">
          <span class="key">{{ row.label }}</span>
          <span class="value">{{ row.value }}</span>
        </div>
        <div class="note">这些值在远端 Friday 上改；这里只展示。</div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.settings {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px 20px;
  background: var(--panel);
  font-size: 12.5px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 10px;
}

.title {
  color: var(--text-2);
  font-size: 12px;
}

.small-btn {
  font-size: 12px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text-2);
}

.small-btn:hover:not(:disabled) {
  color: var(--text);
}

.small-btn:disabled {
  opacity: 0.5;
}

.small-btn.strong {
  color: var(--text);
  border-color: var(--text-3);
}

.progress {
  height: 4px;
  border-radius: 2px;
  background: var(--chip);
  overflow: hidden;
  margin: 6px 0;
}

.bar {
  height: 100%;
  border-radius: 2px;
  background: var(--text-3);
  transition: width 0.2s ease;
}

.update-actions {
  display: flex;
  gap: 8px;
  padding-top: 6px;
}

section {
  margin-bottom: 18px;
}

h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}

.row {
  display: flex;
  gap: 12px;
  padding: 3px 0;
}

.key {
  flex: 0 0 130px;
  color: var(--text-3);
}

.value {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.engine {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 6px;
}

.engine-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.engine-title {
  font-weight: 500;
}

.engine-model {
  color: var(--text-3);
  font-size: 11.5px;
}

.engine-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--chip);
  color: var(--text-2);
}

.tag.off {
  color: var(--fail);
}

.note {
  color: var(--text-3);
  font-size: 11.5px;
  padding-top: 6px;
}

.empty,
.empty-line {
  color: var(--text-3);
  font-size: 12.5px;
  padding: 8px 0;
}

.error {
  color: var(--fail);
  padding: 6px 0;
}
</style>
