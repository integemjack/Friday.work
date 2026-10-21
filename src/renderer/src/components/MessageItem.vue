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
      <!-- 工作中补充（qt MessageRow）：智能体工作时插入的，做完当时那一步就交给了它 -->
      <span
        v-if="message.interjected"
        class="agent interjected"
        title="智能体工作时发的：做完当时那一步就交给了它"
      >· 工作中补充</span>
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
  /* 窄栏（约 352px）密度优先：上下呼吸距收紧，让一行多容几个字 */
  padding: 2px 0 9px;
  /* 撑满聊天面板宽度：窄栏里 margin:auto 会把消息收缩成内容宽，宽度跟面板对不上 */
  max-width: 100%;
  margin: 0;
}

.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 12px;
}

.avatar {
  width: 17px;
  height: 17px;
  border-radius: 50%;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
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

.agent.interjected {
  color: var(--accent);
}

.tag.fail {
  color: var(--fail);
}

.notice {
  color: var(--text-2);
}

.block {
  margin: 2px 0;
}

/* 用户消息：右侧气泡；助手消息：通栏无底色 */
.message.user .block.text {
  display: flex;
  justify-content: flex-end;
}

/* 用户消息的附件/图片也靠右，跟文字气泡同一条右边线（否则图片甩在左边，看起来像插错了位置） */
.message.user .block.media {
  display: flex;
  justify-content: flex-end;
}

.message.user .block.media .media-name {
  background: var(--chip);
  border-radius: 8px;
  padding: 4px 10px;
}

.message.user .md {
  background: var(--accent-weak);
  border-radius: 10px;
  padding: 7px 11px;
  /* 窄栏里 85% 太浪费：同一段话会多出一两行 */
  max-width: 92%;
}

.message.user .md :deep(p) {
  margin: 0;
}

.empty {
  color: var(--text-3);
}

.stats {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-3);
}

.media-name {
  color: var(--text-2);
  font-size: 12px;
  /* 长文件名一行截断，不把气泡撑高 */
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thinking-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  font-size: 12px;
  padding: 2px 0;
}

.thinking-caret {
  font-size: 10px;
  color: var(--text-3);
}

.thinking-label {
  font-style: italic;
}

.thinking-body {
  margin: 3px 0 0;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--text-2);
  font-style: italic;
  background: var(--panel-2);
  border-left: 2px solid var(--border);
  white-space: pre-wrap;
  word-break: break-word;
}

/* markdown-it 输出的富文本样式（v-html 内容不带 scoped 标记，用 :deep）。
   窄栏里 13px/1.6 每行多容 1-2 字，长回复整体高度降一成多 */
.md {
  font-size: 13px;
  line-height: 1.6;
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
  margin: 12px 0 6px;
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
  font-size: 12px;
  background: var(--code-bg);
  border-radius: 4px;
  padding: 1px 5px;
}

.md :deep(pre) {
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  overflow: auto;
  margin: 6px 0;
  white-space: pre;
}

.md :deep(pre code) {
  background: none;
  padding: 0;
  font-size: inherit;
}

.md :deep(table) {
  border-collapse: collapse;
  margin: 6px 0;
  font-size: 12px;
  display: block;
  overflow-x: auto;
  max-width: 100%;
}

.md :deep(th),
.md :deep(td) {
  border: 1px solid var(--border);
  padding: 3px 8px;
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

/* 贾维斯界面：Friday 头像是 HUD 环（全局层已改底色），时间戳等宽化 */
[data-theme='jarvis'] .role {
  text-transform: uppercase;
  letter-spacing: 2px;
  font-size: 11.5px;
}

[data-theme='jarvis'] .message.assistant .role {
  color: var(--accent);
  opacity: 0.85;
}

/* 消息头右侧拉一条渐隐分隔线（HUD 报文头） */
[data-theme='jarvis'] .meta {
  display: flex;
  align-items: center;
}

[data-theme='jarvis'] .meta::after {
  content: '';
  flex: 1;
  height: 1px;
  margin-left: 10px;
  margin-right: 6px;
  background: linear-gradient(90deg, var(--accent-a45), var(--accent-a8));
  box-shadow: 0 0 6px var(--accent-a25);
}

/* 用户气泡：右侧切角 + 锚死右边线（含媒体块） */
[data-theme='jarvis'] .message.user .meta {
  flex-direction: row-reverse;
}

[data-theme='jarvis'] .message.user .block.text,
[data-theme='jarvis'] .message.user .block.media {
  justify-content: flex-end;
}

[data-theme='jarvis'] .message.user .md {
  clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 0 100%);
}

/* 流式占位（…）闪烁；思考块标签 HUD 化；统计行加能量符 */
[data-theme='jarvis'] .message.assistant .block.empty {
  font-family: var(--font-hud);
  color: var(--accent);
  animation: jt-blink 1s step-end infinite;
}

[data-theme='jarvis'] .thinking-label {
  font-family: var(--font-hud);
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--accent-a60);
}

[data-theme='jarvis'] .thinking-caret {
  color: var(--accent);
}

[data-theme='jarvis'] .stats {
  color: var(--accent-a55);
}

[data-theme='jarvis'] .stats::before {
  content: '◢ ';
  color: var(--accent);
}

[data-theme='jarvis'] .tag.fail {
  font-family: var(--font-hud);
  letter-spacing: 1px;
  border-color: var(--fail-a50);
  color: #ffc2cd;
}

@keyframes jt-blink {
  50% {
    opacity: 0;
  }
}
</style>
