<script setup lang="ts">
// 助手时间线（M2「助手时间线」）：这台机器的助手日志 + 本地通话记录。
// 数据源：assistant.subscribe（entries），流式的同一条会被服务端合并后重发。
import { computed, onMounted, ref } from 'vue'
import type { AssistantEntry } from '../../../protocol/rpc/protocol.js'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()
const loading = ref(false)
const error = ref('')

const entries = computed(() =>
  [...store.assistantEntries].sort((a, b) => String(a.at).localeCompare(String(b.at)))
)

onMounted(async () => {
  if (store.assistantSubscribed || !store.currentMachine || !store.connected) return
  loading.value = true
  try {
    const result = (await store.rpc(store.currentMachine, 'assistant.subscribe', { count: 100 })) as {
      entries?: AssistantEntry[]
      state?: { enabled?: boolean }
    }
    store.assistantEntries = result.entries ?? []
    store.assistantEnabled = result.state?.enabled ?? false
    store.assistantSubscribed = true
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
})

function icon(entry: AssistantEntry): string {
  if (entry.data?.name === 'call') return '📞'
  switch (entry.kind) {
    case 'user':
      return '🧑'
    case 'assistant':
      return 'Friday'
    case 'tool':
      return '🔧'
    case 'receipt':
      return '✓'
    case 'notice':
      return '•'
    default:
      return '•'
  }
}

function timeText(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(
    date.getHours()
  ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function bodyText(entry: AssistantEntry): string {
  if (entry.text) return entry.text
  const name = entry.data?.name
  const result = entry.data?.result
  if (name && result) return `${name}：${result}`
  return name ?? ''
}
</script>

<template>
  <div class="timeline">
    <div v-if="!store.connected" class="tip">还没连上机器。</div>
    <div v-else-if="!store.assistantEnabled" class="tip">这台机器的助手关着：这里只显示本机的通话记录。</div>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="loading" class="tip">正在读…</div>

    <div class="rows">
      <div v-for="entry in entries" :key="entry.id" class="row" :class="entry.kind">
        <span class="at">{{ timeText(String(entry.at)) }}</span>
        <span class="who">{{ icon(entry) }}</span>
        <span class="body">
          {{ bodyText(entry) }}
          <span v-if="entry.streaming" class="stream">…</span>
          <span v-if="entry.data?.error" class="bad">（出错）</span>
        </span>
      </div>
      <div v-if="entries.length === 0 && !loading" class="tip">还没有记录。助手开始干活、或者打一通电话，这里就会长出来。</div>
    </div>
  </div>
</template>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--panel);
}
.tip {
  padding: 12px 14px;
  color: var(--text-3);
  font-size: 12.5px;
  line-height: 1.7;
  border-bottom: 1px solid var(--border);
}
.error {
  padding: 8px 14px;
  color: var(--fail);
  font-size: 12.5px;
  border-bottom: 1px solid var(--border);
}
.rows {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 8px 12px;
}
.row {
  display: grid;
  grid-template-columns: 74px 46px 1fr;
  gap: 8px;
  align-items: start;
  padding: 7px 6px;
  border-radius: 7px;
  font-size: 13px;
  line-height: 1.6;
}
.row:hover {
  background: var(--panel-2);
}
.row.assistant .body {
  color: var(--text);
}
.row.user .body {
  color: var(--text-2);
}
.at {
  color: var(--text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  padding-top: 2px;
}
.who {
  color: var(--text-2);
  font-size: 11.5px;
  text-align: center;
  padding-top: 1px;
}
.body {
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.stream {
  color: var(--accent);
}
.bad {
  color: var(--fail);
}
</style>
