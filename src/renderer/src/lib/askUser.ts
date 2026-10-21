// ask_user（智能体问用户，qt/docs/ASK.md v2.13）的客户端纯逻辑：
// 工具参数 JSON → 问题列表（宽松解析，对齐服务端 AskUser::parse），界面上点出的选择 → 回答（runner.resolveApproval 的 answer）。
// activity / 快照（PendingApproval.questions）里已经是解析好的形状（recommended 0 起）；这里只管 ToolEvent.arguments 原文。
import type { AskOption, AskQuestion } from '../../../protocol/rpc/protocol.js'

/** 一次最多几题、每题几个选项（和服务端一致） */
export const MAX_QUESTIONS = 3
export const MAX_OPTIONS = 4

/** 用户的回答（AskUser::Answer）：answers 每题一条（选的选项名，多选「、」连起来；自己写的原样；空 = 这题没选）；
 *  reply 是没点选项、直接回的一句话（输入框里打的字交给 runner.submit，不走这里）。全空 = 跳过，服务端按推荐的做 */
export interface AskAnswer {
  answers: string[]
  reply?: string
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** 一题：没写题面的丢掉；选项认 {label|text, detail|description} 和纯字符串；recommended 认 1 起的序号
 *  （写成 0 的当 0 起）、选项上的 recommended:true；每题最多 4 个选项（多的截掉）——与服务端逐条对齐 */
function parseQuestion(raw: Record<string, unknown>): AskQuestion | null {
  const question = text(raw.question)
  if (!question) return null
  const multiple = raw.multiple === true || raw.multiple === 'true'
  const options: AskOption[] = []
  let recommended = -1
  for (const item of Array.isArray(raw.options) ? raw.options : []) {
    let option: AskOption | null = null
    if (typeof item === 'string') {
      option = item.trim() ? { label: item.trim() } : null
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const object = item as Record<string, unknown>
      const label = text(object.label) || text(object.text)
      if (label) {
        option = { label }
        const detail = text(object.detail) || text(object.description)
        if (detail) option.detail = detail
        if (object.recommended === true && recommended < 0) recommended = options.length
      }
    }
    if (option) options.push(option)
    if (options.length === MAX_OPTIONS) break
  }
  const value = raw.recommended
  let index = -1
  if (typeof value === 'number' && Number.isFinite(value)) index = Math.trunc(value)
  else if (typeof value === 'string' && value.trim()) index = Number.parseInt(value.trim(), 10)
  if (index >= 1 && index <= options.length) recommended = index - 1
  else if (index === 0 && recommended < 0 && options.length > 0) recommended = 0
  if (recommended >= options.length) recommended = -1
  const ask: AskQuestion = { question, options }
  if (multiple) ask.multiple = true
  if (recommended >= 0) ask.recommended = recommended
  return ask
}

/** ask_user 参数原文 → 问题列表：{questions:[…]} 也认只有一题的简写 {question, options, …}；
 *  没写题面的题丢掉；最多 3 题。解析不出（不是 JSON / 没有题）返回空数组，调用方当普通审批处理 */
export function parseAskQuestions(argsJson: string): AskQuestion[] {
  let object: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(argsJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    object = parsed as Record<string, unknown>
  } catch {
    return []
  }
  const raws: unknown[] = Array.isArray(object.questions) ? object.questions : 'question' in object ? [object] : []
  const questions: AskQuestion[] = []
  for (const raw of raws) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const ask = parseQuestion(raw as Record<string, unknown>)
    if (ask) questions.push(ask)
    if (questions.length === MAX_QUESTIONS) break
  }
  return questions
}

/** 界面上的选择 → 协议的回答：picked 每题点了的选项名（多选多个）、own 每题自己写的字；
 *  点过选项的题以选项为准（多选「、」连起来），都没动那题为空（= 没选）。全空 = 跳过 */
export function buildAskAnswer(picked: string[][], own: string[]): AskAnswer {
  const length = Math.max(picked.length, own.length)
  const answers: string[] = []
  for (let i = 0; i < length; i += 1) {
    const labels = (picked[i] ?? []).filter(Boolean)
    answers.push(labels.length ? labels.join('、') : (own[i] ?? '').trim())
  }
  return { answers }
}
