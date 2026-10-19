<script setup lang="ts">
// 消息流的单条消息/块渲染（方案 §5.3）：
//  - text：Markdown 渲染（流式增量追加；停在底部时跟随滚动）
//  - thinking：可折叠「思考」块（每块独立开合）
//  - tool：工具卡片（展开看完整参数/结果，transcript 递归渲染）
import { computed, ref } from 'vue'
import type { ChatMessage, ToolEvent } from '../../../protocol/rpc/protocol.js'
import { blockCase, blockPayload } from '../../../protocol/rpc/protocol.js'
import { renderMarkdown } from '../lib/markdown.js'
import ToolCard from './ToolCard.vue'

const props = defineProps<{ message: ChatMessage }>()

const blocks = computed(() => props.message.blocks ?? [])
/** 每个思考块独立的展开状态（按块 id，互不影响） */
const openThinking = ref<Record<string, boolean>>({})

function isUser(): boolean {
  return props.message.role === 'user'
}

function toggleThinking(blockID: string): void {
  openThinking.value[blockID] = !openThinking.value[blockID]
}

function md(blockID: string, caseName: string): string {
  const block = blocks.value.find((b) => b.id === blockID)
  if (!block) return ''
  return renderMarkdown(blockPayload<string>(block, caseName))
}
</script>

<template>
  <div class="message" :class="{ user: isUser(), assistant: !isUser() }">
    <div class="meta">
      <span class="avatar" :class="{ user: isUser() }">{{ isUser() ? '你' : 'F' }}</span>
      <span class="role">{{ isUser() ? '你' : 'Friday' }}</span>
      <span v-if="message.agentName" class="agent">· {{ message.agentName }}</span>
      <span v-if="message.sentBy" class="agent">· 助手发送 · {{ message.sentBy }}</span>
      <span v-if="message.error" class="tag fail">{{ message.error }}</span>
      <span v-if="message.notice" class="notice">{{ message.notice }}</span>
    </div>

    <div v-if="blocks.length === 0 && !message.error" class="block empty">…</div>

    <template v-for="block in blocks" :key="block.id">
      <!-- text：Markdown 渲染 -->
      <div v-if="blockCase(block) === 'text'" class="block text" :class="{ user: isUser() }">
        <div class="md" v-html="md(block.id, 'text')" />
      </div>

      <!-- thinking：每块独立折叠 -->
      <div v-else-if="blockCase(block) === 'thinking'" class="block thinking">
        <button class="thinking-head" @click="toggleThinking(block.id)">
          <span class="thinking-caret">{{ openThinking[block.id] ? '▾' : '▸' }}</span>
          <span class="thinking-label">思考</span>
        </button>
        <pre v-if="openThinking[block.id]" class="thinking-body">{{ blockPayload<string>(block, 'thinking') }}</pre>
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
  padding: 4px 0 12px;
  max-width: 760px;
  margin: 0 auto;
}

.meta {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 6px;
  font-size: 12.5px;
}

.avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
}

.avatar.user {
  background: var(--chip);
  color: var(--text-2);
}

.message.user .meta {
  flex-direction: row-reverse;
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

/* 用户消息：右侧气泡；助手消息：通栏无底色 */
.message.user .block.text {
  display: flex;
  justify-content: flex-end;
}

.message.user .md {
  background: var(--accent-weak);
  border-radius: 12px;
  padding: 9px 13px;
  max-width: 85%;
}

.message.user .md :deep(p) {
  margin: 0;
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

.thinking-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  font-size: 12.5px;
  padding: 3px 0;
}

.thinking-caret {
  font-size: 10px;
  color: var(--text-3);
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

/* markdown-it 输出的富文本样式（v-html 内容不带 scoped 标记，用 :deep） */
.md {
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
}

.md :deep(p) {
  margin: 0 0 10px;
}

.md :deep(p:last-child) {
  margin-bottom: 0;
}

.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) {
  margin: 16px 0 8px;
  line-height: 1.4;
  font-weight: 650;
}

.md :deep(h1) { font-size: 1.35em; }
.md :deep(h2) { font-size: 1.22em; }
.md :deep(h3) { font-size: 1.1em; }
.md :deep(h4) { font-size: 1em; }

.md :deep(h1:first-child),
.md :deep(h2:first-child),
.md :deep(h3:first-child) {
  margin-top: 0;
}

.md :deep(ul),
.md :deep(ol) {
  margin: 6px 0;
  padding-left: 22px;
}

.md :deep(li) {
  margin: 3px 0;
}

.md :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.md :deep(a:hover) {
  text-decoration: underline;
}

.md :deep(blockquote) {
  margin: 8px 0;
  padding: 2px 12px;
  border-left: 3px solid var(--border);
  color: var(--text-2);
}

.md :deep(code) {
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12.5px;
  background: var(--code-bg);
  border-radius: 4px;
  padding: 1px 5px;
}

.md :deep(pre) {
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12.5px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  overflow: auto;
  margin: 8px 0;
  white-space: pre;
}

.md :deep(pre code) {
  background: none;
  padding: 0;
  font-size: inherit;
}

.md :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 13px;
  display: block;
  overflow-x: auto;
  max-width: 100%;
}

.md :deep(th),
.md :deep(td) {
  border: 1px solid var(--border);
  padding: 5px 10px;
  text-align: left;
}

.md :deep(th) {
  background: var(--panel-2);
  font-weight: 600;
}

.md :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 12px 0;
}

.md :deep(img) {
  max-width: 100%;
  border-radius: 8px;
}
</style>
