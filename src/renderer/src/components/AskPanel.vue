<script setup lang="ts">
// ask_user 的问题面板（qt/docs/ASK.md §2 的桌面版）：Friday 想问你的事就地展开成选项——
// 单选点一下就进下一题（最后一题点了就交）、多选勾上再「确定」、也能自己写、也能跳过（按推荐的做）。
// 用在两处：聊天面板的审批横幅（AssistantChat，橙底白字）和桌面的操作卡（DesktopOps，深色），
// 颜色走 --ask-line / --ask-accent 两个变量，两边的父级各给一套。
import { computed, ref } from 'vue'
import type { AskQuestion } from '../../../protocol/rpc/protocol.js'
import { buildAskAnswer, type AskAnswer } from '../lib/askUser.js'

const props = defineProps<{ questions: AskQuestion[]; answered?: boolean }>()
const emit = defineEmits<{ answer: [payload: AskAnswer]; skip: [] }>()

/** 答到第几题（0 起）。只在挂载时按题面初始化：同一个 eventID 的事件重发内容不变，别把答到一半的进度冲掉 */
const index = ref(0)
/** 每题点了的选项名。单选先把推荐的点上（不看直接交 = 按推荐的做，与服务端跳过语义一致） */
const picked = ref<string[][]>(
  props.questions.map((question) =>
    !question.multiple && question.recommended !== undefined && question.recommended >= 0
      ? [question.options[question.recommended]?.label ?? '']
      : []
  )
)
/** 每题自己写的字（点过选项的题以选项为准） */
const own = ref<string[]>(props.questions.map(() => ''))

const question = computed(() => props.questions[index.value])
const last = computed(() => index.value >= props.questions.length - 1)

function isPicked(label: string): boolean {
  return (picked.value[index.value] ?? []).includes(label)
}

/** 单选点一下：记下这题的答案就进下一题；多选只勾选，等「确定」 */
function choose(label: string) {
  const at = index.value
  if (question.value?.multiple) {
    const list = picked.value[at] ?? []
    picked.value[at] = list.includes(label) ? list.filter((item) => item !== label) : [...list, label]
  } else {
    picked.value[at] = [label]
    advance()
  }
}

/** 进下一题；最后一题（或只有一题）就交 */
function advance() {
  if (props.answered) return
  if (last.value) submit()
  else index.value += 1
}

function submit() {
  if (props.answered) return
  emit('answer', buildAskAnswer(picked.value, own.value))
}
</script>

<template>
  <div class="ask" data-testid="ask-panel">
    <div class="ask-head">
      <span class="ask-badge">?</span>
      <span class="ask-title">Friday 想问你</span>
      <span v-if="questions.length > 1" class="ask-step">{{ index + 1 }}/{{ questions.length }}</span>
    </div>
    <div v-if="question" class="ask-question">{{ question.question }}</div>
    <div v-if="question" class="ask-options">
      <button
        v-for="(option, at) in question.options"
        :key="option.label"
        type="button"
        class="ask-option"
        :class="{ picked: isPicked(option.label), recommended: at === question.recommended }"
        :disabled="answered"
        @click="choose(option.label)"
      >
        <span class="ask-mark">{{ question.multiple ? (isPicked(option.label) ? '☑' : '☐') : isPicked(option.label) ? '●' : '○' }}</span>
        <span class="ask-label">{{ option.label }}</span>
        <span v-if="at === question.recommended" class="ask-rec">推荐</span>
        <span v-if="option.detail" class="ask-detail">{{ option.detail }}</span>
      </button>
    </div>
    <div class="ask-own">
      <input
        v-model="own[index]"
        type="text"
        :placeholder="`或者自己写一句…（回车${last ? '交' : '进下一题'}）`"
        :disabled="answered"
        @keydown.enter="advance"
      />
    </div>
    <div class="ask-actions">
      <span v-if="answered" class="ask-done">已交，等 Friday 接着说…</span>
      <template v-else>
        <button v-if="index > 0" type="button" class="ask-btn" @click="index -= 1">上一题</button>
        <button type="button" class="ask-btn primary" @click="advance">{{ last ? '确定' : '下一题' }}</button>
        <button type="button" class="ask-btn" @click="emit('skip')">跳过</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ask {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
}

.ask-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ask-badge {
  flex: none;
  width: 15px;
  height: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--ask-accent, currentColor);
  border-radius: 50%;
  color: var(--ask-accent, inherit);
  font-size: 10px;
  font-weight: 700;
}

.ask-title {
  font-weight: 600;
}

.ask-step {
  opacity: 0.75;
  font-size: 11px;
}

.ask-question {
  font-weight: 600;
}

.ask-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ask-option {
  display: flex;
  align-items: baseline;
  gap: 6px;
  text-align: left;
  padding: 3px 8px;
  border: 1px solid var(--ask-line, var(--line));
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.ask-option:hover:not(:disabled) {
  border-color: var(--ask-accent, currentColor);
}

/* 推荐的描边强调色 */
.ask-option.recommended {
  border-color: var(--ask-accent, currentColor);
}

.ask-option.picked {
  background: var(--ask-picked, rgba(127, 127, 127, 0.18));
  border-color: var(--ask-accent, currentColor);
}

.ask-option:disabled {
  opacity: 0.6;
  cursor: default;
}

.ask-mark {
  flex: none;
  color: var(--ask-accent, inherit);
}

.ask-label {
  flex: none;
  font-weight: 600;
}

.ask-rec {
  flex: none;
  font-size: 10px;
  color: var(--ask-accent, inherit);
  border: 1px solid var(--ask-accent, currentColor);
  border-radius: 4px;
  padding: 0 4px;
  opacity: 0.9;
}

.ask-detail {
  min-width: 0;
  opacity: 0.75;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ask-own input {
  width: 100%;
  box-sizing: border-box;
  padding: 3px 8px;
  border: 1px solid var(--ask-line, var(--line));
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11.5px;
}

.ask-own input:focus {
  outline: none;
  border-color: var(--ask-accent, currentColor);
}

.ask-own input::placeholder {
  color: inherit;
  opacity: 0.55;
}

.ask-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.ask-btn {
  border: 1px solid var(--ask-line, var(--line));
  background: transparent;
  color: inherit;
  font-size: 11px;
  padding: 1px 9px;
  border-radius: 5px;
  cursor: pointer;
}

.ask-btn:hover {
  border-color: var(--ask-accent, currentColor);
}

.ask-btn.primary {
  border-color: var(--ask-accent, currentColor);
  color: var(--ask-accent, inherit);
  font-weight: 600;
}

.ask-done {
  font-size: 11px;
  opacity: 0.8;
}
</style>
