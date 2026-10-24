// 模型上下文窗口的估算与格式化（选中会话背景条的「上下文 长度 · 占比」用）。
// 服务端的 stats 只给上下文 token 数（contextTokenCount），占比的分母（窗口大小）协议里没有——
// 按模型名认常见家族的窗口：认得出的给占比，认不出的只显示长度（宁缺勿错，不给误导性的百分比）。
// 引擎里 model 是自由文本（带 / 前缀、大小写不一），一律小写子串匹配，靠前的规则先命中；
// 数值 2026-10-24 逐家核过官方文档，覆盖本机 Friday 设置（engines.json / serviceSeenModels）里
// 实际出现的家族；新一代旗舰普遍 1M（GLM 5.2+/DeepSeek V4/Qwen3.5+Max/MiniMax M3/Kimi K3/Claude 5），
// 新模型出了记得回来补。主要来源：docs.bigmodel.cn、DeepSeek 官方 model-list、platform.claude.com、
// platform.kimi.com、minimax.io、火山引擎、Qwen 官方、llm-stats（GPT-5.2）、xAI（Grok-4）。

import type { ChatMessage, MessageBlock, ToolEvent } from '../../../protocol/rpc/protocol.js'
import { blockPayload } from '../../../protocol/rpc/protocol.js'

/** 一条「模型名子串 → 窗口 tokens」规则（顺序即优先级：具体的写前面） */
const RULES: Array<{ match: RegExp; tokens: number; note: string }> = [
  // 智谱 GLM：5.2 起官方 1M（5.2/5.3 文档「真正可用的 1M 上下文」）；4.6~5.1 200K；4.5 及更早 128K
  { match: /glm[-_.]?5\.[2-9]/, tokens: 1_048_576, note: 'GLM 5.2+' },
  { match: /glm-4\.[6-9]|glm[-_.]?5/, tokens: 200_000, note: 'GLM 4.6~5.1' },
  { match: /glm/, tokens: 128_000, note: 'GLM 4.5-' },
  // DeepSeek：V4 系（v4/v4.1 flash/pro）官方 1M；V3.x/chat/r1 128K
  { match: /deepseek[-_.\/]?v4/, tokens: 1_048_576, note: 'DeepSeek V4' },
  { match: /deepseek/, tokens: 128_000, note: 'DeepSeek V3' },
  // 月之暗面 Kimi：K3/K3.1 官方 100 万；K2 系（k2.6/k2.7-code）256K
  { match: /kimi[-_.]?k?3/, tokens: 1_048_576, note: 'Kimi K3' },
  { match: /kimi|moonshot/, tokens: 262_144, note: 'Kimi K2' },
  // 通义 Qwen：3.5+ 的 Max 官方 1M（3.8-Max「1M 保持不变」）；Qwen3 系原生 262144（3.5+ 非 Max 保守按 256K）；2.5 系/plus/turbo 128K
  { match: /qwen3\.[5-9][^/]*max/, tokens: 1_048_576, note: 'Qwen3.x-Max' },
  { match: /qwen3/, tokens: 262_144, note: 'Qwen3' },
  { match: /qwen/, tokens: 131_072, note: 'Qwen' },
  // Anthropic：5 系（fable-5/opus-5/sonnet-5/haiku-5）官方 100 万；3.5/4 系 200K
  { match: /claude[-_](fable|(opus|sonnet|haiku)[-_.]?[5-9])/, tokens: 1_048_576, note: 'Claude 5' },
  { match: /claude/, tokens: 200_000, note: 'Claude 4' },
  // OpenAI：gpt-5 系官方 400K（5.2 已核）；4.1 一度 1M；4o/4-turbo/gpt-oss 128K；o1/o3/o4 200K；其余 gpt 兜底 128K
  { match: /gpt-5/, tokens: 400_000, note: 'GPT-5' },
  { match: /gpt-4\.1/, tokens: 1_048_576, note: 'GPT-4.1' },
  { match: /gpt-4o|gpt-4-turbo|gpt-oss/, tokens: 131_072, note: 'GPT-4o/oss' },
  { match: /(^|\/)o[134]([-:.]|$)/, tokens: 200_000, note: 'OpenAI o 系' },
  { match: /gpt/, tokens: 131_072, note: 'GPT' },
  // Google：1.5 一代 2M；2.x/3.x 官方 1M
  { match: /gemini[-_.]?1\.5/, tokens: 2_097_152, note: 'Gemini 1.5' },
  { match: /gemini/, tokens: 1_048_576, note: 'Gemini' },
  // 字节：Seed-Evolving 官方 1M；Seed 2.x / Doubao 系 256K（火山引擎官方）
  { match: /seed[-_.]?evolving/, tokens: 1_048_576, note: 'Seed-Evolving' },
  { match: /seed|doubao/, tokens: 262_144, note: 'Doubao/Seed' },
  // MiniMax：M3 官方 1M；M2 系 204.8K
  { match: /minimax[-_.]?m3/, tokens: 1_048_576, note: 'MiniMax M3' },
  { match: /minimax/, tokens: 204_800, note: 'MiniMax M2' },
  // xAI：grok-4 官方 256K；grok-3 131K
  { match: /grok[-_.]?[4-9]/, tokens: 262_144, note: 'Grok-4' },
  { match: /grok/, tokens: 131_072, note: 'Grok' },
  // 百度 ERNIE 4.5：128K
  { match: /ernie/, tokens: 131_072, note: 'ERNIE' },
  // 开源系兜底：llama-3 128K（llama2 4K）；codestral 256K；mistral 128K。
  // 混元 hy3/hy4 没核到官方口径 → 不给占比（只显长度），核到再补
  { match: /llama[-_.]?2/, tokens: 4_096, note: 'Llama 2' },
  { match: /llama/, tokens: 131_072, note: 'Llama 3' },
  { match: /codestral/, tokens: 262_144, note: 'Codestral' },
  { match: /mistral|mixtral/, tokens: 131_072, note: 'Mistral' }
]

/** 认模型窗口：名字里先命中谁就是谁；认不出返回 undefined（界面只显示长度不给占比） */
export function contextWindowTokens(model: string | undefined): number | undefined {
  const name = (model ?? '').toLowerCase()
  if (!name) return undefined
  for (const rule of RULES) {
    if (rule.match.test(name)) return rule.tokens
  }
  return undefined
}

/** 窗口是哪家/多大（悬停提示用：「GLM 4.6+ · 约 200k」）；认不出返回 undefined */
export function contextWindowNote(model: string | undefined): { note: string; tokens: number } | undefined {
  const name = (model ?? '').toLowerCase()
  if (!name) return undefined
  for (const rule of RULES) {
    if (rule.match.test(name)) return { note: rule.note, tokens: rule.tokens }
  }
  return undefined
}

/** token 数的人话格式：842 → 842、84200 → 84.2k、128000 → 128k、1048576 → 1M */
export function formatTokenCount(n: number): string {
  const trim = (value: number): string => String(Number(value.toFixed(1)))
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `${trim(n / 1_000)}k`
  return String(n)
}

/** 占比（%取整）；估算分母下超 100 也照实显示（模型上下文比估的窗口还大时该被看见） */
export function contextPercent(tokens: number, windowTokens: number): number {
  return Math.round((tokens / windowTokens) * 100)
}

// ---- 上下文构成：各个工具（及文本 / 思考）各占了多少，按块内容估算 ----
// 服务端没有按工具的 token 数据（ToolEvent.usage 只有子 Agent / 模型调用才有），
// 只能客户端估：CJK 字符 ≈1 token、其它 ≈4 字符/token（各家的粗近似，算占比够用，
// 绝对值会偏小——系统提示 / 缓存不计入，悬停不了就在文案里写明「按内容估算」）。

/** 文本 → 估算 token 数（中文 1:1，其它 4 字符/token） */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    // CJK 统一表意 / 扩展 / 平仮名片仮名 / 谚文
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) cjk += 1
  }
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/** 构成的一段：key 是 'tool:工具名' / 'text' / 'thinking'；tokens 是估算值 */
export interface ContextMixSegment {
  key: string
  tokens: number
}

/** 一条消息里各块的构成（工具块含 arguments + result + 子 Agent 运行记录，递归） */
export function messageMix(message: ChatMessage): ContextMixSegment[] {
  const out: ContextMixSegment[] = []
  const walk = (blocks: MessageBlock[] | undefined): void => {
    if (!blocks) return
    for (const block of blocks) {
      const kind = Object.keys(block.kind)[0] ?? ''
      if (kind === 'text' || kind === 'thinking') {
        out.push({ key: kind, tokens: estimateTokens(blockPayload<string>(block, kind)) })
      } else if (kind === 'tool') {
        const tool = blockPayload<ToolEvent>(block, 'tool')
        if (tool) {
          // 子 Agent 的运行记录（transcript，含其文本/思考/工具）也是这个工具带进上下文的：全部并入它名下
          let nested = 0
          if (tool.transcript) {
            for (const seg of messageMix({ ...message, blocks: tool.transcript })) nested += seg.tokens
          }
          out.push({
            key: `tool:${tool.name || 'tool'}`,
            tokens: estimateTokens(tool.arguments) + estimateTokens(tool.result) + nested
          })
        }
      }
      // media 块不计：图片按张固定计费各家不一，估不准不如不估，文案里写明「按文本估算」
    }
  }
  walk(message.blocks)
  return out
}

/** 带版本缓存的单条构成（流式补丁高频来，未变的消息不重算）。
 *  WeakMap 以消息对象为键：原地 patch 的对象 version 变了重算；整条替换是新对象、自然 miss 重算，
 *  不会像按 id 的全局 Map 那样在不同会话间串（id 只是服务端给的 UUID，测试里更容易撞） */
const mixCache = new WeakMap<ChatMessage, { version: number; segments: ContextMixSegment[] }>()

export function messageMixCached(message: ChatMessage, version: number): ContextMixSegment[] {
  const hit = mixCache.get(message)
  if (hit && hit.version === version) return hit.segments
  const segments = messageMix(message)
  mixCache.set(message, { version, segments })
  return segments
}

/** 整段会话（当前分支）的构成：同 key 求和、按 tokens 降序 */
export function contextMixOf(messages: Array<{ message: ChatMessage; version: number }>): ContextMixSegment[] {
  const sum = new Map<string, number>()
  for (const entry of messages) {
    for (const seg of messageMixCached(entry.message, entry.version)) {
      sum.set(seg.key, (sum.get(seg.key) ?? 0) + seg.tokens)
    }
  }
  return [...sum.entries()].map(([key, tokens]) => ({ key, tokens })).sort((a, b) => b.tokens - a.tokens)
}
