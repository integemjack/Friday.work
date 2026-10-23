<script setup lang="ts">
// 桌面操作卡（2026-10 布局改版）：会话里的操作以极简终端样式直接投在桌面上——
// 没有标签页，只有「来自哪段会话 / 内容 / 结果」；有结果后 5 秒渐隐消失。
// 面板基础（定位/毛玻璃/标题行渐隐/滚动条/进出场动画）与思考/回复气泡共用 styles/cast.css；
// 所有卡一套限高（不截断，超高内部滚动），无 tall 普通卡之分。
// 审批也走这里（要批准的调用带 批准/拒绝 按钮）；ask_user 的问题不是批准——展开成问题面板
// （选项点选/自己写/跳过，AskPanel）；数据与定时全在 store（pushOp / scheduleOpFade / fadeOp）。
import { useAppStore } from '../stores/app.js'
import InlineMedia from './InlineMedia.vue'
import AskPanel from './AskPanel.vue'

const store = useAppStore()

function titleOf(conversationID: string): string {
  return store.summaries.find((item) => item.id === conversationID)?.title ?? '会话'
}

const statusMark: Record<string, string> = {
  running: '…',
  awaitingApproval: '⏸',
  succeeded: '✓',
  failed: '✗',
  denied: '⊘'
}

function onCardClick(card: { id: string; status: string }): void {
  // 拖选卡里的命令/结果后松开也算 click：有选中文字就不当成「点没」（那是想复制）
  if (window.getSelection()?.toString()) return
  if (card.status !== 'awaitingApproval' && card.status !== 'running') store.fadeOp(card.id)
}
</script>

<template>
  <div class="ops-layer">
    <transition-group name="pop">
      <div
        v-for="card in store.opCards"
        :key="card.id"
        class="op cast"
        :class="[card.status, { fading: card.fading }]"
        :style="{ left: `${card.x}px`, top: `${card.y}px`, zIndex: card.z }"
        @click="onCardClick(card)"
      >
        <div class="from cast-head">来自 {{ titleOf(card.conversationID) }}</div>
        <div class="line cmd">
          <span class="mark">{{ statusMark[card.status] ?? '·' }}</span>
          <span class="body">
            <span class="title">{{ card.title }}</span>
            <span v-if="card.content" class="content cast-scroll">{{ card.content }}</span>
          </span>
        </div>
        <!-- 看图/看视频的卡：媒体直接嵌在卡里（图片内联显示、视频静音循环自动播放）。
             点媒体不冒泡，不会把卡点没 -->
        <InlineMedia
          v-if="card.toolName"
          class="op-media"
          :name="card.toolName"
          :args="card.content"
          :conversationID="card.conversationID"
          compact
        />
        <div v-if="card.result" class="line result cast-scroll" :class="card.status">{{ card.result }}</div>
        <!-- ask_user 在等回答：问题面板（单选点一下就过、多选勾完确定、自己写、跳过） -->
        <AskPanel
          v-if="card.status === 'awaitingApproval' && card.questions?.length"
          class="ask-row"
          :questions="card.questions"
          :answered="store.answeredAsks.has(card.id)"
          @answer="(payload) => store.answerQuestion(card.id, payload)"
          @skip="store.skipQuestion(card.id)"
        />
        <div v-else-if="card.status === 'awaitingApproval'" class="approval-row">
          <button class="abtn" @click.stop="store.resolveApproval(card.id, false)">拒绝</button>
          <button class="abtn primary" @click.stop="store.resolveApproval(card.id, true)">批准</button>
        </div>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.ops-layer {
  /* 不设 z-index（auto 不建层叠上下文）：与气泡层同在投层里，卡/气泡的 z 才能跨类比较（最近活动的置顶） */
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* 面板基础（定位/点击穿透/毛玻璃/点击手型）在公共 .cast（styles/cast.css） */
.op {
  width: 400px;
  max-width: 44vw;
  padding: 6px 10px 8px;
  border-radius: 8px;
  border: 1px solid var(--accent-a22);
  background: rgba(4, 8, 14, 0.86);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.5);
  font-family: var(--font-mono, ui-monospace, Consolas, monospace);
}

.from {
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--text-3);
  margin-bottom: 3px;
  /* 右缘渐隐 mask 在公共 .cast-head */
}

.line {
  display: flex;
  gap: 7px;
  align-items: baseline;
  font-size: 12px;
  line-height: 1.5;
}

.mark {
  flex: none;
  color: var(--accent);
  width: 12px;
  text-align: center;
}

.op.awaitingApproval .mark {
  color: var(--warn);
  animation: blink 1.2s ease-in-out infinite;
}

.op.failed .mark,
.op.denied .mark {
  color: var(--fail);
}

.op.succeeded .mark {
  color: var(--ok, var(--accent));
}

@keyframes blink {
  50% {
    opacity: 0.3;
  }
}

.body {
  min-width: 0;
}

.title {
  color: var(--fg);
}

.content {
  display: block;
  color: var(--text-2);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 内容/结果统一一套限高（原普通卡 72px/96px 截断与全量卡的分叉已并入）：不截断文本，
   限高与思考气泡同源（lib/cast.ts 经 --cast-max-h 注入），超高内部滚动看全文；
   滚动条样式在公共 .cast-scroll。
   滚动条贴紧卡右边框：负 margin 抵消卡的右内边距（10px），文字再补回右内边距。
   不能加 scrollbar-gutter:stable——它会把滚动条连着预留槽一起缩到元素内侧，
   离右边框空出一个滚动条宽（实验实测）；代价是滚动条出现时文字窄 6px，可接受 */
.content,
.result {
  max-height: var(--cast-max-h, 400px);
  overflow-y: auto;
  margin-right: -10px;
  padding-right: 10px;
}

.op-media {
  margin: 5px 0 0;
}

.result {
  margin-top: 3px;
  padding-top: 3px;
  border-top: 1px dashed var(--line);
  color: var(--text-2);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
}

.result.failed,
.result.denied {
  color: var(--fail);
}

.result.succeeded {
  color: var(--ok, var(--accent));
}

.approval-row {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 5px;
}

/* ask_user 的问题面板：深色卡上的一套变量（AskPanel 内部用） */
.ask-row {
  margin-top: 5px;
  --ask-line: var(--line);
  --ask-accent: var(--accent);
  --ask-picked: var(--accent-a15, rgba(80, 170, 255, 0.15));
}

.abtn {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--fg-2, var(--fg));
  font-size: 11px;
  padding: 1px 9px;
  border-radius: 5px;
  cursor: pointer;
}

.abtn:hover {
  border-color: var(--accent);
}

.abtn.primary {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.abtn.primary:hover {
  background: var(--accent-a15, rgba(80, 170, 255, 0.15));
}

/* 渐隐与进场动画在公共 .cast（.cast.fading / .pop-enter-active，styles/cast.css） */
</style>
