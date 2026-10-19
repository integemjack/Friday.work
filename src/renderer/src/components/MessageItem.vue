<script setup lang="ts">
// 消息流的单条消息/块渲染（方案 §5.3）：
//  - text：Markdown（流式增量追加；停在底部时跟随滚动）
//  - thinking：可折叠「思考」块
//  - tool：工具卡片（展开看完整参数/结果，transcript 递归渲染）
import { computed, ref } from 'vue'
import type { ChatMessage, ToolEvent } from '../../../protocol/rpc/protocol.js'
import { blockCase, blockPayload } from '../../../protocol/rpc/protocol.js'
import ToolCard from './ToolCard.vue'

const props = defineProps<{ message: ChatMessage }>()

const blocks = computed(() => props.message.blocks ?? [])
const showThinking = ref(false)

function isUser(): boolean {
  return props.message.role === 'user'
}
</script>

<template>
  <div class="message" :class="{ user: isUser(), assistant: !isUser() }">
    <div class="meta">
      <span class="role">{{ isUser() ? '你' : 'Friday' }}</span>
      <span v-if="message.agentName" class="agent">· {{ message.agentName }}</span>
      <span v-if="message.sentBy" class="agent">· 助手发送 · {{ message.sentBy }}</span>
      <span v-if="message.error" class="tag fail">{{ message.error }}</span>
      <span v-if="message.notice" class="notice">{{ message.notice }}</span>
    </div>

    <div v-if="blocks.length === 0 && !message.error" class="block empty">…</div>

    <template v-for="block in blocks" :key="block.id">
      <!-- text -->
      <div v-if="blockCase(block) === 'text'" class="block text">
        <pre class="text-content">{{ blockPayload<string>(block, 'text') }}</pre>
      </div>

      <!-- thinking -->
      <div v-else-if="blockCase(block) === 'thinking'" class="block thinking">
        <button class="thinking-head" @click="showThinking = !showThinking">
          <span>{{ showThinking ? '▾' : '▸' }}</span>
          <span class="thinking-label">思考</span>
        </button>
        <pre v-if="showThinking" class="thinking-body">{{ blockPayload<string>(block, 'thinking') }}</pre>
      </div>

      <!-- tool -->
      <div v-else-if="blockCase(block) === 'tool'" class="block">
        <ToolCard :tool="(blockPayload<ToolEvent>(block, 'tool') as ToolEvent)" />
      </div>

      <!-- media -->
      <div v-else-if="blockCase(block) === 'media'" class="block media">
        <span class="media-name">📎 {{ (blockPayload<{ fileName?: string }>(block, 'media'))?.fileName ?? '附件' }}</span>
      </div>
    </template>

    <div v-if="message.stats" class="stats">
      {{ Math.round(message.stats.tokensPerSecond ?? 0) }} tok/s · {{ message.stats.tokenCount ?? 0 }} tokens
      <span v-if="message.stats.engineName"> · {{ message.stats.engineName }}</span>
    </div>
  </div>
</template>

<style scoped>
.message {
  padding: 6px 0 14px;
  max-width: 760px;
  margin: 0 auto;
}

.message.user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.message.user .text-content {
  background: var(--accent-weak);
  border-radius: 10px;
  padding: 10px 14px;
  white-space: pre-wrap;
  max-width: 85%;
}

.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
  font-size: 12.5px;
}

.message.user .meta {
  align-self: flex-end;
}

.role {
  font-weight: 600;
  color: var(--text-2);
}

.agent {
  color: var(--text-3);
}

.tag.fail {
  color: var(--fail);
}

.notice {
  color: var(--text-2);
}

.block {
  margin: 4px 0;
}

.text-content {
  margin: 0;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  background: none;
  padding: 2px 0;
}

.thinking-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  font-size: 12.5px;
  padding: 3px 0;
}

.thinking-label {
  font-style: italic;
}

.thinking-body {
  margin: 4px 0 0;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--text-2);
  font-style: italic;
  background: var(--panel-2);
  border-left: 2px solid var(--border);
  white-space: pre-wrap;
  word-break: break-word;
}

.empty {
  color: var(--text-3);
}

.stats {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-3);
}

.media-name {
  color: var(--text-2);
  font-size: 13px;
}
</style>