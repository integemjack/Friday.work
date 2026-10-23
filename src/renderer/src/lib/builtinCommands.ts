// 内置命令 /model、/mode、/thinking（照 Friday v2.71 docs/COMMANDS.md §8；== Qt core/agent/BuiltinCommands + ModelMenuBuilder 的
// builtinCommands / commandChoices / parseCommand / resolveCommand）。
// 输入框打「/」时菜单里总有这三项（来源「内置」）——这台一个命令文件都没有时菜单也照样弹；打「/model 」「/mode 」「/thinking 」后
// 菜单换成能选的模型、任务模式、思考档位，选中（或发出「/命令 名字」）就换这段对话的、同时记成新对话的默认，不发给模型。
// 这里只管认参数、列、认是哪个（纯函数，测试直接调）；真正去换的是 Composer。
import type { CommandInfo, ThinkingLevel } from '../../../protocol/rpc/protocol.js'

export type BuiltinName = 'model' | 'mode' | 'thinking'
export type BuiltinActionKind = 'setEngine' | 'setTeamMode' | 'setThinking'
export interface BuiltinAction {
  kind: BuiltinActionKind
  value: string
}

/** 菜单里「/model 」后面列的一行（== Qt commandChoices 的 choice：title、detail、trailing、checked、action） */
export interface BuiltinChoice {
  title: string
  detail?: string
  trailing?: string
  checked: boolean
  action: BuiltinAction
}

/** 能选的模型：只要名字、服务（EngineView 的子集，测试好造） */
export interface BuiltinEngine {
  id: string
  title: string
  model: string
}

const NAMES: BuiltinName[] = ['model', 'mode', 'thinking']

const HINTS: Record<BuiltinName, string> = {
  model: '[模型]',
  mode: '[不派 | 需要时派 | 极限]',
  thinking: '[关 | 低 | 中 | 高]'
}

const DETAILS: Record<BuiltinName, string> = {
  model: '换主智能体用的模型，同时设成新对话的默认',
  mode: '换任务模式（派不派子智能体、极限性能），同时设成新对话的默认',
  thinking: '换思考模式（深度思考的档位），同时设成新对话的默认'
}

/** 菜单里的三项（名字、参数提示、用途，来源「内置」） */
export function builtinCommandItems(): CommandInfo[] {
  return NAMES.map((name) => ({ name, argumentHint: HINTS[name], description: DETAILS[name], sourceTitle: '内置' }))
}

/** 「/名字 参数」：是哪个内置命令、参数（去掉首尾空白；只打「/名字」是空串）；不是（换了行的也不算）为 null */
export function parseBuiltin(text: string): { command: BuiltinName; argument: string } | null {
  if (!text.startsWith('/') || /[\r\n]/.test(text)) return null
  for (const name of NAMES) {
    if (!text.slice(1).startsWith(name)) continue
    const rest = text.slice(name.length + 1)
    if (rest.length > 0 && !/^\s/.test(rest)) continue
    return { command: name, argument: rest.trim() }
  }
  return null
}

/** 「/」后面打到 prefix 时的整张菜单：内置的排在对得上的命令最前面，名字里有的排最后；同名的命令文件不列（内置的优先） */
export function mergeBuiltinCommands(prefix: string, commands: CommandInfo[]): CommandInfo[] {
  const wanted = prefix.toLowerCase()
  const builtins = builtinCommandItems()
  const names = new Set(builtins.map((item) => item.name))
  return [
    ...builtins.filter((item) => item.name.startsWith(wanted)),
    ...commands.filter((item) => !names.has(item.name)),
    ...builtins.filter((item) => !item.name.startsWith(wanted) && item.name.includes(wanted))
  ]
}

// MARK: 任务模式

export interface TeamModeInfo {
  raw: string
  title: string
  detail: string
}

/** 模型菜单里列的三项（不派的标题带「（默认）」） */
export const TEAM_MODES: TeamModeInfo[] = [
  { raw: 'solo', title: '不派子智能体（默认）', detail: '主智能体自己做' },
  { raw: 'delegatesHeavy', title: '需要时派子智能体', detail: '主智能体自己做，活大、多步、能并行时派子智能体' },
  { raw: 'ultra', title: '极限性能', detail: '最贵也最全面：思考开到最高，子智能体还能再往下派、分多层做' }
]

/** 2.11 以前的 delegatesOnly / delegatesWhenNeeded 按 delegatesHeavy 算（== AgentTeamMode::normalized） */
export function normalizeTeamMode(raw: string | undefined): string | undefined {
  if (raw === 'delegatesOnly' || raw === 'delegatesWhenNeeded') return 'delegatesHeavy'
  return raw
}

function teamModeName(mode: TeamModeInfo): string {
  return mode.title.replace('（默认）', '')
}

/** 「/mode 名字」认哪个（原始值）：第几个、原始值、简称；不然标题里有它的只有一个时就是它 */
export function resolveTeamMode(argument: string): string | null {
  const trimmed = argument.trim()
  const wanted = trimmed.toLowerCase()
  if (!wanted) return null
  const number = /^\d+$/.test(wanted) ? Number(wanted) : NaN
  if (number >= 1 && number <= TEAM_MODES.length) return TEAM_MODES[number - 1]!.raw
  const aliases = [
    ['solo', '不派', '不派子智能体', '自己做', '默认'],
    ['delegatesheavy', 'heavy', 'delegate', 'delegates', '派', '需要时派', '需要时派子智能体', '需要'],
    ['ultra', '极限', '极限性能', '最强']
  ]
  const index = aliases.findIndex((list) => list.includes(wanted))
  if (index >= 0) return TEAM_MODES[index]!.raw
  const partial = TEAM_MODES.filter((mode) => teamModeName(mode).toLowerCase().includes(wanted))
  return partial.length === 1 ? partial[0]!.raw : null
}

// MARK: 思考模式

const LEVEL_TITLES: Record<ThinkingLevel, string> = { off: '关闭', low: '低', medium: '中', high: '高', ultra: '超级模式' }

/** 这一档写什么：只有开 / 关两档时写「开启 / 关闭」（同模型菜单） */
export function thinkingTitle(level: ThinkingLevel, levels: ThinkingLevel[]): string {
  if (levels.length === 2) return level === 'off' ? '关闭' : '开启'
  return LEVEL_TITLES[level] ?? level
}

/** 现在实际用的档位：不在能调的里面时，开着的算最高一档、关着的算关（== Qt effective） */
export function effectiveThinking(current: ThinkingLevel | undefined, levels: ThinkingLevel[]): ThinkingLevel | undefined {
  if (!current) return undefined
  if (levels.includes(current)) return current
  return current !== 'off' && levels.length > 0 ? levels[levels.length - 1] : 'off'
}

/** 「/thinking 档位」认哪个（只在这个模型能调的档位里）：第几个、原始值、标题（关 / 低 / 中 / 高、开启 / 关闭） */
export function resolveThinking(argument: string, levels: ThinkingLevel[]): ThinkingLevel | null {
  const trimmed = argument.trim()
  const wanted = trimmed.toLowerCase()
  if (!wanted) return null
  const number = /^\d+$/.test(wanted) ? Number(wanted) : NaN
  if (number >= 1 && number <= levels.length) return levels[number - 1]!
  if (['关', '关闭', 'off', '不思考', 'no'].includes(wanted)) return levels.includes('off') ? 'off' : null
  if (['开', '开启', 'on', '思考', 'yes'].includes(wanted)) return levels.find((level) => level !== 'off') ?? null
  return (
    levels.find(
      (level) =>
        level === wanted ||
        LEVEL_TITLES[level] === trimmed ||
        thinkingTitle(level, levels) === trimmed ||
        LEVEL_TITLES[level]?.slice(0, 1) === trimmed
    ) ?? null
  )
}

// MARK: 模型

const NON_CHAT_ANYWHERE = [
  'embed', 'rerank', 'retriever', 'guard', 'safety', 'reward', 'moderation', 'whisper', 'deplot', 'detector', 'calibration',
  'cogview', 'cogvideo', 'dall-e', 'stable-diffusion', 'seedream', 'seedance', 'kolors', 'nvclip', 'realtime', 'cosyvoice',
  'sambert', 'paraformer', 'sensevoice', 'transcribe'
]
const NON_CHAT_WHOLE = new Set(['tts', 'asr', 'image', 'video', 'clip', 'parse', 'sora', 'flux', 'sdxl', 'wanx'])

/** 能对话的模型（== Qt ModelTraits::isChatModel）：名字最后一段（去掉 :free 这类后缀）里有画图、语音、向量这些词的不是；
 *  tts、image 这类单独成段才算（sparse 里的 parse 不算） */
export function isChatModel(model: string): boolean {
  const name = (model.toLowerCase().split('/').pop() ?? '').split(':')[0]!.trim()
  if (!name) return true
  if (NON_CHAT_ANYWHERE.some((word) => name.includes(word))) return false
  return !name.split(/[-_. ]+/).some((word) => word && (NON_CHAT_WHOLE.has(word) || /^wan\d/.test(word)))
}

/** 「/model 名字」认哪个：第几个（从 1 起）；id、模型名、名字（「名字 · 模型」也认）一样的；不然名字、模型里有它的只有一个时就是它 */
export function resolveModel<T extends BuiltinEngine>(argument: string, pool: T[]): T | null {
  const wanted = argument.trim()
  if (!wanted) return null
  const number = /^\d+$/.test(wanted) ? Number(wanted) : NaN
  if (number >= 1 && number <= pool.length) return pool[number - 1]!
  const lower = wanted.toLowerCase()
  const same = (text: string) => text.toLowerCase() === lower
  const exact = pool.find(
    (engine) => same(engine.id) || same(engine.model) || same(engine.title) || same(`${engine.title} · ${engine.model}`)
  )
  if (exact) return exact
  const partial = pool.filter(
    (engine) => engine.model.toLowerCase().includes(lower) || engine.title.toLowerCase().includes(lower)
  )
  return partial.length === 1 ? partial[0]! : null
}

// MARK: 列能选的、认是哪个

/** 这段对话现在的状态（列的时候打勾、思考档位只在这个模型能调的里面） */
export interface BuiltinContext {
  /** 开着的引擎（这里再挑能对话的） */
  engines: BuiltinEngine[]
  engineID?: string
  teamMode?: string
  thinkingLevel?: ThinkingLevel
  thinkingLevels: ThinkingLevel[]
}

/** 「/model 」「/mode 」「/thinking 」后面列能选的（filter 是后面打的）：开头对上的在前，有它的在后 */
export function builtinChoices(command: BuiltinName, filter: string, context: BuiltinContext): BuiltinChoice[] {
  const wanted = filter.trim().toLowerCase()
  const matches = (names: string[]) => !wanted || names.some((name) => name.toLowerCase().includes(wanted))
  const starts: BuiltinChoice[] = []
  const contains: BuiltinChoice[] = []
  if (command === 'model') {
    for (const engine of context.engines.filter((item) => isChatModel(item.model))) {
      const names = [engine.model, engine.title].map((name) => name.toLowerCase())
      const row: BuiltinChoice = {
        title: engine.model || engine.title,
        trailing: engine.model && engine.title !== engine.model ? engine.title : undefined,
        checked: engine.id === context.engineID,
        action: { kind: 'setEngine', value: engine.id }
      }
      if (!wanted || names.some((name) => name.startsWith(wanted))) starts.push(row)
      else if (names.some((name) => name.includes(wanted))) contains.push(row)
    }
  } else if (command === 'mode') {
    const current = normalizeTeamMode(context.teamMode)
    for (const mode of TEAM_MODES) {
      if (matches([mode.title, mode.raw]))
        starts.push({
          title: mode.title,
          detail: mode.detail,
          trailing: '任务模式',
          checked: mode.raw === current,
          action: { kind: 'setTeamMode', value: mode.raw }
        })
    }
  } else {
    // 极限性能时思考固定开到最高（同模型菜单里思考模式变灰）
    if (normalizeTeamMode(context.teamMode) === 'ultra') return []
    const levels = context.thinkingLevels
    const effective = effectiveThinking(context.thinkingLevel, levels)
    for (const level of levels) {
      const title = thinkingTitle(level, levels)
      if (matches([title, level]))
        starts.push({
          title,
          trailing: '思考模式',
          checked: level === effective,
          action: { kind: 'setThinking', value: level }
        })
    }
  }
  return [...starts, ...contains]
}

/** 发出去的「/命令 参数」换成哪个；认不出（或参数空）为 null */
export function resolveBuiltin(command: BuiltinName, argument: string, context: BuiltinContext): BuiltinAction | null {
  if (!argument.trim()) return null
  if (command === 'model') {
    const engine = resolveModel(argument, context.engines.filter((item) => isChatModel(item.model)))
    return engine ? { kind: 'setEngine', value: engine.id } : null
  }
  if (command === 'mode') {
    const mode = resolveTeamMode(argument)
    return mode ? { kind: 'setTeamMode', value: mode } : null
  }
  if (normalizeTeamMode(context.teamMode) === 'ultra') return null
  const level = resolveThinking(argument, context.thinkingLevels)
  return level ? { kind: 'setThinking', value: level } : null
}
