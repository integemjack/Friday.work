// 模型上下文窗口的估算与格式化（选中会话背景条的「上下文 长度 · 占比」用）。
// 服务端的 stats 只给上下文 token 数（contextTokenCount），占比的分母（窗口大小）协议里没有——
// 按模型名认常见家族的窗口：认得出的给占比，认不出的只显示长度（宁缺勿错，不给误导性的百分比）。
// 引擎里 model 是自由文本（带 / 前缀、大小写不一），一律小写子串匹配，靠前的规则先命中；
// 数值是 2026-10 核对各官方文档的常见值，新模型出了记得回来补。

/** 一条「模型名子串 → 窗口 tokens」规则（顺序即优先级：具体的写前面） */
const RULES: Array<{ match: RegExp; tokens: number; note: string }> = [
  // 智谱 GLM：4.6 / 4.7 / 5 系 200K（官方：三款共享 200K 窗口 / 128K 输出），4.5 及更早 128K
  { match: /glm-4\.[6-9]|glm-[5-9]/, tokens: 200_000, note: 'GLM 4.6+' },
  { match: /glm/, tokens: 128_000, note: 'GLM 4.5-' },
  // DeepSeek V3.x / R 系：128K
  { match: /deepseek/, tokens: 128_000, note: 'DeepSeek' },
  // 月之暗面 Kimi K2 系：256K
  { match: /kimi|moonshot/, tokens: 256_000, note: 'Kimi' },
  // 通义：qwen3-max 256K；开源 Qwen3 系 256K（YaRN 拉到 1M 的不算）；qwen-max 32K；plus/turbo/2.5 系 128K
  { match: /qwen3-max|qwen3\.5/, tokens: 256_000, note: 'Qwen3-Max' },
  { match: /qwen3/, tokens: 262_144, note: 'Qwen3' },
  { match: /qwen-max/, tokens: 32_768, note: 'Qwen-Max' },
  { match: /qwen/, tokens: 131_072, note: 'Qwen' },
  // Anthropic Claude 3.5/3.7/4 系：200K
  { match: /claude/, tokens: 200_000, note: 'Claude' },
  // OpenAI：GPT-5 400K；4.1 1M；4o/4-turbo 128K；o 系推理模型 200K；其余 gpt 兜底 128K
  { match: /gpt-5/, tokens: 400_000, note: 'GPT-5' },
  { match: /gpt-4\.1/, tokens: 1_000_000, note: 'GPT-4.1' },
  { match: /gpt-4o|gpt-4-turbo|chatgpt/, tokens: 128_000, note: 'GPT-4o' },
  { match: /\bo[134]\b/, tokens: 200_000, note: 'o 系' },
  { match: /gpt/, tokens: 128_000, note: 'GPT' },
  // Google Gemini 2.x 系：1M
  { match: /gemini/, tokens: 1_000_000, note: 'Gemini' },
  // 字节豆包 1.5/Seed 系：256K
  { match: /doubao/, tokens: 256_000, note: 'Doubao' },
  // MiniMax M2：204.8K
  { match: /minimax/, tokens: 204_800, note: 'MiniMax' },
  // xAI：grok-4 256K，更早 128K
  { match: /grok-4/, tokens: 256_000, note: 'Grok-4' },
  { match: /grok/, tokens: 131_072, note: 'Grok' },
  // 开源系兜底：Llama 128K、Mistral 128K
  { match: /llama/, tokens: 128_000, note: 'Llama' },
  { match: /mistral|mixtral/, tokens: 128_000, note: 'Mistral' }
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
