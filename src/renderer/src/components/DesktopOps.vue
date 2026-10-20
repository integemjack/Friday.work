<script setup lang="ts">
// 桌面操作卡（2026-10 布局改版）：会话里的操作以极简终端样式直接投在桌面上——
// 没有标签页，只有「来自哪段会话 / 内容 / 结果」；有结果后 5 秒渐隐消失。
// 审批也走这里（带 批准/拒绝 按钮）；数据与定时全在 store（pushOp / scheduleOpFade / fadeOp）。
import { useAppStore } from '../stores/app.js'

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
</script>

<template>
  <div class="ops-layer">
    <transition-group name="pop">
      <div
        v-for="card in store.opCards"
        :key="card.id"
        class="op"
        :class="[card.status, { fading: card.fading, tall: card.tall }]"
        :style="{ left: `${card.x}px`, top: `${card.y}px`, zIndex: card.z }"
        @click="card.status !== 'awaitingApproval' && card.status !== 'running' && store.fadeOp(card.id)"
      >
        <div class="from">来自 {{ titleOf(card.conversationID) }}</div>
        <div class="line cmd">
          <span class="mark">{{ statusMark[card.status] ?? '·' }}</span>
          <span class="body">
            <span class="title">{{ card.title }}</span>
            <span v-if="card.content" class="content">{{ card.content }}</span>
          </span>
        </div>
        <div v-if="card.result" class="line result" :class="card.status">{{ card.result }}</div>
        <div v-if="card.status === 'awaitingApproval'" class="approval-row">
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

.op {
  position: absolute;
  pointer-events: auto;
  width: 400px;
  max-width: 44vw;
  padding: 6px 10px 8px;
  border-radius: 8px;
  border: 1px solid var(--accent-a22);
  background: rgba(4, 8, 14, 0.86);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  font-family: var(--font-mono, ui-monospace, Consolas, monospace);
  cursor: pointer;
}

.from {
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--text-3);
  margin-bottom: 3px;
  /* 占满整宽，超出的会话名在右缘渐隐，不用 ... 截断 */
  overflow: hidden;
  white-space: nowrap;
  -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);
  mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);
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
  max-height: 72px;
  overflow: hidden;
}

/* 全量内容的卡（执行命令/写入文件/看图/看视频）：内容与结果不截断，
   各自限高与思考气泡一致（400，窗口矮时按窗口收紧），内部滚动看全文 */
.op.tall .content,
.op.tall .result {
  max-height: min(400px, calc(100vh - 116px));
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.op.tall .content::-webkit-scrollbar,
.op.tall .result::-webkit-scrollbar {
  width: 6px;
}

.op.tall .content::-webkit-scrollbar-thumb,
.op.tall .result::-webkit-scrollbar-thumb {
  background: var(--accent-a45);
  border: none;
  border-radius: 3px;
}

.op.tall .content::-webkit-scrollbar-thumb:hover,
.op.tall .result::-webkit-scrollbar-thumb:hover {
  background: var(--accent-a70);
}

.op.tall .content::-webkit-scrollbar-track,
.op.tall .result::-webkit-scrollbar-track {
  background: transparent;
}

.result {
  margin-top: 3px;
  padding-top: 3px;
  border-top: 1px dashed var(--line);
  color: var(--text-2);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 96px;
  overflow: hidden;
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

/* 渐隐：结果后 5 秒计时到 → fadeOp 加 fading → 动画完从数组里删 */
.op.fading {
  animation: op-out 0.6s ease forwards;
}

@keyframes op-out {
  to {
    opacity: 0;
    transform: translateY(6px);
  }
}

.pop-enter-active {
  animation: op-in 0.18s ease;
}

@keyframes op-in {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }
}
</style>
