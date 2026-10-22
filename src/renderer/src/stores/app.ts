// 渲染进程的应用状态：机器列表 + 当前会话的完整视图（M1）。
// 会话状态由协议事件维护：conversation（快照）/ message（整条）/ message.patch（增量，打不上拉整条）/ runtime。

import { defineStore } from 'pinia'
import { host, rpc } from '../lib/host.js'
import { isMediaTool, mediaArgSource } from '../lib/mediaTools.js'
import { castLimitH } from '../lib/cast.js'
import {
  deleteStackCaches,
  ensureStackMediaCached,
  initStackCache,
  stackCacheName,
  stackCacheUrl
} from '../lib/stackMediaCache.js'
import { applyMessagePatch } from '../../../protocol/rpc/MessagePatcher.js'
import { conversationPath, type BranchInfo } from '../../../protocol/rpc/ConversationPath.js'
import { parseAskQuestions } from '../lib/askUser.js'
import {
  canQueryUsage,
  usageKey,
  type UsageEntry,
  type UsageResult,
  type UsageTarget
} from '../lib/serviceUsage.js'
import {
  blockCase,
  blockPayload,
  type ActivityEventParams,
  type AskQuestion,
  type AssistantEntry,
  type AssistantState,
  type AssistantSubscribeResult,
  type BlocksPatch,
  type BrowserFrameParams,
  type BrowserTab,
  type ChatMessage,
  type CommandInfo,
  type CommandsListResult,
  type Conversation,
  type ConversationSummary,
  type DirectoriesState,
  type PendingApproval,
  type RunnerState,
  type Runtime,
  type SessionActivity,
  type TeamRun,
  type TerminalInfo,
  type ToolEvent
} from '../../../protocol/rpc/protocol.js'
import type { MachineStateInfo } from '../../../shared/api.js'
import type { UpdateState } from '../../../shared/update.js'

export interface MessageWithVersion {
  message: Conversation['nodes'][number]
  version: number
}

export interface EngineView {
  id: string
  title: string
  model: string
  kind?: string
  /** 接口地址（余额 / 套餐用量按「接口地址 + 密钥名」认；REMOTE.md §6「在线服务」） */
  baseURL?: string
  /** 密钥库里的名字（只有名字，没有值） */
  apiKeySecret?: string
  supportsTools?: boolean
  subAgentAllowed?: boolean
  disabled?: boolean
}

/** fs.list 的回执（REMOTE.md §6「文件」：选工作目录用，只列子目录；不给 path 是主目录） */
export interface FsListResult {
  path: string
  parent?: string
  entries: Array<{ name: string; path: string }>
  roots?: Array<{ name: string; path: string }>
  truncated?: boolean
}

/** 1:1 通话状态（协议进程 CallService 的结构；渲染层只读） */
export interface CallView {
  phase: 'idle' | 'incoming' | 'outgoing' | 'connecting' | 'active' | 'ended'
  peerID: number
  peerName: string
  requestId: string
  callType: 'audio' | 'video'
  /** 来电 */
  incoming: boolean
  startedAt: number
  ringingAt: number
  acceptedAt: number
  connectedAt: number
  endedAt: number
  endedReason: string
  endedCode: string
  muted: boolean
  durationSec: number
}

export interface ConversationDetail {
  conversationID: string
  /** 消息按当前选中的分支展开的显示顺序 */
  messages: MessageWithVersion[]
  /** 全部节点（分支没选中的也在，切换分支时用） */
  nodes: ChatMessage[]
  /** 每个父节点选中的孩子（REMOTE.md §5：selectedChildren） */
  selectedChildren: Record<string, string>
  runtime: Runtime | null
  versions: Record<string, number>
}

/**
 * 桌面投窗（2026-10 布局改版）：会话不再是浮动窗口——
 * 思考/文本以「气泡」投在桌面随机处（5 秒渐隐），操作以「极简终端卡」投在桌面（结果后 5 秒渐隐）；
 * 用到终端/浏览器/文件时对应面板直接展开。
 */
export interface DesktopBubble {
  id: string
  conversationID: string
  kind: 'thinking' | 'text'
  text: string
  x: number
  y: number
  /** 活动置顶层级：由置顶 tick（castTick）每 5 秒抬「当前最活跃」的投出物 */
  z: number
  /** 最近一次内容更新/出现的时刻：「最活跃」= activeAt 最新（最近还在更新的） */
  activeAt: number
  fading: boolean
  timer: number
}

export interface DesktopOp {
  /** 工具事件 id（消息块里）或审批 eventID（activity） */
  id: string
  conversationID: string
  title: string
  content: string
  result: string
  status: 'running' | 'awaitingApproval' | 'succeeded' | 'failed' | 'denied'
  /** ask_user 在等问题：有值时审批行换成问题面板（选项点选，lib/askUser.ts） */
  questions?: AskQuestion[]
  /** 工具名（看图 analyze_image / 看视频 analyze_video）：这些卡把媒体直接嵌在卡里展示 */
  toolName?: string
  x: number
  y: number
  /** 活动置顶层级：由置顶 tick 每 5 秒抬「当前最活跃」的投出物（与气泡共用计数器） */
  z: number
  /** 最近一次内容更新/出现的时刻：「最活跃」= activeAt 最新 */
  activeAt: number
  fading: boolean
  timer: number
}

/** 桌面媒体叠里的一条：看图/看视频成功后归档的媒体（图片一叠、视频一叠，压在桌面最底层） */
export interface StackMediaItem {
  /** 去重键：会话:类型:媒体源（流式补丁重walk历史块不会重复归档） */
  id: string
  /** 相对路径按哪段会话的工作目录解析（拉媒体时用） */
  conversationID: string
  kind: 'image' | 'video'
  /** 工具参数里的原始媒体源（http(s)/data URL 或本地路径）
   *  重启恢复的条目源会换成 friday-media:// 本地缓存地址（当时的原始源可能已随会话清理） */
  src: string
  /** 归档时刻（叠的封面取最新一张） */
  at: number
  /** 本地缓存文件名（归档时下载完成才有；清空一叠时按它删盘上的文件） */
  cache?: string
}

export type WindowKind =
  | 'terminals'
  | 'files'
  | 'browser'
  | 'agents'
  | 'settings'

export interface DesktopWindow {
  id: string
  kind: WindowKind
  title: string
  icon: string
  x: number
  y: number
  w: number
  h: number
  minimized: boolean
  maximized: boolean
  z: number
  /** 最大化前的几何 */
  restore?: { x: number; y: number; w: number; h: number }
}

/** 每类窗口的默认大小（只剩子 Agent / 设置两个浮动窗口，其余内容常驻桌面） */
const WINDOW_SIZE: Record<WindowKind, { w: number; h: number; minW: number; minH: number }> = {
  terminals: { w: 820, h: 500, minW: 420, minH: 260 },
  files: { w: 640, h: 540, minW: 360, minH: 300 },
  browser: { w: 820, h: 620, minW: 420, minH: 320 },
  agents: { w: 580, h: 460, minW: 360, minH: 240 },
  settings: { w: 620, h: 560, minW: 420, minH: 320 }
}

/** 置顶节流：两次抬 z 的最小间隔，全局一个窗口（castZAt）。窗口到期时由 castTick 抬
 *  「当前最活跃」（activeAt 最大）的投出物——不按气泡各自计时（窗口重叠交错依然争抢），
 *  也不是到期后碰巧先来更新的那个先抬 */
const CAST_Z_INTERVAL = 5000

/** 置顶 tick 的 interval id（非响应式，模块级） */
let castTimer = -1

/** 浏览器帧合屏（非响应式，模块级）：最新一帧 + 是否已排了上屏回调（见 applyEvent 的 browser.frame） */
let pendingBrowserFrame: { tab: string; data: string; viewport: [number, number] } | null = null
let browserFrameFlushScheduled = false

const WINDOW_TITLE: Record<WindowKind, { title: string; icon: string }> = {
  terminals: { title: '终端', icon: '⌨' },
  files: { title: '文件', icon: '🗂' },
  browser: { title: '浏览器', icon: '🌐' },
  agents: { title: '子 Agent', icon: '◈' },
  settings: { title: '设置', icon: '⚙' }
}

/** 操作卡是否已到终态（终态才计时渐隐） */
function terminalStatus(status: DesktopOp['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'denied'
}

// MARK: 窗口布局持久化（方案 §2「本地只留：…UI 偏好」；存 localStorage，重启恢复）

interface SavedWindow {
  kind: WindowKind
  title: string
  icon: string
  x: number
  y: number
  w: number
  h: number
  minimized: boolean
  maximized: boolean
  z: number
  restore?: { x: number; y: number; w: number; h: number }
}

const LAYOUT_KEY = 'friday.work.layout.v1'
const LAYOUT_WINDOW_LIMIT = 20
/** 媒体叠持久化上限：叠太多时只留最新的这些（再老的远端文件多半也已清理，本地缓存文件留着、由清空按钮连坐删） */
const STACK_MEDIA_LIMIT = 300

/** localStorage 里存的那份布局（restoreLayout 读，saveLayout 写） */
interface SavedLayout {
  nextZ?: number
  cascade?: number
  windows?: SavedWindow[]
  /** 媒体叠（没清空的重启后自动加载回来；2026-10 媒体叠本地缓存） */
  stackMedia?: SavedStackItem[]
}

/** 媒体叠里一条的持久化形式（StackMediaItem 的可 JSON 化子集） */
interface SavedStackItem {
  id: string
  conversationID: string
  kind: 'image' | 'video'
  src: string
  at: number
  cache?: string
}

/** 把当前桌面布局写进 localStorage（App.vue 订阅状态、防抖后调；恢复在 store.restoreLayout）。
 *  媒体叠一起存：没清空的重启后自动加载回来（src 换成 friday-media:// 本地缓存地址，
 *  当时的原始源可能已随会话结束被清理） */
export function saveLayout(store: {
  windows: DesktopWindow[]
  currentMachine: string
  nextZ: number
  cascade: number
  stackMedia: StackMediaItem[]
}): void {
  try {
    // 同类窗口只存一份（会话按 conversationID 区分）：不去重的话，历史存档里攒下的
    // 重复窗口会挤占 LAYOUT_WINDOW_LIMIT，把会话窗口挤出存档、重启后丢失
    const windows: SavedWindow[] = []
    const seen = new Set<string>()
    for (const item of store.windows) {
      const key = item.kind
      if (seen.has(key)) continue
      seen.add(key)
      windows.push({
        kind: item.kind,
        title: item.title,
        icon: item.icon,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        minimized: item.minimized,
        maximized: item.maximized,
        z: item.z,
        restore: item.restore
      })
      if (windows.length >= LAYOUT_WINDOW_LIMIT) break
    }
    // 媒体叠：只存最新 STACK_MEDIA_LIMIT 条；data: URL 的源可能好几 MB，不能整条塞 localStorage——
    // 缓存文件在就只存 friday-media:// 缓存地址（文件在本地，照样能加载）
    const stackMedia: SavedStackItem[] = store.stackMedia.slice(-STACK_MEDIA_LIMIT).map((item) => {
      const cache = item.cache ?? stackCacheName(item.conversationID, item.kind, item.src)
      if (/^data:/i.test(item.src)) {
        const cachedSrc = stackCacheUrl(cache)
        return { id: `${item.conversationID}:${item.kind}:${cachedSrc}`, conversationID: item.conversationID, kind: item.kind, src: cachedSrc, at: item.at, cache }
      }
      return { id: item.id, conversationID: item.conversationID, kind: item.kind, src: item.src, at: item.at, cache }
    })
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ nextZ: store.nextZ, cascade: store.cascade, windows, stackMedia })
    )
  } catch {
    // 存不下就算了（隐私模式 / 超配额）
  }
}

// 已订阅 activity 的机器（避免重复订阅）。
// 放模块级：放进 state 会被布局持久化订阅连带序列化，放进 actions 又会被 Pinia 包装成函数（Set 的方法全没了，
// 之前就是这么写的，导致 activity.subscribe 整段崩、遥测面板/会话恢复不工作）。
const activitySubscribed = new Set<string>()

// 已订阅助手日志的机器（同上，模块级）。开着「和助手说」才订，退出/切机器就退（REMOTE.md §6「助手」）。
const assistantSubscribed = new Set<string>()

// 订了 config 的机器（服务端只把 serviceUsage 事件推给订着 config.subscribe 的客户端；模型选择器显示着才订，收起退订）。
// 模块级，原因同上（放进 state 会被布局持久化序列化）。
const usageSubscribed = new Set<string>()

// 订不上 config 的机器（旧服务端没有这一组方法）：不再反复试，只能手动查一次
const usageUnsupported = new Set<string>()

export const useAppStore = defineStore('app', {
  state: () => ({
    machines: [] as MachineStateInfo[],
    currentMachine: '',
    /** 当前机器的会话列表（summaries，hello 时给、summaries 事件更新） */
    summaries: [] as ConversationSummary[],
    /** 每段打开的会话的完整视图（多窗口并存：每段会话一个窗口） */
    details: {} as Record<string, ConversationDetail>,
    /** 一段会话的分支信息：消息 id → 同父几个孩子、当前第几个 */
    branchInfo: {} as Record<string, Record<string, BranchInfo>>,
    /** 当前活动会话（会话列表选中项；右下聊天面板作用在它上面） */
    activeConversationID: '',
    /** 和助手说：聊天面板不在会话上、改在所连机器的助手日志上（assistant.say / assistant.entry）。
     *  输入台旁「和助手说」键进入；选中/新建任何会话自动退出 */
    assistantChat: false,
    /** 助手状态（assistant.subscribe 的 state） */
    assistantState: null as AssistantState | null,
    /** 助手日志（订阅快照 + assistant.entry 流式合并，时间序） */
    assistantEntries: [] as AssistantEntry[],
    /** 这台机器的 Friday 不带助手（老版本，assistant.* 不通） */
    assistantUnsupported: false,
    /** 桌面上打开的窗口（只剩子 Agent / 设置，其余内容常驻桌面） */
    windows: [] as DesktopWindow[],
    /** 下一个窗口的层叠高度 */
    nextZ: 10,
    /** 窗口级联计数（新窗口错开摆放） */
    cascade: 0,
    /** 正在连一台机器（work 通道） */
    connectingWork: false,
    /** SChat 通道（M1.5 扫码一键连） */
    schat: {
      phase: 'idle' as 'idle' | 'logging-in' | 'online' | 'error',
      server: 'https://47.100.98.3:2012',
      userId: 0,
      deviceName: '',
      restoring: false,
      qrPayload: '',
      qrExpiresAt: 0,
      status: '',
      bots: [] as Array<{ id: number; name: string; botCalls: boolean }>,
      /** 1:1 通话状态（协议进程维护） */
      call: {
        phase: 'idle',
        peerID: 0,
        peerName: '',
        requestId: '',
        callType: 'audio',
        incoming: false,
        startedAt: 0,
        ringingAt: 0,
        acceptedAt: 0,
        connectedAt: 0,
        endedAt: 0,
        endedReason: '',
        endedCode: '',
        muted: false,
        durationSec: 0
      } as CallView,
      messages: {} as Record<
        number,
        Array<{
          id: number
          senderId: number
          to: number
          content: string
          streaming: boolean
          at: number
          mine?: boolean
          failed?: string
          clientMsgId?: string
        }>
      >,
      error: ''
    },
    /** 启动后是否已尝试自动连接存着的机器 */
    autoConnectDone: false,
    /** 已进入工作台（连过机器/静默恢复过）：登录页不再自动盖在桌面上 */
    workbenchReady: false,
    /** 登录页正在显示（LoginView 挂/卸时维护）：机器广播不再自动把它收起来，由登录页连上后自己收 */
    loginActive: false,
    /** 手动打开的登录页（换账号/重新扫码时盖在桌面上） */
    loginOverlay: false,
    /** 信令队列（state）：通话窗口从里面取（带序号，取过就不重复） */
    callSignals: [] as Array<{ seq: number; signal: unknown }>,
    callSignalSeq: 0,
    callSignalCount: 0,
    /** 当前机器全部会话的待确认调用（activity 订阅，REMOTE.md §6） */
    approvals: {} as Record<string, PendingApproval[]>,
    /** 已在这边交了回答/跳过的 ask_user（eventID）：面板冻结在「已交」，等 approval 事件把它收走 */
    answeredAsks: new Set<string>(),
    /** 在置顶提问浮层里点了「稍后再说」的 ask_user（eventID）：新问题来了再弹，旧的不再弹 */
    dismissedAsks: new Set<string>(),
    /** 当前机器全部会话的实时动静（会话列表状态点、桌面投窗的数据源，REMOTE.md §6「会话的实时动静」） */
    activities: {} as Record<string, SessionActivity>,
    /** 桌面投窗：思考/文本气泡（随流式更新，5 秒无新内容渐隐） */
    bubbles: [] as DesktopBubble[],
    /** 桌面投窗：操作极简终端卡（结果后 5 秒渐隐） */
    opCards: [] as DesktopOp[],
    /** 流式标记：messageID → 块ID → 该块已投过气泡的文本长度（增量从这里算；按块记，多段思考/回复各自成泡） */
    streamMarks: {} as Record<string, Record<string, number>>,
    /** 气泡全文记忆：id（会话:类型:块）→ 最后全文。气泡 5 秒渐隐后会从数组删除，
     *  流式一断再续时只能重建气泡——没有这份记忆新气泡就只剩尾巴那截（显示不全） */
    castTexts: {} as Record<string, string>,
    /** 投出物置顶层级：气泡与操作卡共用，有新活动的递增抬到最前（同一投层里跨气泡/卡可比） */
    castZTop: 10,
    /** 全局置顶节流：上次抬 z 的时刻（整个投层一个窗口；castTick 每秒检查，到期抬最活跃的） */
    castZAt: 0,
    /** 已渐隐移除的操作卡 id：流式补丁会重walk整条消息的历史块，不拦住就会把终态卡再弹一遍（同一操作反复显示的根源） */
    fadedOps: new Set<string>(),
    /** 桌面媒体叠：看图/看视频成功后归档的媒体（图片一叠、视频一叠，压在桌面最底层） */
    stackMedia: [] as StackMediaItem[],
    /** 正在灯箱里放大查看的媒体（null = 灯箱关着） */
    zoomMedia: null as StackMediaItem | null,
    /** M2 实时卡片：当前机器的终端 / 浏览器 / 子 Agent 状态 */
    terminals: [] as TerminalInfo[],
    terminalsAvailable: false,
    terminalsReason: '',
    /** Agent 在这段会话里自动弹开过终端窗口的会话（run_in_terminal 开新终端 / 用终端的工具）：
     *  会话做完（finished）把终端窗口收起（最小化，标签和终端都留着，随时点开复查）；
     *  用户自己手动开的终端窗口不记，不收 */
    autoTerminals: new Set<string>(),
    browserTabs: [] as BrowserTab[],
    browserAvailable: false,
    browserReason: '',
    teamRuns: [] as TeamRun[],
    /** 当前机器的运行状态（runner 事件 + hello 快照；标题栏右上角实时指示用） */
    runnerState: null as RunnerState | null,
    /** 活动的浏览器帧（base64 jpeg）与它的视口 */
    browserFrame: null as { tab: string; data: string; viewport: [number, number] } | null,
    /** 智能体 handOver 指名的标签（BrowserCard 认领后清掉，见 clearBrowserFocus） */
    browserFocusTab: '',
    /** 这台机器的引擎（hello 快照 + engines 事件；输入框的模型选择器用） */
    engines: [] as EngineView[],
    /** 各家在线服务的余额 / 套餐用量（services.usage 查 + serviceUsage 事件推；
     *  键 = usageKey(接口地址, 密钥名)，和事件里的 observedKey 同一套写法） */
    serviceUsage: {} as Record<string, UsageEntry>,
    /** 模型选择器显示着（要服务端推 serviceUsage，边框要一直跟着）：显示时订 config.subscribe，收起退订 */
    usageWanted: false,
    /** 新对话默认引擎（liveState；输入框的模型选择器在未选过时显示它） */
    defaultEngineID: '',
    /** 当前机器最近选择的工作目录（hello 快照 + directories 事件；输入框的目录选择器用）。
     *  null = 旧服务端没有 directories：菜单里不列最近、选了也不记（REMOTE.md §5 DirectoriesState） */
    recentDirectories: null as Array<{ path: string; exists: boolean }> | null,
    /** 这台的「/」命令（commands.list；输入框的命令菜单用）。null = 还没拉到或旧服务端没有
     *  feature commands：菜单不弹（REMOTE.md §6 命令）；记下是哪台机器按哪个目录拉的，换了作废重拉 */
    commands: null as { machineID: string; directory: string; items: CommandInfo[] } | null,
    /** 终端面板里选中的终端 id */
    activeTerminalID: '',
    /** 文件面板里选中的文件（null = 只开目录树） */
    activeFile: null as null | { path: string; name: string },
    /** 全局提示（错误横幅） */
    error: '',
    /** 客户端更新状态（主进程 ClientUpdate 推送；设置窗口 + 桌面浮层展示） */
    update: {
      phase: 'idle',
      currentVersion: '',
      currentCommit: '',
      platform: '',
      version: '',
      commit: '',
      builtAt: '',
      progress: 0,
      auto: false,
      restartAt: 0,
      note: '',
      error: ''
    } as UpdateState
  }),

  getters: {
    currentMachineInfo(state): MachineStateInfo | undefined {
      return state.machines.find((machine) => machine.id === state.currentMachine)
    },

    /** 待答的 ask_user（跨全部会话）：屏幕中间的置顶提问浮层（AskOverlay）就弹这些；
     *  交了回答/跳过/点了稍后的不算（answeredAsks / dismissedAsks） */
    pendingAsks(state): Array<{ conversationID: string; conversationTitle: string; approval: PendingApproval }> {
      const list: Array<{ conversationID: string; conversationTitle: string; approval: PendingApproval }> = []
      for (const [conversationID, approvals] of Object.entries(state.approvals)) {
        for (const approval of approvals) {
          if (!approval.questions?.length) continue
          if (state.answeredAsks.has(approval.eventID) || state.dismissedAsks.has(approval.eventID)) continue
          list.push({
            conversationID,
            conversationTitle: state.summaries.find((item) => item.id === conversationID)?.title ?? '会话',
            approval
          })
        }
      }
      return list
    },
    connected(): boolean {
      return this.currentMachineInfo?.state === 'ready'
    },
    /** 正在通话（来电/呼出/接通中/通话中）：右栏顶部让出 1/3 给通话面板、聊天缩到 2/3；空闲时聊天占满整栏 */
    calling(state): boolean {
      const phase = state.schat.call.phase
      return phase === 'incoming' || phase === 'outgoing' || phase === 'connecting' || phase === 'active'
    },
    /** 当前机器对应的助手 bot（work:<botID>）；取不到时退回第一个 bot——自动拨号和聊天头部的手动拨打都用它 */
    assistantBotID(): number {
      const target = String(this.currentMachineInfo?.targetText ?? '')
      const matched = /^work:(\d+)$/.exec(target)
      if (matched) return Number(matched[1])
      return this.schat.bots[0]?.id ?? 0
    },
    runtime(state): Runtime | null {
      return state.details[state.activeConversationID]?.runtime ?? null
    },
    /** 活动会话的完整视图 */
    detail(state): ConversationDetail | null {
      return state.details[state.activeConversationID] ?? null
    },
    /** 当前机器的待确认总数 */
    pendingApprovalCount(state): number {
      return Object.values(state.approvals ?? {}).reduce((sum, list) => sum + (list?.length ?? 0), 0)
    },
    /** 当前会话的待确认调用（审批横幅用） */
    currentApprovals(state): PendingApproval[] {
      const id = state.activeConversationID
      return id ? (state.approvals[id] ?? []) : []
    },
    /** 可见窗口（按层叠顺序：小的先画） */
    visibleWindows(state): DesktopWindow[] {
      return state.windows.filter((item) => !item.minimized).slice().sort((a, b) => a.z - b.z)
    },
    /** 全部窗口（按层叠顺序）；最小化的也渲染，只用 v-show 隐藏 —— 终端等实例不能重建 */
    allWindows(state): DesktopWindow[] {
      return state.windows.slice().sort((a, b) => a.z - b.z)
    }
  },

  actions: {
    // MARK: 桌面窗口

    /** 开一个窗口（同类型已在就置顶）；终端/文件/浏览器都是会话用到时才开的正常窗口，无常驻面板 */
    openWindow(kind: WindowKind, options: { title?: string } = {}): string {
      const existing = this.windows.find((item) => item.kind === kind)
      if (existing) {
        if (options.title) existing.title = options.title
        existing.minimized = false
        this.focusWindow(existing.id)
        return existing.id
      }

      const size = WINDOW_SIZE[kind]
      const desktopWidth = window.innerWidth
      const desktopHeight = window.innerHeight - 44 - 42
      const offset = (this.cascade++ % 7) * 28
      const w = Math.min(size.w, Math.max(size.minW, desktopWidth - 60))
      const h = Math.min(size.h, Math.max(size.minH, desktopHeight - 40))
      const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const item: DesktopWindow = {
        id,
        kind,
        title: options.title ?? WINDOW_TITLE[kind].title,
        icon: WINDOW_TITLE[kind].icon,
        x: Math.max(8, Math.min(96 + offset, Math.max(8, desktopWidth - w - 8))),
        y: Math.max(8, Math.min(36 + offset, Math.max(8, desktopHeight - h - 8))),
        w,
        h,
        minimized: false,
        maximized: false,
        z: ++this.nextZ
      }
      this.windows.push(item)
      return id
    },

    closeWindow(id: string) {
      const index = this.windows.findIndex((item) => item.id === id)
      if (index < 0) return
      this.windows.splice(index, 1)
      // 浏览器窗口关掉时 BrowserCard 卸载，它自己会 unwatch
    },

    focusWindow(id: string) {
      const item = this.windows.find((entry) => entry.id === id)
      if (!item) return
      item.z = ++this.nextZ
      if (item.minimized) item.minimized = false
    },

    minimizeWindow(id: string) {
      const item = this.windows.find((entry) => entry.id === id)
      if (item) item.minimized = true
    },

    toggleMaximizeWindow(id: string) {
      const item = this.windows.find((entry) => entry.id === id)
      if (!item) return
      if (item.maximized) {
        if (item.restore) Object.assign(item, item.restore)
        item.maximized = false
        item.restore = undefined
      } else {
        item.restore = { x: item.x, y: item.y, w: item.w, h: item.h }
        item.maximized = true
      }
      item.z = ++this.nextZ
    },

    moveWindow(id: string, rect: { x: number; y: number; w: number; h: number }) {
      const item = this.windows.find((entry) => entry.id === id)
      if (!item) return
      item.x = rect.x
      item.y = rect.y
    },

    resizeWindow(id: string, rect: { x: number; y: number; w: number; h: number }) {
      const item = this.windows.find((entry) => entry.id === id)
      if (!item) return
      Object.assign(item, rect)
    },

    /** 任务栏：最小化/还原 */
    toggleTaskbar(id: string) {
      const item = this.windows.find((entry) => entry.id === id)
      if (!item) return
      if (item.minimized) {
        this.focusWindow(id)
      } else if (item.z === Math.max(...this.windows.map((entry) => entry.z))) {
        item.minimized = true
      } else {
        this.focusWindow(id)
      }
    },

    /** 关掉某类窗口（切机器时用） */
    closeWindowsOfKind(kind: WindowKind) {
      for (const item of this.windows.filter((entry) => entry.kind === kind)) {
        this.closeWindow(item.id)
      }
    },

    // MARK: 布局恢复（saveLayout 的另一半；App.vue 启动时调）

    /** 启动时恢复上次的窗口布局（只剩子 Agent / 设置两类浮动窗口；旧存档里的其他类型直接丢弃）。
     *  媒体叠一起恢复：没清空的重启后自动加载回来；本地缓存注册表也在这里回填 */
    restoreLayout(): boolean {
      // 缓存注册表先回填（消息内嵌媒体/叠/灯箱都看它决定走本地还是在线；拿到前先按在线路径走，回填后自动切）
      void initStackCache()
      let saved: SavedLayout | null = null
      try {
        saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as SavedLayout | null
      } catch {
        return false
      }
      this.restoreStackMedia(saved)
      const items = saved?.windows
      if (!Array.isArray(items) || items.length === 0) return false
      const desktopWidth = window.innerWidth
      const desktopHeight = window.innerHeight
      const seen = new Set<string>()
      for (const item of items) {
        if (!WINDOW_SIZE[item.kind]) continue // 旧存档里已移除的类型直接丢
        if (seen.has(item.kind)) continue
        seen.add(item.kind)
        // 幂等：恢复只往空桌面加窗口，桌上已有的同类不再叠一份。
        // 不然 HMR 重挂载 App.vue → onMounted 重跑 restoreLayout 重入，每重入一次多叠一个
        if (this.windows.some((entry) => entry.kind === item.kind)) continue
        const limits = WINDOW_SIZE[item.kind]!
        const w = Math.min(Math.max(item.w, limits.minW), Math.max(limits.minW, desktopWidth - 16))
        const h = Math.min(Math.max(item.h, limits.minH), Math.max(limits.minH, desktopHeight - 100))
        this.windows.push({
          id: `${item.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          kind: item.kind,
          title: item.title || WINDOW_TITLE[item.kind].title,
          icon: item.icon || WINDOW_TITLE[item.kind].icon,
          x: Math.max(-w + 120, Math.min(item.x, Math.max(8, desktopWidth - 120))),
          y: Math.max(0, Math.min(item.y, Math.max(8, desktopHeight - 90))),
          w,
          h,
          minimized: item.minimized,
          maximized: item.maximized,
          z: ++this.nextZ,
          restore: item.restore
        })
      }
      this.nextZ = Math.max(this.nextZ, Number(saved?.nextZ) || 0)
      this.cascade = Math.max(this.cascade, Number(saved?.cascade) || 0)
      return this.windows.length > 0
    },

    /** 媒体叠恢复（saveLayout 存的那份）：幂等，重启/HMR 重入只往空叠里加，不重复 */
    restoreStackMedia(saved: SavedLayout | null) {
      const items = saved?.stackMedia
      if (!Array.isArray(items)) return
      for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue
        if (typeof raw.id !== 'string' || !raw.id) continue
        if (raw.kind !== 'image' && raw.kind !== 'video') continue
        if (typeof raw.src !== 'string' || !raw.src) continue
        if (this.stackMedia.some((item) => item.id === raw.id)) continue
        this.stackMedia.push({
          id: raw.id,
          conversationID: typeof raw.conversationID === 'string' ? raw.conversationID : '',
          kind: raw.kind,
          src: raw.src,
          at: Number(raw.at) > 0 ? Number(raw.at) : Date.now(),
          cache: typeof raw.cache === 'string' && raw.cache ? raw.cache : undefined
        })
      }
    },

    bindHost() {
      // 协议进程可能比渲染进程先连上 SChat（静默恢复）：补拉一次状态，别等下一次变化
      void this.schatRefresh().catch(() => {})
      host.onMachines((info) => {
        this.machines = info.machines
        // 存着机器就算进了工作台，登录页退下去；但登录页自己在场时不行——
        // 它刚添加的机器还在连接中，要等它连上（ready）自己收（否则连接失败会把用户撂在半开的工作台上）
        if (info.machines.length > 0 && !this.loginActive) this.workbenchReady = true
        if (!this.currentMachine && info.machines.length > 0) {
          this.currentMachine = info.current || info.machines[0]!.id
        }
        // 启动后把所有存着的机器都连上（多机器后台常连，方案 §10 M4）
        if (!this.autoConnectDone && info.machines.length > 0) {
          this.autoConnectDone = true
          const ordered = [...info.machines].sort((a, b) =>
            a.id === this.currentMachine ? -1 : b.id === this.currentMachine ? 1 : 0
          )
          for (const machine of ordered) {
            if (machine.state === 'disconnected' || machine.state === 'failed') {
              void this.connectMachine(machine.id)
            }
          }
        }
        // 连上的机器订阅 activity（审批、动静总览的数据源）；刚连上的取一次实时卡片状态
        for (const machine of info.machines) {
          // 模型选择器显示着：服务端只把 serviceUsage 事件推给订着 config 的客户端——重连 / 切机器后补订一次，
          // 从别处回来时补查一遍数（订阅是按连接的，断了就没了）
          if (
            machine.state === 'ready' &&
            machine.id === this.currentMachine &&
            this.usageWanted &&
            !usageSubscribed.has(machine.id) &&
            !usageUnsupported.has(machine.id)
          ) {
            void this.ensureUsageSubscription().then(() => {
              if (usageSubscribed.has(machine.id)) void this.refreshServiceUsage(true)
            })
          }
          if (machine.state === 'ready' && !activitySubscribed.has(machine.id)) {
            activitySubscribed.add(machine.id)
            this.rpc(machine.id, 'activity.subscribe', {})
              .then((result) => {
                const sessions = (result as { sessions: SessionActivity[] }).sessions ?? []
                for (const session of sessions) {
                  this.activities[session.id] = session
                  this.approvals[session.id] = session.approvals ?? []
                }
                // 跑着/等审批的会话自动订阅（气泡/操作卡的数据源）：不订阅就只有手动选中会话才有流——
                // 客户端晚于会话启动（或重连）时错过 started 事件，桌面上气泡就全不显示
                if (machine.id === this.currentMachine) {
                  for (const session of sessions) {
                    if (session.status === 'running' || session.status === 'approval') {
                      void this.subscribeConversation(session.id)
                    }
                  }
                }
              })
              .catch(() => activitySubscribed.delete(machine.id))
            if (machine.id === this.currentMachine) {
              void this.refreshLiveState()
              void this.refreshSummaries()
              // 重连时「和助手说」还开着：重新订阅拿全量（断线时订阅已清）
              if (this.assistantChat) void this.openAssistantChat()
            }
          } else if (machine.state !== 'ready') {
            // 掉线：等重连后重新订阅
            activitySubscribed.delete(machine.id)
            assistantSubscribed.delete(machine.id)
            usageSubscribed.delete(machine.id)
            usageUnsupported.delete(machine.id)
            if (machine.id === this.currentMachine) {
              this.assistantState = null
              this.assistantEntries = []
            }
          }
        }
      })
      host.onEvent((event) => {
        if (event.type !== 'event' || event.machineID !== this.currentMachine) return
        this.applyEvent(event.method, event.params)
      })
      host.onSchat((state) => {
        const previous = this.schat.call.phase
        this.schat = state as typeof this.schat
        // 来电：右下角挂件自动出现（看 phase 即可），再补一条系统通知
        if (this.schat.call.phase === 'incoming' && previous !== 'incoming') {
          window.fridayBridge?.notify({
            title: '来电',
            body: `${this.schat.call.peerName} 打来电话`
          })
        }
      })
      host.onCallSignal((signal) => {
        this.callSignalCount += 1
        this.callSignals.push({ seq: this.callSignalCount, signal })
      })
      // 客户端更新（主进程 ClientUpdate）：先拉一次当前状态，之后由主进程推送
      window.fridayBridge
        ?.updateState()
        .then((state) => {
          this.update = state
        })
        .catch(() => {})
      window.fridayBridge?.onUpdateState((state) => {
        this.update = state
      })
    },

    /** 协议方法（透传） */
    rpc(machineID: string, method: string, params?: unknown): Promise<unknown> {
      return rpc(machineID, method, params)
    },

    // MARK: 机器

    async removeMachine(id: string) {
      await host.request({ type: 'machines.remove', id })
      if (this.currentMachine === id) {
        await this.closeAssistantChat()
        this.currentMachine = ''
        this.summaries = []
        this.details = {}
        this.activeConversationID = ''
      }
    },

    async selectMachine(id: string) {
      if (this.currentMachine === id) return
      await this.leaveConversation()
      await this.closeAssistantChat()
      // 用量订阅是按连接的：旧机器退掉（新机器由机器状态那一轮重新订，见 bindHost）
      if (usageSubscribed.has(this.currentMachine)) {
        usageSubscribed.delete(this.currentMachine)
        rpc(this.currentMachine, 'config.unsubscribe', {}).catch(() => {})
      }
      usageUnsupported.delete(this.currentMachine)
      this.currentMachine = id
      this.summaries = []
      this.details = {}
      this.activeConversationID = ''
      this.resetLiveState()
      const info = this.machines.find((machine) => machine.id === id)
      if (info?.state === 'ready') {
        await this.refreshSummaries()
        await this.refreshLiveState()
      }
    },

    // MARK: M2 实时卡片

    /** 终端标签从「有」变成「一个都不剩」：终端窗口跟着关掉——空窗口里只剩一句提示，留着没意义。
     *  只在真的清空过的那一下关（hadTerminals 是赋值前的状态）：用户自己点开窗口、还没按 ＋ 的时候
     *  列表本来就是空的，不能一开就被关掉。 */
    closeTerminalWindowIfEmpty(hadTerminals: boolean) {
      if (!hadTerminals || this.terminals.length > 0) return
      const win = this.windows.find((item) => item.kind === 'terminals')
      if (win) this.closeWindow(win.id)
    },

    resetLiveState() {
      const hadTerminals = this.terminals.length > 0
      this.terminals = []
      this.terminalsAvailable = false
      this.terminalsReason = ''
      this.autoTerminals.clear()
      this.browserTabs = []
      this.browserAvailable = false
      this.browserReason = ''
      this.teamRuns = []
      this.runnerState = null
      this.recentDirectories = null
      this.serviceUsage = {}
      this.commands = null
      this.browserFrame = null
      this.activeTerminalID = ''
      this.activeFile = null
      this.activities = {}
      this.approvals = {}
      this.assistantState = null
      this.assistantEntries = []
      this.assistantUnsupported = false
      this.closeTerminalWindowIfEmpty(hadTerminals)
    },

    /** 取当前机器的终端/浏览器/子 Agent 状态（hello 快照 + 事件维护，切换/重连后调） */
    async refreshLiveState() {
      if (!this.currentMachine) return
      try {
        const state = (await host.request({ type: 'state.get', machineID: this.currentMachine })) as {
          terminals: { terminals: TerminalInfo[]; available: boolean; reason?: string }
          browser: { tabs: BrowserTab[]; available: boolean; reason?: string }
          team: { runs: TeamRun[] }
          runner?: RunnerState
          engines?: EngineView[]
          defaultEngineID?: string
          directories?: DirectoriesState
        }
        this.engines = state.engines ?? []
        this.defaultEngineID = state.defaultEngineID ?? ''
        this.recentDirectories = state.directories?.recent ?? null
        const hadTerminals = this.terminals.length > 0
        this.terminals = state.terminals?.terminals ?? []
        this.terminalsAvailable = state.terminals?.available ?? false
        this.terminalsReason = state.terminals?.reason ?? ''
        this.browserTabs = state.browser?.tabs ?? []
        this.browserAvailable = state.browser?.available ?? false
        this.browserReason = state.browser?.reason ?? ''
        this.teamRuns = state.team?.runs ?? []
        this.runnerState = state.runner ?? null
        // 同上：换机器 / 重连后拿到的快照里已经没有它了，就别当活动终端留着
        if (this.activeTerminalID && !this.terminals.some((terminal) => terminal.id === this.activeTerminalID)) {
          this.activeTerminalID = ''
        }
        if (!this.activeTerminalID && this.terminals.length > 0) {
          this.activeTerminalID = this.terminals[0]!.id
        }
        this.closeTerminalWindowIfEmpty(hadTerminals)
      } catch {
        // 没连上时忽略
      }
    },

    /** handOver 指名的标签被 BrowserCard 认领后清掉 */
    clearBrowserFocus() {
      this.browserFocusTab = ''
    },

    async connectMachine(id: string) {
      await host.request({ type: 'machines.connect', id })
    },

    async disconnectMachine(id: string) {
      await host.request({ type: 'machines.disconnect', id })
    },

    // MARK: 会话列表与订阅

    async refreshSummaries() {
      if (!this.currentMachine) return
      try {
        const result = (await host.request({ type: 'summaries.get', machineID: this.currentMachine })) as {
          summaries: ConversationSummary[]
        }
        this.summaries = result.summaries ?? []
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      }
    },

    /** 打开一段会话：订阅拿整段并设为活动会话（右下聊天面板切到它）。不再开浮动窗口。
     *  从「和助手说」切回会话：自动退出助手模式（聊天面板跟着回会话）。 */
    async openConversation(conversationID: string) {
      if (this.assistantChat) await this.closeAssistantChat()
      await this.subscribeConversation(conversationID)
      this.activeConversationID = conversationID
    },

    /** 订阅一段会话（不改活动会话）：新会话开跑时自动订阅，气泡/操作卡才能收到流式内容 */
    async subscribeConversation(conversationID: string) {
      if (!this.currentMachine || this.details[conversationID]) return
      // 订阅上限：超过就先丢掉最早一段非活动的（退订、清状态）
      const ids = Object.keys(this.details)
      if (ids.length >= 10) {
        const oldest = ids.find((id) => id !== this.activeConversationID)
        if (oldest) await this.closeConversation(oldest)
      }
      try {
        const payload = (await host.request({
          type: 'conversations.subscribe',
          machineID: this.currentMachine,
          conversationID
        })) as { conversation?: Conversation; runtime?: Runtime; versions?: Record<string, number> }
        if (!payload.conversation) throw new Error('订阅回复里没有会话')
        const conversation = payload.conversation
        const messages: MessageWithVersion[] = conversation.nodes.map((message) => ({
          message,
          version: payload.versions?.[message.id] ?? 0
        }))
        this.details[conversationID] = {
          conversationID,
          messages,
          nodes: [...conversation.nodes],
          selectedChildren: { ...(conversation.selectedChildren ?? {}) },
          runtime: payload.runtime ?? null,
          versions: { ...(payload.versions ?? {}) }
        }
        this.rebuildPath(this.details[conversationID]!)
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      }
    },

    /** 关掉一段会话（会话列表 ✕ 或订阅上限淘汰时调）：退订、清状态、清投窗 */
    async closeConversation(conversationID: string) {
      if (this.currentMachine) {
        await host
          .request({ type: 'conversations.unsubscribe', machineID: this.currentMachine, conversationID })
          .catch(() => {})
      }
      // 清这段会话的流式标记（按 messageID 记的，删会话前先收走它的消息 id）
      const removed = new Set((this.details[conversationID]?.nodes ?? []).map((node) => node.id))
      for (const messageID of Object.keys(this.streamMarks)) {
        if (removed.has(messageID)) delete this.streamMarks[messageID]
      }
      delete this.details[conversationID]
      this.bubbles = this.bubbles.filter((item) => item.conversationID !== conversationID)
      this.opCards = this.opCards.filter((item) => item.conversationID !== conversationID)
      if (this.activeConversationID === conversationID) {
        this.activeConversationID = ''
      }
    },

    async leaveConversation() {
      for (const conversationID of Object.keys(this.details)) {
        await this.closeConversation(conversationID)
      }
    },

    /** 新建会话并打开。注意：服务端会规范化 id（转大写存储），必须用回执里的 id，后续事件的 id 都以它为准。
     *  options：新建时直接带上工作目录 / 引擎（REMOTE.md conversation.create 支持），不用建完再改一遍。
     *  返回新会话 id（没连上/出错时 undefined） */
    async createConversation(options?: { workingDirectory?: string; engineID?: string }): Promise<string | undefined> {
      if (!this.currentMachine) return
      try {
        const id = crypto.randomUUID()
        const result = (await rpc(this.currentMachine, 'conversation.create', {
          id,
          ...(options?.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
          ...(options?.engineID ? { engineID: options.engineID } : {})
        })) as { id: string }
        const canonicalID = result.id ?? id
        if (options?.workingDirectory) {
          // 记进这台机器的最近目录（旧服务端不认，静默忽略）
          rpc(this.currentMachine, 'directories.push', { path: options.workingDirectory }).catch(() => {})
        }
        await this.openConversation(canonicalID)
        await this.refreshSummaries()
        return canonicalID
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        return undefined
      }
    },

    // MARK: 事件（REMOTE.md §5）

    applyEvent(method: string, params: unknown) {
      switch (method) {
        case 'summaries':
          this.summaries = (params as { summaries: ConversationSummary[] }).summaries
          break
        case 'conversation':
          this.applyConversationSnapshot(params)
          break
        case 'message':
          this.applyWholeMessage(params)
          break
        case 'message.patch':
          this.applyPatch(params)
          break
        case 'assistant.entry': {
          // 助手日志加了/改了一条（流式同一条合在一起推；REMOTE.md §5）：只往开着「和助手说」的面板里并
          if (this.assistantChat) {
            const entry = (params as { entry?: AssistantEntry }).entry
            if (entry) this.mergeAssistantEntry(entry)
          }
          break
        }
        case 'assistant.reset': {
          // 日志/记忆清空或搬来新的一份：重新订阅拿全量
          if (this.assistantChat) {
            if (this.currentMachine) assistantSubscribed.delete(this.currentMachine)
            void this.openAssistantChat()
          }
          break
        }
        case 'runtime': {
          // runtime 事件的 params 是 {conversationID, runtime}（REMOTE.md §5）
          const payload = params as { conversationID?: string; runtime?: Runtime }
          const detail = payload.conversationID ? this.details[payload.conversationID] : undefined
          if (detail && payload.runtime) detail.runtime = payload.runtime
          break
        }
        case 'attention': {
          // 有调用等着确认：系统通知（点通知回到那段会话）
          const payload = params as { conversationID?: string; title?: string } | undefined
          window.fridayBridge?.notify({
            title: 'Friday：有调用等你确认',
            body: payload?.title ?? '在一段会话里，智能体等你批准一个操作',
            conversationID: payload?.conversationID
          })
          break
        }
        case 'activity': {
          // 增量事件：按 kind 合并进 SessionActivity（REMOTE.md §6）
          const evt = params as ActivityEventParams
          const previous = this.activities[evt.conversationID]
          const at = evt.at ?? new Date().toISOString()
          const base: SessionActivity = previous ?? {
            id: evt.conversationID,
            title: evt.title ?? '',
            status: 'idle',
            approvals: [],
            updatedAt: at
          }
          const next: SessionActivity = { ...base, updatedAt: at }
          if (evt.title) next.title = evt.title
          if (evt.workingDirectory) next.workingDirectory = evt.workingDirectory
          switch (evt.kind) {
            case 'started': {
              // 新会话开跑：自动订阅（不在详情里时），气泡/操作卡才能收到它的流式内容。
              // 不抢活动会话：右下聊天面板跟的是用户选中的那段
              if (!this.details[evt.conversationID]) void this.subscribeConversation(evt.conversationID)
              next.status = 'running'
              break
            }
            case 'step': {
              const goal = typeof evt.goal === 'string' ? evt.goal : (base.task?.goal ?? '')
              const steps = Array.isArray(evt.steps)
                ? (evt.steps as Array<{ text: string; status: 'todo' | 'doing' | 'done' }>)
                : (base.task?.steps ?? [])
              next.task = { goal, steps }
              break
            }
            case 'tool': {
              const tool = evt.tool as { tool?: string; title?: string; summary?: string } | undefined
              if (tool) {
                next.currentTool = { tool: tool.tool ?? '', title: tool.title ?? '', summary: tool.summary ?? '' }
                // 会话用到终端/浏览器/文件：对应面板立刻展开（订阅不上时这里也能投出操作卡）
                this.noteToolUse(tool.tool ?? '', evt.conversationID)
                if (!this.details[evt.conversationID]) {
                  this.pushOp({
                    id: `act:${evt.conversationID}:${tool.tool ?? ''}`,
                    conversationID: evt.conversationID,
                    title: tool.title ?? tool.tool ?? '操作',
                    content: tool.summary ?? '',
                    result: '',
                    status: 'running'
                  })
                }
              }
              break
            }
            case 'approval': {
              const list = evt.approvals ?? []
              next.approvals = list
              this.approvals[evt.conversationID] = list
              next.status = list.length ? 'approval' : 'running'
              for (const approval of list) {
                this.pushOp({
                  id: approval.eventID,
                  conversationID: evt.conversationID,
                  title: approval.title || approval.tool,
                  content: approval.summary,
                  result: '',
                  status: 'awaitingApproval',
                  questions: approval.questions?.length ? approval.questions : undefined
                })
              }
              // 事件里不再等的那些卡收掉（在这边/别处答了、批了、停了）；v2.45 的 resolved 带怎么结束的（answer 是给人看的一句）
              const waiting = new Set(list.map((item) => item.eventID))
              const resolutions = new Map((evt.resolved ?? []).map((item) => [item.eventID, item]))
              for (const card of this.opCards) {
                if (card.conversationID !== evt.conversationID || card.status !== 'awaitingApproval' || waiting.has(card.id)) continue
                const outcome = resolutions.get(card.id)?.outcome
                const answer = resolutions.get(card.id)?.answer
                const result =
                  outcome === 'answered'
                    ? (answer || '已回答')
                    : outcome === 'approved'
                      ? '已批准'
                      : outcome === 'denied'
                        ? '已拒绝'
                        : outcome === 'stopped'
                          ? '已停止'
                          : '已处理'
                this.pushOp({
                  id: card.id,
                  conversationID: card.conversationID,
                  title: card.title,
                  content: card.content,
                  result,
                  status: outcome === 'denied' || outcome === 'stopped' ? 'denied' : 'succeeded'
                })
              }
              break
            }
            case 'quota':
              next.status = 'quota'
              break
            case 'stalled':
              next.status = 'running'
              break
            case 'finished': {
              const brief = evt.brief as { status?: string } | undefined
              const status = brief?.status
              next.status = status === 'question' ? 'question' : status === 'quota' ? 'quota' : status === 'error' ? 'error' : 'idle'
              if (brief) next.lastBrief = brief as Record<string, unknown>
              next.currentTool = undefined
              // 这段会话里 Agent 自动弹开过的终端窗口：做完了收起（最小化，标签和终端都留着，
              // 任务栏点开就能复查）；之后又用到终端会重新弹出来。用户手动开的不动
              if (this.autoTerminals.delete(evt.conversationID)) {
                const win = this.windows.find((item) => item.kind === 'terminals')
                if (win && !win.minimized) this.minimizeWindow(win.id)
              }
              // 会话收尾：还没结果的操作卡都收掉（消息补丁那路会带真结果，这里兑底）
              for (const card of this.opCards) {
                if (card.conversationID === evt.conversationID && card.status === 'running') {
                  this.fadeOp(card.id)
                }
              }
              break
            }
          }
          this.activities[evt.conversationID] = next
          break
        }
        // M2 实时卡片的状态事件（每次都是完整快照）
        case 'terminals': {
          const state = params as { terminals: TerminalInfo[]; available: boolean; reason?: string }
          const before = new Set(this.terminals.map((terminal) => terminal.id))
          const hadTerminals = this.terminals.length > 0
          this.terminals = state.terminals ?? []
          this.terminalsAvailable = state.available
          this.terminalsReason = state.reason ?? ''
          // 活动的那个已经不在这份快照里了（终端跑完被回收 / Agent 关掉）：清掉，
          // 别让 activeTerminalID 指着一个没有标签的终端——下面会重新选一个存在的
          if (this.activeTerminalID && !this.terminals.some((terminal) => terminal.id === this.activeTerminalID)) {
            this.activeTerminalID = ''
          }
          // Agent 用 run_in_terminal 开的新终端：一出现就选中并打开卡片（方案 §5.4）；
          // 记下这段会话自动弹开过终端窗口（做完时收起，见 case 'finished'）
          const fresh = this.terminals.find((terminal) => !before.has(terminal.id) && terminal.command)
          if (fresh) {
            this.activeTerminalID = fresh.id
            this.autoTerminals.add(fresh.conversationID)
            this.openWindow('terminals')
          } else if (!this.activeTerminalID && this.terminals.length > 0) {
            this.activeTerminalID = this.terminals[0]!.id
          }
          // 终端跑完被关掉、Agent 收了终端：标签从有到无，窗口跟着收（卡片里的画面由 TerminalCard 自己清）
          this.closeTerminalWindowIfEmpty(hadTerminals)
          break
        }
        case 'browser': {
          const state = params as { available: boolean; reason?: string; tabs: BrowserTab[] }
          const before = new Set(this.browserTabs.map((tab) => tab.id))
          this.browserTabs = state.tabs ?? []
          this.browserAvailable = state.available
          this.browserReason = state.reason ?? ''
          // 会话开新浏览器标签 = 在用浏览器：立刻开浏览器窗口（已有就置顶）
          if (this.browserTabs.some((tab) => !before.has(tab.id))) this.openWindow('browser')
          break
        }
        case 'browser.frame': {
          // 远端动画页会以很高频率推帧（变了就推），直接逐帧上屏会把渲染进程打满
          //（实测主线程被饿死，窗口卡住）：攒最新一帧，按屏幕节奏上屏
          const frame = params as BrowserFrameParams
          pendingBrowserFrame = { tab: frame.tab, data: frame.data, viewport: frame.viewport }
          if (browserFrameFlushScheduled) break
          browserFrameFlushScheduled = true
          const flush = (): void => {
            browserFrameFlushScheduled = false
            if (!pendingBrowserFrame) return
            this.browserFrame = pendingBrowserFrame
            pendingBrowserFrame = null
          }
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush)
          else setTimeout(flush, 16)
          break
        }
        case 'browser.handOver': {
          // 智能体请用户在浏览器里做事：打开浏览器窗口并聚焦到它指名的那个标签
          //（BrowserCard 认领后自己 watch；事件比标签快照先到时等快照里出现了再认领）
          this.openWindow('browser')
          const tab = (params as { tab?: string }).tab
          if (tab) this.browserFocusTab = tab
          break
        }
        case 'team': {
          this.teamRuns = (params as { runs: TeamRun[] }).runs ?? []
          break
        }
        case 'runner': {
          // 实时运行状态：标题栏右上角的智能体数 / token 速度
          this.runnerState = (params as RunnerState) ?? null
          break
        }
        case 'engines': {
          const state = params as { engines?: EngineView[] }
          this.engines = state.engines ?? []
          break
        }
        case 'directories': {
          // 最近选择的工作目录变了（REMOTE.md §5：每次都整份快照）
          const state = params as DirectoriesState
          this.recentDirectories = state.recent ?? []
          break
        }
        case 'serviceUsage': {
          // 各家服务的余额 / 套餐用量变了（REMOTE.md §5；只有订了 config 的客户端才收）
          this.applyServiceUsageEvent(params)
          break
        }
      }
    },

    /** conversation 快照：partial 按前缀合并，整段直接替换；都带 versions（消息版本，patch 的 base 从这里算） */
    applyConversationSnapshot(params: unknown) {
      const snapshot = params as { conversation: Conversation; partial?: boolean; versions?: Record<string, number> }
      const detail = this.details[snapshot.conversation.id]
      if (!detail) return
      const versions = { ...detail.versions, ...(snapshot.versions ?? {}) }
      const incoming = snapshot.conversation.nodes
      if (snapshot.partial) {
        // partial：要么是「只给了新的一截」，要么是把局部截出的树（REMOTE.md §5）；按 id 合并到现有节点里
        const byID = new Map(detail.nodes.map((node) => [node.id, node]))
        for (const node of incoming) byID.set(node.id, node)
        detail.nodes = [...byID.values()]
      } else {
        detail.nodes = [...incoming]
      }
      if (snapshot.conversation.selectedChildren) {
        detail.selectedChildren = { ...detail.selectedChildren, ...snapshot.conversation.selectedChildren }
      }
      detail.versions = versions
      this.rebuildPath(detail)
      // 流式内容可能随快照增量来，投窗钩子补一遍（部分快照只带新的一截）
      if (snapshot.partial) {
        for (const node of incoming) {
          if (node.role === 'assistant') this.noteAssistantStream(snapshot.conversation.id, node)
        }
      }
    },

    /** 按 parentID + selectedChildren 重建显示路径（分支切换后也调这个） */
    rebuildPath(detail: ConversationDetail) {
      const { path, branches } = conversationPath(detail.nodes, detail.selectedChildren)
      detail.messages = path.map((message) => ({ message, version: detail.versions[message.id] ?? 0 }))
      this.branchInfo[detail.conversationID] = branches
    },

    /** 切到另一条分支（方案 §5.3；runner.selectBranch {conversationID, child, parentKey}） */
    async selectBranch(conversationID: string, messageID: string) {
      const detail = this.details[conversationID]
      const info = this.branchInfo[conversationID]?.[messageID]
      if (!detail || !info || !this.currentMachine) return
      try {
        await rpc(this.currentMachine, 'runner.selectBranch', {
          conversationID,
          child: messageID,
          parentKey: info.parentKey
        })
        // 本地先改（乐观更新），服务端的 conversation 快照会再对齐
        detail.selectedChildren[info.parentKey] = messageID
        this.rebuildPath(detail)
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      }
    },

    /** 同父的兄弟分支里前后跳（delta = ±1） */
    async switchBranch(conversationID: string, messageID: string, delta: number) {
      const info = this.branchInfo[conversationID]?.[messageID]
      if (!info) return
      const next = (info.index + delta + info.count) % info.count
      const target = info.siblings[next]
      if (target) await this.selectBranch(conversationID, target)
    },

    applyWholeMessage(params: unknown) {
      const payload = params as { conversationID: string; message: ChatMessage; version?: number }
      const detail = this.details[payload.conversationID]
      if (!detail) return
      const version = payload.version ?? 0
      const index = detail.nodes.findIndex((node) => node.id === payload.message.id)
      if (index >= 0) detail.nodes[index] = payload.message
      else detail.nodes.push(payload.message)
      detail.versions[payload.message.id] = version
      this.rebuildPath(detail)
      if (payload.message.role === 'assistant') this.noteAssistantStream(payload.conversationID, payload.message)
    },

    applyPatch(params: unknown) {
      const patch = params as {
        conversationID: string
        messageID: string
        base: number
        version: number
        fields?: ChatMessage
        blocks?: BlocksPatch
      }
      const detail = this.details[patch.conversationID]
      if (!detail) return
      const node = detail.nodes.find((candidate) => candidate.id === patch.messageID)
      if (!node || (detail.versions[patch.messageID] ?? 0) !== patch.base) {
        void this.refetchMessage(patch.messageID, patch.conversationID)
        return
      }
      const applied = applyMessagePatch(node, {
        conversationID: patch.conversationID,
        messageID: patch.messageID,
        base: patch.base,
        version: patch.version,
        fields: patch.fields,
        blocks: patch.blocks
      })
      if (!applied) {
        void this.refetchMessage(patch.messageID, patch.conversationID)
        return
      }
      detail.versions[patch.messageID] = patch.version
      // 块是原地改的，只为触发视图更新重建一次（保留对象引用）
      const entry = detail.messages.find((candidate) => candidate.message.id === patch.messageID)
      if (entry) entry.version = patch.version
      if (node.role === 'assistant') this.noteAssistantStream(patch.conversationID, node)
    },

    /** 补丁打不上：拉整条 */
    async refetchMessage(messageID: string, conversationID: string) {
      if (!this.currentMachine) return
      try {
        const result = (await host.request({
          type: 'conversations.getMessage',
          machineID: this.currentMachine,
          conversationID,
          messageID
        })) as { message: ChatMessage; version: number }
        const detail = this.details[conversationID]
        if (!detail) return
        const index = detail.nodes.findIndex((node) => node.id === messageID)
        if (index >= 0) detail.nodes[index] = result.message
        else detail.nodes.push(result.message)
        detail.versions[messageID] = result.version
        this.rebuildPath(detail)
        if (result.message.role === 'assistant') this.noteAssistantStream(conversationID, result.message)
      } catch {
        // 拉不到就先不动（下一条补丁/快照会再对齐）
      }
    },

    // MARK: SChat 扫码一键连（M1.5）

    async schatRefresh() {
      const state = (await host.request({ type: 'schat.state' })) as typeof this.schat
      this.schat = state
      return state
    },

    async schatLogin(server?: string, deviceName?: string) {
      const state = (await host.request({ type: 'schat.login', server, deviceName })) as typeof this.schat
      this.schat = state
      return state
    },

    async schatDisconnect() {
      await host.request({ type: 'schat.disconnect' })
      await this.schatRefresh()
    },

    async schatSend(botID: number, text: string) {
      await host.request({ type: 'schat.send', botID, text })
    },

    /** 重拉好友里的机器人列表（登录后列表为空/新加了机器人时用） */
    async schatRefreshBots() {
      const state = (await host.request({ type: 'schat.refreshBots' })) as typeof this.schat
      this.schat = state
      return state
    },

    /** 一键连上这台机器（0.3）：从机器人列表直接建机器（WebRTC 工作通道）→ 连接；返回 machineID（登录页盯它的连接状态） */
    async connectWork(botID: number, name?: string): Promise<string> {
      this.connectingWork = true
      try {
        const bot = (this.schat as { bots?: { id: number; name?: string }[] }).bots?.find(
          (item) => item.id === botID
        )
        // machines.addWork 回的是 { machines, current }（协议进程 addMachine 末尾的 machinesInfo）
        const added = (await host.request({
          type: 'machines.addWork',
          botID,
          name: name ?? bot?.name
        })) as { machines?: MachineStateInfo[]; current?: string }
        if (added.machines) this.machines = added.machines
        const machineID =
          added.current ??
          this.machines.find((machine) => machine.targetText === `work:${botID}`)?.id ??
          String(botID)
        if (added.current) await this.connectMachine(machineID)
        return machineID
      } finally {
        this.connectingWork = false
      }
    },

    // MARK: 登录页 / 工作台

    /** 连接成功，收起登录页进工作台（会话列表 / 聊天 / 通话都是常驻面板，不用补开窗口） */
    enterWorkbench() {
      this.workbenchReady = true
      this.loginOverlay = false
    },

    /** 打开登录页（工作台里重新扫码/换账号时盖在桌面上） */
    openLogin() {
      this.loginOverlay = true
    },

    closeLogin() {
      this.loginOverlay = false
    },

    // MARK: 通话（M3-D）

    async callDial(botID: number, callType: 'audio' | 'video' = 'audio') {
      return host.request({ type: 'schat.call.dial', botID, callType })
    },

    callSignal(signalType: string, payload: string) {
      return host.request({ type: 'schat.call.signal', signalType, payload })
    },

    async callActive() {
      await host.request({ type: 'schat.call.active' })
    },

    async callMute(muted: boolean) {
      await host.request({ type: 'schat.call.mute', muted })
    },

    async callAccept() {
      await host.request({ type: 'schat.call.accept' })
    },

    async callReject() {
      await host.request({ type: 'schat.call.reject' })
    },

    async callHangup() {
      await host.request({ type: 'schat.call.hangup' })
    },

    async callIce(): Promise<unknown[]> {
      const result = (await host.request({ type: 'schat.call.ice' })) as { iceServers?: unknown[] }
      return result.iceServers ?? []
    },

    /** 取走还没消费的信令 */
    drainCallSignals(): unknown[] {
      const pending = this.callSignals.filter((item) => item.seq > this.callSignalSeq)
      if (pending.length) this.callSignalSeq = pending[pending.length - 1]!.seq
      return pending.map((item) => item.signal)
    },

    // MARK: 操作

    async submitText(text: string, attachments: Array<{ path: string; name: string }>) {
      if (!this.currentMachine) return
      let conversationID = this.activeConversationID
      if (!conversationID) {
        await this.createConversation()
        conversationID = this.activeConversationID
      }
      if (!conversationID) throw new Error('没有打开的会话')
      await rpc(this.currentMachine, 'runner.submit', {
        conversationID,
        text,
        attachments: attachments.map((attachment) => attachment.path)
      })
    },

    // MARK: 和助手说（REMOTE.md §6「助手」）：聊天面板切到所连机器的助手，不走会话

    /** 进「和助手说」：订阅助手日志拿最近条目，之后 assistant.entry 流式进来。
     *  老服务端没有 assistant.*：面板里给一句人话，不发 */
    async openAssistantChat() {
      const machine = this.currentMachine
      if (!machine) return
      this.assistantChat = true
      this.assistantUnsupported = false
      if (assistantSubscribed.has(machine)) return
      try {
        const result = (await rpc(machine, 'assistant.subscribe', { count: 80 })) as AssistantSubscribeResult
        assistantSubscribed.add(machine)
        // 等回复的中间换机器了：别把旧机器的日志填进新机器的面板
        if (this.currentMachine !== machine) return
        this.assistantState = result.state ?? null
        this.assistantEntries = [...(result.entries ?? [])]
      } catch {
        if (this.currentMachine === machine) {
          this.assistantUnsupported = true
          this.assistantState = null
          this.assistantEntries = []
        }
      }
    },

    /** 退出「和助手说」回到会话（选中/新建会话、切机器时自动走这里）：退订、清面板 */
    async closeAssistantChat() {
      const machine = this.currentMachine
      this.assistantChat = false
      this.assistantState = null
      this.assistantEntries = []
      this.assistantUnsupported = false
      if (machine && assistantSubscribed.has(machine)) {
        assistantSubscribed.delete(machine)
        rpc(machine, 'assistant.unsubscribe', {}).catch(() => {})
      }
    },

    /** 说给这台机器的助手（assistant.say）：助手在说时服务端自动打断重来；
     *  回执 entry 先并入（事件随后还会来，按 id 去重），流式由 assistant.entry 续写 */
    async assistantSay(text: string, attachments: string[]) {
      if (!this.currentMachine) return
      const result = (await rpc(this.currentMachine, 'assistant.say', {
        text,
        source: 'desktop',
        ...(attachments.length > 0 ? { attachments } : {})
      })) as { entry?: AssistantEntry }
      if (result.entry) this.mergeAssistantEntry(result.entry)
    },

    /** 打断正在说的助手（assistant.stop） */
    async assistantStop() {
      if (!this.currentMachine) return
      await rpc(this.currentMachine, 'assistant.stop', {}).catch(() => {})
    },

    /** 助手日志合并：同 id 更新（流式同一条反复改），新的按时间序插进去 */
    mergeAssistantEntry(entry: AssistantEntry) {
      const index = this.assistantEntries.findIndex((item) => item.id === entry.id)
      if (index >= 0) {
        this.assistantEntries.splice(index, 1, entry)
        return
      }
      const at = this.assistantEntries.findIndex((item) => item.at > entry.at)
      this.assistantEntries.splice(at < 0 ? this.assistantEntries.length : at, 0, entry)
    },

    /** 切换这段会话的引擎（REMOTE.md：runner.setEngine {conversationID, engineID?}）。
     *  服务端确认后 summaries 事件会带回新值；先乐观更新本地，输入框的选择器立刻反映。 */
    async setEngine(conversationID: string, engineID: string) {
      if (!this.currentMachine) return
      await rpc(this.currentMachine, 'runner.setEngine', { conversationID, engineID })
      const summary = this.summaries.find((item) => item.id === conversationID)
      if (summary) summary.engineID = engineID
    },

    /** 切换这段会话的工作目录（REMOTE.md：runner.setWorkingDirectory {conversationID, path?}；path 不写 = 回默认）。
     *  同 setEngine：先乐观更新 summaries，服务端确认后 summaries/runtime 事件会盖回来。 */
    async setWorkingDirectory(conversationID: string, path?: string) {
      if (!this.currentMachine) return
      await rpc(this.currentMachine, 'runner.setWorkingDirectory', path ? { conversationID, path } : { conversationID })
      const summary = this.summaries.find((item) => item.id === conversationID)
      if (summary) {
        summary.workingDirectory = path || undefined
        summary.workingDirectoryName = path ? path.split(/[\\/]/).filter(Boolean).pop() : undefined
      }
      const detail = this.details[conversationID]
      if (detail?.runtime) detail.runtime.workingDirectory = path
      if (path) {
        rpc(this.currentMachine, 'directories.push', { path }).catch(() => {})
      }
    },

    /** 打开目录选择菜单时重新拉一份最近目录（顺带重验还在不在；REMOTE.md directories.get） */
    async refreshDirectories() {
      if (!this.currentMachine) return
      try {
        const state = (await rpc(this.currentMachine, 'directories.get', {})) as DirectoriesState
        this.recentDirectories = state.recent ?? []
      } catch {
        this.recentDirectories = null // 旧服务端：菜单里不列
      }
    },

    // MARK: 各家服务的余额 / 套餐用量（REMOTE.md §6「在线服务」）

    /** 模型选择器显示着（输入框的模型 chip——边框要一直跟着推，不只菜单开着）就订 config.subscribe ——
     *  服务端只把 serviceUsage 事件推给订着 config 的客户端。同时查一遍（一显示就有数）。
     *  旧服务端没有 config：只手动查，没有推送。 */
    async watchServiceUsage(on: boolean) {
      this.usageWanted = on
      const machine = this.currentMachine
      if (!machine) return
      if (!on) {
        usageSubscribed.delete(machine)
        rpc(machine, 'config.unsubscribe', {}).catch(() => {})
        return
      }
      await this.ensureUsageSubscription()
      await this.refreshServiceUsage()
    },

    /** 订这个客户端的 config（幂等）；旧服务端订不上就记下不再试 */
    async ensureUsageSubscription() {
      const machine = this.currentMachine
      if (!machine || !this.usageWanted) return
      if (this.currentMachineInfo?.state !== 'ready') return
      if (usageSubscribed.has(machine) || usageUnsupported.has(machine)) return
      try {
        await rpc(machine, 'config.subscribe', {})
        if (this.currentMachine !== machine) return
        usageSubscribed.add(machine)
      } catch {
        // 旧服务端没有 config.subscribe：没有推送，只有手动查的那一次
        if (this.currentMachine === machine) usageUnsupported.add(machine)
      }
    },

    /** 当前机器要查哪些：可用引擎按「接口地址 + 密钥名」去重（同一家的多个模型只查一次；本机地址不查） */
    usageTargets(): UsageTarget[] {
      const targets = new Map<string, UsageTarget>()
      for (const engine of this.engines) {
        if (engine.disabled) continue
        const baseURL = engine.baseURL ?? ''
        if (!canQueryUsage(baseURL)) continue
        const secretName = engine.apiKeySecret ?? ''
        const key = usageKey(baseURL, secretName)
        if (targets.has(key)) continue
        // custom：客户端没有服务目录，不知道这家是不是「自定义服务」。传 true 时：认得的服务照旧（按地址），
        // 不认得的地址会当成 one-api 这类中转试一次 billing 接口（本机地址上面已经滤掉了）
        targets.set(key, { key, baseURL, secretName, custom: true })
      }
      return [...targets.values()]
    },

    /** 查一遍用量（services.usage）。force = 推送来说额度用完 / 恢复了，不管刚查过 */
    async refreshServiceUsage(force = false) {
      const machine = this.currentMachine
      if (!machine || this.currentMachineInfo?.state !== 'ready') return
      await Promise.all(this.usageTargets().map((target) => this.queryServiceUsage(target, force)))
    },

    /** 查一家（按接口地址 + 密钥名）。maxAgeMs 内查过的不重复查（推送里的「请求成功」很频繁，默认 30 秒；
     *  悬停胶囊重查那家用 10 秒，== Friday refreshUsage(false, service, 10)） */
    async queryServiceUsage(target: UsageTarget, force = false, maxAgeMs = 30_000) {
      const machine = this.currentMachine
      if (!machine) return
      const existing = this.serviceUsage[target.key]
      if (existing?.loading) return
      if (!force && existing && Date.now() - existing.checkedAt < maxAgeMs) return
      this.serviceUsage[target.key] = {
        key: target.key,
        baseURL: target.baseURL,
        secretName: target.secretName,
        custom: target.custom,
        loading: true,
        checked: existing?.checked ?? false,
        supported: existing?.supported ?? false,
        report: existing?.report,
        observed: existing?.observed,
        error: '',
        checkedAt: existing?.checkedAt ?? 0
      }
      try {
        const result = (await rpc(machine, 'services.usage', {
          baseURL: target.baseURL,
          secretName: target.secretName,
          custom: target.custom
        })) as UsageResult
        if (this.currentMachine !== machine) return
        this.serviceUsage[target.key] = {
          key: target.key,
          baseURL: target.baseURL,
          secretName: target.secretName,
          custom: target.custom,
          loading: false,
          checked: true,
          supported: result.supported === true,
          report: result.report,
          observed: result.observed,
          error: result.error ?? '',
          checkedAt: Date.now()
        }
      } catch (error) {
        if (this.currentMachine !== machine) return
        this.serviceUsage[target.key] = {
          key: target.key,
          baseURL: target.baseURL,
          secretName: target.secretName,
          custom: target.custom,
          loading: false,
          checked: true,
          supported: false,
          error: error instanceof Error ? error.message : String(error),
          checkedAt: Date.now()
        }
      }
    },

    /** 服务端推的用量变化（REMOTE.md §5：{changes: [{observedKey, observed}]}）：
     *  额度用完 / 恢复（observed）的立刻重查；只是请求成功过的，30 秒内查过就不重复查。
     *  手里还没有这份记录的（比如刚订上、菜单里还没列到它）：整批补一次 */
    applyServiceUsageEvent(params: unknown) {
      const changes = (params as { changes?: Array<{ observedKey?: string; observed?: boolean }> }).changes ?? []
      let missing = false
      for (const change of changes) {
        const key = change.observedKey ?? ''
        if (!key) continue
        const entry = this.serviceUsage[key]
        if (!entry) {
          missing = true
          continue
        }
        void this.queryServiceUsage(
          { key: entry.key, baseURL: entry.baseURL, secretName: entry.secretName, custom: entry.custom },
          change.observed === true
        )
      }
      if (missing) void this.refreshServiceUsage(true)
    },

    /** 从最近目录里去掉一条（REMOTE.md directories.remove） */
    async removeRecentDirectory(path: string) {
      if (!this.currentMachine) return
      this.recentDirectories = (this.recentDirectories ?? []).filter((item) => item.path !== path)
      try {
        await rpc(this.currentMachine, 'directories.remove', { path })
      } catch {
        // 旧服务端删不掉：本地也不留
      }
    },

    /** 浏览这台机器的目录（REMOTE.md fs.list：不选工作目录用，只列子目录；不给 path 是主目录） */
    async browseDirectory(path?: string): Promise<FsListResult | undefined> {
      if (!this.currentMachine) return
      return (await rpc(this.currentMachine, 'fs.list', path ? { path } : {})) as FsListResult
    },

    /** 拉这台机器的「/」命令（REMOTE.md commands.list；directory 是会话的工作目录，空 = 默认）。
     *  刚打出「/」时调；旧服务端没有 feature commands：置 null，命令菜单不弹 */
    async refreshCommands(directory?: string) {
      const machine = this.currentMachine
      if (!machine) return
      try {
        const result = (await rpc(machine, 'commands.list', directory ? { directory } : {})) as CommandsListResult
        // 等结果时换了机器、或按别的目录又拉过一份：这份作废（照桌面端 CommandsModel）
        if (this.currentMachine !== machine) return
        this.commands = {
          machineID: machine,
          directory: directory ?? '',
          items: result.commands ?? []
        }
      } catch {
        if (this.currentMachine === machine) this.commands = null
      }
    },

    /** 「/」后面打到 prefix 时菜单里列哪些（照桌面端 CommandsModel::matching：
     *  名字以打的开头的在前——插件的按短名字「插件名:」后面的也算开头，名字里有的在后；不分区大小写） */
    matchCommands(prefix: string): CommandInfo[] {
      const view = this.commands
      if (!view || view.machineID !== this.currentMachine) return []
      const wanted = prefix.trim().toLowerCase()
      const starts: CommandInfo[] = []
      const contains: CommandInfo[] = []
      for (const command of view.items) {
        const name = command.name.toLowerCase()
        const colon = name.lastIndexOf(':')
        const shortName = colon >= 0 ? name.slice(colon + 1) : name
        if (wanted === '' || name.startsWith(wanted) || shortName.startsWith(wanted)) starts.push(command)
        else if (name.includes(wanted)) contains.push(command)
      }
      return [...starts, ...contains]
    },

    async resolveApproval(eventID: string, approved: boolean) {
      if (!this.currentMachine) return
      await rpc(this.currentMachine, 'runner.resolveApproval', { eventID, approved })
    },

    /** 回答 ask_user（REMOTE.md v2.13：runner.resolveApproval 带 answer）。answers 每题一条
     *  （选项名，多选「、」连；自己写的原样；空 = 没选）；交了先把面板冻在「已交」，等 approval 事件收走 */
    async answerQuestion(eventID: string, answer: { answers: string[]; reply?: string }) {
      this.answeredAsks.add(eventID)
      if (!this.currentMachine) return
      await rpc(this.currentMachine, 'runner.resolveApproval', { eventID, approved: true, answer })
    },

    /** 跳过提问：不带 answer 的批准 = 服务端按推荐的做（ASK.md） */
    async skipQuestion(eventID: string) {
      this.answeredAsks.add(eventID)
      await this.resolveApproval(eventID, true)
    },

    /** 置顶提问浮层里点「稍后再说」：这个不再弹，新问题来了照常弹 */
    dismissAsk(eventID: string) {
      this.dismissedAsks.add(eventID)
    },

    async stopRunner(conversationID?: string) {
      const target = conversationID ?? this.activeConversationID
      if (!this.currentMachine || !target) return
      await rpc(this.currentMachine, 'runner.stop', { conversationID: target })
    },

    // MARK: 插入内容（工作中补充，对照 Friday 桌面端 v1.6）

    /** 撤回一条排队 / 待插入的消息（REMOTE.md：runner.removeQueued {conversationID, itemID}） */
    async removeQueued(conversationID: string, itemID: string) {
      if (!this.currentMachine) return
      await rpc(this.currentMachine, 'runner.removeQueued', { conversationID, itemID })
    },

    /** 上一轮被停止后暂停的排队消息：用户点了「发送」（REMOTE.md：runner.resumeQueue {conversationID}） */
    async resumeQueue(conversationID?: string) {
      const target = conversationID ?? this.activeConversationID
      if (!this.currentMachine || !target) return
      await rpc(this.currentMachine, 'runner.resumeQueue', { conversationID: target })
    },

    // ---- 桌面投窗（气泡 / 操作卡）：会话不再是窗口，流式内容从这里上桌面 ----

    /** 投出物的避让尺寸（增长上限）：投出后会随流式内容长高，落点选取与已占矩形部必须按
     *  「长满」算——只按投出时刻的估计尺寸避让，增长后重叠会直接盖住彼此（曾致操作卡
     *  长到 220px 后压住思考气泡顶部：标签行 + 正文开头全被盖）。回复气泡实际可长到窗口高，
     *  避让值妥协取 400（与思考一致）：再大会把采样空间挤到退让。 */
    castMaxSize(kind: 'bubble' | 'op'): { w: number; h: number } {
      // 气泡与操作卡统一一套：内容/结果都不截断、限高 lib/cast.ts 内部滚动，长满都可到 800+，
      // 避让一律取 castLimitH（400 档）——再大会把随机落点的采样空间挤到退让
      return { w: kind === 'op' ? 400 : 360, h: castLimitH(window.innerHeight) }
    },

    /** 桌面主区里的随机落点（避开左侧会话列、右侧面板，留边距）：
     *  传入的 width/height 必须是增长上限（castMaxSize）；在已有气泡/操作卡的「长满」矩形之外
     *  找空闲处；实在没有整块空地就退到重叠最小的点（此时仍可能后活动者盖住先前的） */
    randomSpot(width: number, height: number): { x: number; y: number } {
      const leftEdge = 250
      const rightEdge = Math.max(leftEdge + width + 8, window.innerWidth - 400)
      const topEdge = 60
      const bottomEdge = Math.max(topEdge + height + 8, window.innerHeight - 250)
      const spanX = Math.max(1, rightEdge - leftEdge - width)
      const spanY = Math.max(1, bottomEdge - topEdge - height)
      const GAP = 8 // 投出物之间留的空隙
      // 已占用的矩形：气泡 + 操作卡，都按增长上限算（当前尺寸会变，只有长满的矩形才保证不重叠）
      const bubbleMax = this.castMaxSize('bubble')
      const opMax = this.castMaxSize('op')
      const taken = [
        ...this.bubbles.map((b) => ({ x: b.x, y: b.y, w: bubbleMax.w, h: bubbleMax.h })),
        // 卡与气泡同套限高，避让矩形同一算法
        ...this.opCards.map((c) => ({ x: c.x, y: c.y, w: opMax.w, h: opMax.h }))
      ]
      const overlapOf = (x: number, y: number) => {
        let sum = 0
        for (const r of taken) {
          const ow = Math.min(x + width + GAP, r.x + r.w) - Math.max(x - GAP, r.x)
          const oh = Math.min(y + height + GAP, r.y + r.h) - Math.max(y - GAP, r.y)
          if (ow > 0 && oh > 0) {
            // 与已有物顶部带（标签行 + 开头内容，约 60px）的交叠高：盖住这里 = 遮住它的身份标识，
            // 罚 10 倍——密度高不得不重叠时，退让采样宁可盖已有物的下部（滚走的旧内容）也不盖顶部。
            // 没有这条罚分时「取重叠最小」会把后来者系统性叠到同一个牺牲者的顶部（实测 30+ 张卡
            // 轮番压住同一条思考气泡的顶部 60px），标签行长期不可读
            const topBand = Math.min(y + height + GAP, r.y + 60) - Math.max(y - GAP, r.y)
            sum += ow * oh * (topBand > 0 ? 10 : 1)
          }
        }
        return sum
      }
      let best = { x: leftEdge, y: topEdge }
      let bestOverlap = Infinity
      for (let i = 0; i < 24 && bestOverlap > 0; i++) {
        const cand = {
          x: Math.min(leftEdge + Math.random() * spanX, rightEdge - width),
          // y 夹在 [topEdge, bottomEdge - height]：矮窗口里长满矩形超出可用高时贴顶投，
          // 不能把 y 采到负数/越顶（顶部会被标题栏裁掉）
          y: Math.max(topEdge, Math.min(topEdge + Math.random() * spanY, bottomEdge - height))
        }
        const overlap = overlapOf(cand.x, cand.y)
        if (overlap < bestOverlap) {
          best = cand
          bestOverlap = overlap
        }
      }
      return best
    },

    /** 投一条气泡（思考/文本）：同一个内容块续在同一条气泡里（一个块一条，多段不并泡），5 秒无新内容渐隐。
     *  渐隐删除只是「看不见」，全文记在 castTexts；断流超过 5 秒后再来增量时按全文重建，
     *  不能只投增量那截（流式间隔一大就会变成「内容只剩一小段」） */
    pushBubble(conversationID: string, kind: 'thinking' | 'text', chunk: string, blockID: string) {
      if (!chunk.trim()) return
      // 空白归一但保留换行：行内空白压成单个空格、连续换行压成单个换行（全压成空格会把整段思考挤成一行）。
      // 流式切片的分隔空白可能落在上一片尾部或本片开头，trim 掉再硬拼会粘连，所以不 trim——
      // 追加时接在已有内容后面，只在两边都无空白时补一个空格，不强制加换行
      const add = chunk
        .replace(/\r\n?/g, '\n')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/\n{2,}/g, '\n')
      const id = `${conversationID}:${kind}:${blockID}`
      const existing = this.bubbles.find((item) => item.id === id)
      // 基底：气泡还在用气泡全文；已渐隐删除用 castTexts 里的全文（断流重建时续上，不丢前文）
      const base = existing ? existing.text : (this.castTexts[id] ?? '')
      const gap = base && !/\s$/.test(base) && !/^\s/.test(add) ? ' ' : ''
      const full = (base + gap + add).trim()
      this.castTexts[id] = full
      if (existing) {
        // 全量内容不截断（气泡不限高）。内容更新只记活跃时刻（activeAt），不当场抬 z——
        // 由 castTick 在 5 秒窗口到期时抬「当前最活跃」的；窗口内更新照常续文本、刷新渐隐计时
        existing.text = full
        existing.activeAt = Date.now()
        window.clearTimeout(existing.timer)
        existing.fading = false
        existing.timer = window.setTimeout(() => this.fadeBubble(id), 5000)
        return
      }
      const size = this.castMaxSize('bubble')
      const spot = this.randomSpot(size.w, size.h)
      this.bubbles.push({
        id,
        conversationID,
        kind,
        text: full,
        x: spot.x,
        y: spot.y,
        z: ++this.castZTop,
        activeAt: Date.now(),
        fading: false,
        timer: window.setTimeout(() => this.fadeBubble(id), 5000)
      })
    },

    /** 气泡越界修正：整体上移（dy 为负数），底边贴住桌面底、不越过窗口底 */
    shiftBubbleY(id: string, dy: number) {
      const bubble = this.bubbles.find((item) => item.id === id)
      if (!bubble || !dy) return
      bubble.y += dy
    },

    /** 气泡渐隐（先加渐隐类，动画完了再从数组里删） */
    fadeBubble(id: string) {
      const bubble = this.bubbles.find((item) => item.id === id)
      if (!bubble || bubble.fading) return
      bubble.fading = true
      window.clearTimeout(bubble.timer)
      bubble.timer = window.setTimeout(() => {
        this.bubbles = this.bubbles.filter((item) => item.id !== id)
      }, 600)
    },

    /** 投一张操作卡（极简终端样式）：同一 id 续写；终态后 5 秒渐隐 */
    pushOp(card: {
      id: string
      conversationID: string
      title: string
      content: string
      result: string
      status: DesktopOp['status']
      toolName?: string
      questions?: AskQuestion[]
    }) {
      // 已渐隐移除的卡不复活：后续补丁重walk到同一历史块时若重建，就会同一操作反复弹出
      if (this.fadedOps.has(card.id)) {
        if (terminalStatus(card.status)) return
        this.fadedOps.delete(card.id) // 有新动态（重新运行）才允许重新出现
      }
      const existing = this.opCards.find((item) => item.id === card.id)
      if (existing) {
        // 内容更新只记活跃时刻，由 castTick 在窗口到期时抬「当前最活跃」；
        // 状态变化（审批弹出、出结果）不是内容更新，立即置顶让用户看见（并重置窗口）
        const statusChanged = card.status !== existing.status
        if (statusChanged) {
          existing.z = ++this.castZTop
          this.castZAt = Date.now()
        }
        existing.activeAt = Date.now()
        if (card.title) existing.title = card.title
        if (card.content) existing.content = card.content
        if (card.result) existing.result = card.result
        if (card.toolName) existing.toolName = card.toolName
        if (card.questions) existing.questions = card.questions
        if (card.status !== 'running' || existing.status === 'running') existing.status = card.status
        if (terminalStatus(card.status)) this.scheduleOpFade(card.id)
        return
      }
      const size = this.castMaxSize('op')
      const spot = this.randomSpot(size.w, size.h)
      this.opCards.push({
        ...card,
        title: card.title || '操作',
        x: spot.x,
        y: spot.y,
        z: ++this.castZTop,
        activeAt: Date.now(),
        fading: false,
        timer: 0
      })
      if (terminalStatus(card.status)) this.scheduleOpFade(card.id)
    },

    /** 操作到终态：5 秒后开始渐隐。看图/看视频不再例外——成功时媒体已归进
     *  桌面的图片叠/视频叠（addStackMedia），卡照常 5 秒渐隐，媒体仍留在叠里可查看 */
    scheduleOpFade(id: string) {
      const card = this.opCards.find((item) => item.id === id)
      if (!card || card.fading || card.timer) return
      card.timer = window.setTimeout(() => this.fadeOp(id), 5000)
    },

    fadeOp(id: string) {
      const card = this.opCards.find((item) => item.id === id)
      if (!card || card.fading) return
      card.fading = true
      window.clearTimeout(card.timer)
      card.timer = window.setTimeout(() => {
        this.opCards = this.opCards.filter((item) => item.id !== id)
        this.fadedOps.add(id)
      }, 600)
    },

    /** 看图/看视频成功：把媒体归进桌面的图片叠/视频叠（压在桌面最底层那两叠）。
     *  同一会话同一路径只归档一次——流式补丁重walk历史块不会把同一张图堆进叠里。
     *  归档回时顺手把文件下载到本地（userData/MediaStack）：会话结束、远端文件被清理、
     *  重启软件后叠里和消息里仍能加载（fire-and-forget，失败不影响会话还在时的在线查看） */
    addStackMedia(conversationID: string, toolName: string, args: string) {
      const source = mediaArgSource(toolName, args)
      if (!source) return
      const id = `${conversationID}:${source.kind}:${source.src}`
      if (this.stackMedia.some((item) => item.id === id)) return
      const item: StackMediaItem = { id, conversationID, kind: source.kind, src: source.src, at: Date.now() }
      this.stackMedia.push(item)
      void this.cacheStackMedia(item)
    },

    /** 把叠里的一条媒体下载到本地缓存；成功后记下文件名（清空时按它删） */
    async cacheStackMedia(item: StackMediaItem) {
      const name = await ensureStackMediaCached(item, {
        machineID: this.currentMachine,
        workingDirectory: this.summaries.find((s) => s.id === item.conversationID)?.workingDirectory
      })
      if (!name) return
      // 拿到名字前这一条可能已被清空：只更新还在叠里的那条
      const live = this.stackMedia.find((entry) => entry.id === item.id)
      if (live) live.cache = name
    },

    /** 灯箱放大：叠里点单张媒体时调（图片看大图、视频大窗播放） */
    openMediaZoom(item: StackMediaItem) {
      this.zoomMedia = item
    },

    closeMediaZoom() {
      this.zoomMedia = null
    },

    /** 清空一叠（展开面板里的「清空」按钮）：叠里的条目和对应的本地缓存文件一起删 */
    clearStack(kind: 'image' | 'video') {
      const names = [
        ...new Set(
          this.stackMedia
            .filter((item) => item.kind === kind)
            .map((item) => item.cache ?? stackCacheName(item.conversationID, item.kind, item.src))
        )
      ]
      this.stackMedia = this.stackMedia.filter((item) => item.kind !== kind)
      if (names.length) void deleteStackCaches(names)
    },

    /** 置顶 tick（每秒跑一次）：5 秒窗口到期时，把这个窗口内真正有内容更新的投出物里
     *  「当前最活跃」的（activeAt 最大 = 最近还在更新的）抬到最前 */
    castTick() {
      const now = Date.now()
      const since = this.castZAt
      if (now - since < CAST_Z_INTERVAL) return
      this.castZAt = now
      const pool = [...this.bubbles, ...this.opCards].filter((item) => item.activeAt > since)
      if (!pool.length) return
      const top = pool.reduce((best, item) => (item.activeAt > best.activeAt ? item : best))
      if (top.z >= this.castZTop) return // 已在最前（刚出现/刚被状态变化置顶），层级已正确
      top.z = ++this.castZTop
    },

    /** 启动 / 停止置顶 tick（App 挂载时启动，跟界面同生命周期） */
    startCastTicker() {
      if (castTimer >= 0) return
      castTimer = window.setInterval(() => this.castTick(), 1000)
    },
    stopCastTicker() {
      if (castTimer < 0) return
      window.clearInterval(castTimer)
      castTimer = -1
    },

    /**
     * 助手消息的流式钩子：按块对比上次已投长度，把新增的思考/文本续到气泡上。
     * 一个块一条气泡——同一条消息里多段思考/多段回复各自成泡，不并进同一条（并泡会把
     * 前后不相干的段拼在一起，中间只隔一个空格）。工具块顺手转成操作卡。
     * 首次见到整条消息只记下标、不补投历史（历史在聊天面板里看）；之后新出现的块整个当增量投（新开一条泡）。
     * 已完结（收尾/出错/被打断）的消息不会再有真正的流式增量：服务端随新一轮活动重推历史时块 id
     * 会换新（结束的会话里一执行新内容，已见过的消息会按新块 id 全部重弹成气泡），所以完结消息
     * 一律只记下标不投。
     */
    noteAssistantStream(conversationID: string, message: ChatMessage) {
      const seen = this.streamMarks[message.id]
      const marks = seen ?? {}
      const done = !!(message.finishedAt || message.error || message.stoppedByUser)
      for (const block of message.blocks ?? []) {
        const kind = blockCase(block)
        if (kind === 'tool') {
          this.noteToolBlock(conversationID, blockPayload<ToolEvent>(block, 'tool'))
          continue
        }
        if (kind !== 'thinking' && kind !== 'text') continue
        const full = String(blockPayload<string>(block, kind) ?? '')
        const mark = marks[block.id] ?? 0
        if (seen && !done && full.length > mark) {
          this.pushBubble(conversationID, kind, full.slice(mark), block.id)
        }
        marks[block.id] = full.length
      }
      this.streamMarks[message.id] = marks
    },

    /** 消息里的工具块 → 操作卡（带参数/结果/状态，比 activity 事件全）。
     *  与所有卡一套：内容不截断，限高 lib/cast.ts 内部滚动看全文。
     *  看图/看视频到成功态：媒体同时归进桌面的图片叠/视频叠 */
    noteToolBlock(conversationID: string, event: ToolEvent | undefined) {
      if (!event?.id) return
      // ask_user 等回答：把参数里的问题解析出来（activity 事件带解析好的 questions，这条是消息补丁的路，
      // 两条路同一个 id 会并到同一张卡）；卡上展开成选项点选，不再是批准/拒绝
      const parsed = event.name === 'ask_user' && event.status === 'awaitingApproval' ? parseAskQuestions(event.arguments ?? '') : []
      this.pushOp({
        id: event.id,
        conversationID,
        title: event.title || event.name || '操作',
        // ask_user 的卡不展示原始 JSON：题面就在下面的面板里，这里只留一句题面摘要
        content: parsed.length ? (parsed[0]?.question ?? '') : (event.arguments ?? ''),
        result: event.result || '',
        status: event.status ?? 'running',
        toolName: event.name ?? '',
        questions: parsed.length ? parsed : undefined
      })
      if (event.status === 'succeeded' && isMediaTool(event.name ?? '')) {
        this.addStackMedia(conversationID, event.name ?? '', event.arguments ?? '')
      }
    },

    /** 会话用到哪类工具，对应窗口立即在桌面打开（已有就置顶）。
 *  只认真正「用」某面板的工具：run_in_terminal / read_terminal 用终端，browse / browser_*
 *  用浏览器，read_file / write_file / edit_file / find_files / search_files / list_directory
 *  这类在文件系统上干活的开文件面板；run_shell、web_search、search_memory、read_agent_log
 *  这些只是拿结果的操作不动文件系统/终端/浏览器，投操作卡即可，不弹面板 */
    noteToolUse(tool: string, conversationID?: string) {
      // 用终端的记下这段会话（autoTerminals）：做完时把自动弹开的终端窗口收起（case 'finished'）
      if (/terminal/i.test(tool)) {
        if (conversationID) this.autoTerminals.add(conversationID)
        this.openWindow('terminals')
      }
      if (/browse/i.test(tool)) this.openWindow('browser')
      if (/file|directory/i.test(tool)) this.openWindow('files')
    },

    /** 上传一个主进程背书的文件，返回服务端路径 */
    async uploadFile(handle: string): Promise<string> {
      if (!this.currentMachine) throw new Error('还没连上机器')
      const result = (await host.request({ type: 'upload.sendFile', machineID: this.currentMachine, handle })) as {
        path: string
      }
      return result.path
    },

    // MARK: 客户端更新（主进程 ClientUpdate；状态在 this.update，平时由推送维护）

    async checkUpdate(): Promise<void> {
      const bridge = window.fridayBridge
      if (!bridge) return
      this.update = { ...this.update, phase: 'checking', error: '' }
      try {
        this.update = await bridge.updateCheck()
      } catch (error) {
        this.update = { ...this.update, phase: 'error', error: error instanceof Error ? error.message : String(error) }
      }
    },

    async installUpdate(): Promise<void> {
      const bridge = window.fridayBridge
      if (!bridge) return
      try {
        this.update = await bridge.updateInstall()
      } catch (error) {
        this.update = { ...this.update, phase: 'error', error: error instanceof Error ? error.message : String(error) }
      }
    },

    /** 推迟自动重启：回到退出时静默安装（桌面浮层的「稍后」） */
    async postponeUpdate(): Promise<void> {
      const bridge = window.fridayBridge
      if (!bridge) return
      try {
        this.update = await bridge.updatePostpone()
      } catch {
        // 推迟失败不打扰：倒计时到点主进程照样会装
      }
    },

    /** 立即安装并重启（桌面浮层的「立即重启」） */
    async applyUpdateNow(): Promise<void> {
      const bridge = window.fridayBridge
      if (!bridge) return
      try {
        this.update = await bridge.updateApply()
      } catch (error) {
        this.update = { ...this.update, phase: 'error', error: error instanceof Error ? error.message : String(error) }
      }
    }
  }
})