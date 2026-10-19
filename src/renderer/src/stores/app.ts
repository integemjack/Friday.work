// 渲染进程的应用状态：机器列表 + 当前会话的完整视图（M1）。
// 会话状态由协议事件维护：conversation（快照）/ message（整条）/ message.patch（增量，打不上拉整条）/ runtime。

import { defineStore } from 'pinia'
import { host, rpc } from '../lib/host.js'
import { applyMessagePatch } from '../../../protocol/rpc/MessagePatcher.js'
import type {
  ActivityEventParams,
  AssistantEntry,
  BlocksPatch,
  BrowserFrameParams,
  BrowserTab,
  ChatMessage,
  Conversation,
  ConversationSummary,
  PendingApproval,
  Runtime,
  SessionActivity,
  TeamRun,
  TerminalInfo
} from '../../../protocol/rpc/protocol.js'
import type { MachineStateInfo } from '../../../shared/api.js'

export interface MessageWithVersion {
  message: Conversation['nodes'][number]
  version: number
}

export interface EngineView {
  id: string
  title: string
  model: string
  kind?: string
  supportsTools?: boolean
  subAgentAllowed?: boolean
  disabled?: boolean
}

export interface ConversationDetail {
  conversationID: string
  /** 消息按显示顺序 */
  messages: MessageWithVersion[]
  runtime: Runtime | null
  versions: Record<string, number>
}

export type WindowKind =
  | 'conversation'
  | 'terminals'
  | 'files'
  | 'browser'
  | 'agents'
  | 'activity'
  | 'machines'
  | 'voice'
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
  /** conversation 窗口：哪一段会话 */
  conversationID?: string
  /** 最大化前的几何 */
  restore?: { x: number; y: number; w: number; h: number }
}

/** 每类窗口的默认大小 */
const WINDOW_SIZE: Record<WindowKind, { w: number; h: number; minW: number; minH: number }> = {
  conversation: { w: 760, h: 580, minW: 420, minH: 340 },
  terminals: { w: 820, h: 500, minW: 420, minH: 260 },
  files: { w: 640, h: 540, minW: 360, minH: 300 },
  browser: { w: 820, h: 620, minW: 420, minH: 320 },
  agents: { w: 580, h: 460, minW: 360, minH: 240 },
  activity: { w: 520, h: 480, minW: 320, minH: 240 },
  machines: { w: 420, h: 560, minW: 320, minH: 280 },
  voice: { w: 520, h: 560, minW: 360, minH: 320 },
  settings: { w: 620, h: 560, minW: 420, minH: 320 }
}

const WINDOW_TITLE: Record<WindowKind, { title: string; icon: string }> = {
  conversation: { title: '会话', icon: '💬' },
  terminals: { title: '终端', icon: '⌨' },
  files: { title: '文件', icon: '🗂' },
  browser: { title: '浏览器', icon: '🌐' },
  agents: { title: '子 Agent', icon: '◈' },
  activity: { title: '活动总览', icon: '◎' },
  machines: { title: '机器与会话', icon: '⛁' },
  voice: { title: '语音', icon: '🎙' },
  settings: { title: '设置', icon: '⚙' }
}

export const useAppStore = defineStore('app', {
  state: () => ({
    machines: [] as MachineStateInfo[],
    currentMachine: '',
    /** 当前机器的会话列表（summaries，hello 时给、summaries 事件更新） */
    summaries: [] as ConversationSummary[],
    /** 每段打开的会话的完整视图（多窗口并存：每段会话一个窗口） */
    details: {} as Record<string, ConversationDetail>,
    /** 当前活动会话（输入框、审批横幅作用在它上面） */
    activeConversationID: '',
    /** 桌面上打开的窗口 */
    windows: [] as DesktopWindow[],
    /** 下一个窗口的层叠高度 */
    nextZ: 10,
    /** 窗口级联计数（新窗口错开摆放） */
    cascade: 0,
    /** 自动安装/升级远程 friday-server 的进度文字 */
    deployStatus: '',
    /** 正在安装/升级服务端 */
    deploying: false,
    /** 启动后是否已尝试自动连接存着的机器 */
    autoConnectDone: false,
    /** 当前机器全部会话的待确认调用（activity 订阅，REMOTE.md §6） */
    approvals: {} as Record<string, PendingApproval[]>,
    /** 这台机器全部会话的实时动静（活动总览的数据源，REMOTE.md §6「会话的实时动静」） */
    activities: {} as Record<string, SessionActivity>,
    /** M2 实时卡片：当前机器的终端 / 浏览器 / 子 Agent 状态 */
    terminals: [] as TerminalInfo[],
    terminalsAvailable: false,
    terminalsReason: '',
    browserTabs: [] as BrowserTab[],
    browserAvailable: false,
    browserReason: '',
    teamRuns: [] as TeamRun[],
    /** 活动的浏览器帧（base64 jpeg）与它的视口 */
    browserFrame: null as { tab: string; data: string; viewport: [number, number] } | null,
    /** 助手日志（assistant.subscribe；M3-A 语音用它看回复） */
    assistantEntries: [] as AssistantEntry[],
    assistantSubscribed: false,
    /** 远端助手开没开（关着时只记日志、不回复，语音窗口要提示） */
    assistantEnabled: false,
    /** 这台机器的引擎（hello 快照 + engines 事件；设置窗口只读展示） */
    engines: [] as EngineView[],
    /** 正在朗读的那条（朗读时界面显示暂停按钮） */
    speakingEntryID: '',
    /** 当前在 watch 的标签（关窗口时 unwatch） */
    watchedTabID: '',
    /** 终端窗口里选中的终端 id */
    activeTerminalID: '',
    /** 文件卡片里选中的文件（null = 只开目录树） */
    activeFile: null as null | { path: string; name: string },
    /** 全局提示（错误横幅） */
    error: ''
  }),

  getters: {
    currentMachineInfo(state): MachineStateInfo | undefined {
      return state.machines.find((machine) => machine.id === state.currentMachine)
    },
    connected(): boolean {
      return this.currentMachineInfo?.state === 'ready'
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
    /** 已订阅 activity 的机器（避免重复订阅） */
    activitySubscribed: new Set<string>(),

    // MARK: 桌面窗口

    /** 开一个窗口（同类型已在就置顶；会话窗口按 conversationID 区分） */
    openWindow(kind: WindowKind, options: { conversationID?: string; title?: string } = {}): string {
      const existing = this.windows.find((item) =>
        kind === 'conversation'
          ? item.kind === kind && item.conversationID === options.conversationID
          : item.kind === kind
      )
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
        z: ++this.nextZ,
        conversationID: options.conversationID
      }
      this.windows.push(item)
      return id
    },

    closeWindow(id: string) {
      const index = this.windows.findIndex((item) => item.id === id)
      if (index < 0) return
      const item = this.windows[index]!
      this.windows.splice(index, 1)
      if (item.kind === 'conversation' && item.conversationID) void this.closeConversation(item.conversationID)
      if (item.kind === 'browser') void this.unwatchBrowser()
    },

    focusWindow(id: string) {
      const item = this.windows.find((entry) => entry.id === id)
      if (!item) return
      item.z = ++this.nextZ
      if (item.minimized) item.minimized = false
      if (item.kind === 'conversation' && item.conversationID) this.activeConversationID = item.conversationID
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

    bindHost() {
      host.onMachines((info) => {
        this.machines = info.machines
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
          if (machine.state === 'ready' && !this.activitySubscribed.has(machine.id)) {
            this.activitySubscribed.add(machine.id)
            this.rpc(machine.id, 'activity.subscribe', {})
              .then((result) => {
                const sessions = (result as { sessions: SessionActivity[] }).sessions ?? []
                for (const session of sessions) {
                  this.activities[session.id] = session
                  this.approvals[session.id] = session.approvals ?? []
                }
              })
              .catch(() => this.activitySubscribed.delete(machine.id))
            if (machine.id === this.currentMachine) {
              void this.refreshLiveState()
              void this.refreshSummaries()
            }
          } else if (machine.state !== 'ready') {
            // 掉线：等重连后重新订阅
            this.activitySubscribed.delete(machine.id)
          }
        }
      })
      host.onEvent((event) => {
        if (event.type !== 'event' || event.machineID !== this.currentMachine) return
        this.applyEvent(event.method, event.params)
      })
      host.onDeployStatus((info) => {
        if (info.machineID === this.currentMachine) this.deployStatus = info.text
      })
    },

    /** 协议方法（透传） */
    rpc(machineID: string, method: string, params?: unknown): Promise<unknown> {
      return rpc(machineID, method, params)
    },

    // MARK: 机器

    async addMachine(target: string, name?: string, identityFile?: string) {
      await host.request({ type: 'machines.add', target, name, identityFile })
    },

    /** 密码添加（M4）：主进程/协议进程一次性装公钥，密码不落盘 */
    async addMachineWithPassword(target: string, password: string, name?: string) {
      await host.request({ type: 'machines.addWithPassword', target, password, name })
    },

    async removeMachine(id: string) {
      await host.request({ type: 'machines.remove', id })
      if (this.currentMachine === id) {
        this.currentMachine = ''
        this.summaries = []
        this.details = {}
        this.activeConversationID = ''
      }
    },

    async selectMachine(id: string) {
      if (this.currentMachine === id) return
      await this.leaveConversation()
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

    resetLiveState() {
      this.terminals = []
      this.terminalsAvailable = false
      this.terminalsReason = ''
      this.browserTabs = []
      this.browserAvailable = false
      this.browserReason = ''
      this.teamRuns = []
      this.browserFrame = null
      this.activeTerminalID = ''
      this.activeFile = null
      this.activities = {}
      this.approvals = {}
    },

    /** 取当前机器的终端/浏览器/子 Agent 状态（hello 快照 + 事件维护，切换/重连后调） */
    async refreshLiveState() {
      if (!this.currentMachine) return
      try {
        const state = (await host.request({ type: 'state.get', machineID: this.currentMachine })) as {
          terminals: { terminals: TerminalInfo[]; available: boolean; reason?: string }
          browser: { tabs: BrowserTab[]; available: boolean; reason?: string }
          team: { runs: TeamRun[] }
          engines?: EngineView[]
        }
        this.engines = state.engines ?? []
        this.terminals = state.terminals?.terminals ?? []
        this.terminalsAvailable = state.terminals?.available ?? false
        this.terminalsReason = state.terminals?.reason ?? ''
        this.browserTabs = state.browser?.tabs ?? []
        this.browserAvailable = state.browser?.available ?? false
        this.browserReason = state.browser?.reason ?? ''
        this.teamRuns = state.team?.runs ?? []
        if (!this.activeTerminalID && this.terminals.length > 0) {
          this.activeTerminalID = this.terminals[0]!.id
        }
      } catch {
        // 没连上时忽略
      }
    },

    /** 开始看某个标签的画面（browser.watch，方案 §5.6） */
    async watchBrowser(tabID?: string) {
      const tab =
        (tabID ? this.browserTabs.find((item) => item.id === tabID) : undefined) ??
        this.browserTabs.find((item) => item.conversationID === this.activeConversationID) ??
        this.browserTabs[0]
      if (!tab || !this.currentMachine) return
      try {
        await rpc(this.currentMachine, 'browser.watch', { tab: tab.id, width: 1280, height: 800 })
        this.watchedTabID = tab.id
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      }
    },

    /** 停止推送画面（浏览器窗口关掉时） */
    async unwatchBrowser() {
      if (!this.watchedTabID || !this.currentMachine) return
      const tab = this.watchedTabID
      this.watchedTabID = ''
      this.browserFrame = null
      await rpc(this.currentMachine, 'browser.unwatch', { tab }).catch(() => {})
    },

    async connectMachine(id: string) {
      await host.request({ type: 'machines.connect', id })
    },

    /** 自动安装/升级远程 friday-server（M4）；返回一句话结果 */
    async ensureServer(id: string): Promise<string> {
      this.deployStatus = '正在查看远程的 Friday 服务端…'
      try {
        const result = (await host.request({ type: 'machines.ensureServer', id })) as {
          action?: string
          message?: string
        }
        return result.message ?? '完成'
      } finally {
        this.deployStatus = ''
      }
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

    /** 打开一段会话：订阅拿整段，并在桌面上开一个窗口（已在就置顶） */
    async openConversation(conversationID: string) {
      if (!this.currentMachine) return
      // 已在就置顶
      const existing = this.windows.find(
        (item) => item.kind === 'conversation' && item.conversationID === conversationID
      )
      if (existing) {
        this.activeConversationID = conversationID
        this.focusWindow(existing.id)
        return
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
          runtime: payload.runtime ?? null,
          versions: { ...(payload.versions ?? {}) }
        }
        this.activeConversationID = conversationID
        const summary = this.summaries.find((item) => item.id === conversationID)
        this.openWindow('conversation', {
          conversationID,
          title: summary?.title || conversation.title || '会话'
        })
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      }
    },

    /** 关掉一段会话（窗口关闭时调）：退订、清状态 */
    async closeConversation(conversationID: string) {
      if (this.currentMachine) {
        await host
          .request({ type: 'conversations.unsubscribe', machineID: this.currentMachine, conversationID })
          .catch(() => {})
      }
      delete this.details[conversationID]
      if (this.activeConversationID === conversationID) {
        this.activeConversationID = this.windows.find((item) => item.kind === 'conversation')?.conversationID ?? ''
      }
    },

    async leaveConversation() {
      for (const conversationID of Object.keys(this.details)) {
        await this.closeConversation(conversationID)
      }
    },

    /** 新建会话并打开。注意：服务端会规范化 id（转大写存储），必须用回执里的 id，后续事件的 id 都以它为准 */
    async createConversation() {
      if (!this.currentMachine) return
      try {
        const id = crypto.randomUUID()
        const result = (await rpc(this.currentMachine, 'conversation.create', { id })) as { id: string }
        const canonicalID = result.id ?? id
        await this.openConversation(canonicalID)
        await this.refreshSummaries()
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
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
            case 'started':
              next.status = 'running'
              break
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
              if (tool) next.currentTool = { tool: tool.tool ?? '', title: tool.title ?? '', summary: tool.summary ?? '' }
              break
            }
            case 'approval': {
              const list = evt.approvals ?? []
              next.approvals = list
              this.approvals[evt.conversationID] = list
              next.status = list.length ? 'approval' : 'running'
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
          this.terminals = state.terminals ?? []
          this.terminalsAvailable = state.available
          this.terminalsReason = state.reason ?? ''
          // Agent 用 run_in_terminal 开的新终端：一出现就选中并打开卡片（方案 §5.4）
          const fresh = this.terminals.find((terminal) => !before.has(terminal.id) && terminal.command)
          if (fresh) {
            this.activeTerminalID = fresh.id
            this.openWindow('terminals')
          } else if (!this.activeTerminalID && this.terminals.length > 0) {
            this.activeTerminalID = this.terminals[0]!.id
          }
          break
        }
        case 'browser': {
          const state = params as { available: boolean; reason?: string; tabs: BrowserTab[] }
          this.browserTabs = state.tabs ?? []
          this.browserAvailable = state.available
          this.browserReason = state.reason ?? ''
          break
        }
        case 'browser.frame': {
          const frame = params as BrowserFrameParams
          this.browserFrame = { tab: frame.tab, data: frame.data, viewport: frame.viewport }
          break
        }
        case 'browser.handOver': {
          // 智能体请用户在浏览器里做事：打开浏览器窗口（方案 §5.6）
          this.openWindow('browser')
          void this.watchBrowser()
          break
        }
        case 'team': {
          this.teamRuns = (params as { runs: TeamRun[] }).runs ?? []
          break
        }
        case 'engines': {
          const state = params as { engines?: EngineView[] }
          this.engines = state.engines ?? []
          break
        }
        // 助手日志（M3-A 语音）：流式的同一条合并，定稿了新回复念出来
        case 'assistant.entry': {
          const entry = (params as { entry?: AssistantEntry }).entry
          if (!entry) break
          const index = this.assistantEntries.findIndex((item) => item.id === entry.id)
          if (index >= 0) this.assistantEntries[index] = entry
          else this.assistantEntries.push(entry)
          if (entry.kind === 'assistant' && !entry.streaming && !entry.data?.silent && entry.text.trim()) {
            this.speakEntry(entry)
          }
          break
        }
        case 'assistant.reset': {
          this.assistantEntries = []
          this.assistantSubscribed = false
          break
        }
        case 'assistant.state': {
          const state = (params as { state?: { enabled?: boolean } }).state
          if (state) this.assistantEnabled = state.enabled ?? false
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
      if (snapshot.partial) {
        // partial：按前缀合并（REMOTE.md §5）——本地前缀一致的部分保留，后面整体换掉；版本用它带的
        const local = detail.messages.map((entry) => entry.message)
        const incoming = snapshot.conversation.nodes
        let split = 0
        const limit = Math.min(local.length, incoming.length)
        while (split < limit && local[split]!.id === incoming[split]!.id) split += 1
        const messages: MessageWithVersion[] = local.slice(0, split).map((message) => ({
          message,
          version: versions[message.id] ?? 0
        }))
        for (const message of incoming.slice(split)) {
          messages.push({ message, version: versions[message.id] ?? 0 })
        }
        detail.messages = messages
      } else {
        detail.messages = snapshot.conversation.nodes.map((message) => ({
          message,
          version: versions[message.id] ?? 0
        }))
      }
      detail.versions = versions
      // 标题跟着更新（会话窗口标题）
      const window = this.windows.find(
        (item) => item.kind === 'conversation' && item.conversationID === snapshot.conversation.id
      )
      if (window && snapshot.conversation.title) window.title = snapshot.conversation.title
    },

    applyWholeMessage(params: unknown) {
      const payload = params as { conversationID: string; message: ChatMessage; version?: number }
      const detail = this.details[payload.conversationID]
      if (!detail) return
      const version = payload.version ?? 0
      const index = detail.messages.findIndex((entry) => entry.message.id === payload.message.id)
      if (index >= 0) {
        detail.messages[index] = { message: payload.message, version }
      } else {
        detail.messages.push({ message: payload.message, version })
      }
      detail.versions[payload.message.id] = version
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
      const entry = detail.messages.find((candidate) => candidate.message.id === patch.messageID)
      if (!entry || entry.version !== patch.base) {
        void this.refetchMessage(patch.messageID, patch.conversationID)
        return
      }
      const applied = applyMessagePatch(entry.message, {
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
      entry.version = patch.version
      detail.versions[patch.messageID] = patch.version
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
        const index = detail.messages.findIndex((entry) => entry.message.id === messageID)
        if (index >= 0) detail.messages[index] = { message: result.message, version: result.version }
        detail.versions[messageID] = result.version
      } catch {
        // 拉不到就先不动（下一条补丁/快照会再对齐）
      }
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

    async resolveApproval(eventID: string, approved: boolean) {
      if (!this.currentMachine) return
      await rpc(this.currentMachine, 'runner.resolveApproval', { eventID, approved })
    },

    async stopRunner(conversationID?: string) {
      const target = conversationID ?? this.activeConversationID
      if (!this.currentMachine || !target) return
      await rpc(this.currentMachine, 'runner.stop', { conversationID: target })
    },

    /** 朗读一条助手回复（M3-A，方案 §6.1；用系统语音，打断 = cancel） */
    speakEntry(entry: AssistantEntry) {
      if (typeof speechSynthesis === 'undefined' || !entry.text.trim()) return
      speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(entry.text)
      utterance.lang = 'zh-CN'
      utterance.rate = 1.05
      utterance.onend = () => {
        if (this.speakingEntryID === entry.id) this.speakingEntryID = ''
      }
      this.speakingEntryID = entry.id
      speechSynthesis.speak(utterance)
    },

    stopSpeaking() {
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
      this.speakingEntryID = ''
    },

    /** 上传一个主进程背书的文件，返回服务端路径 */
    async uploadFile(handle: string): Promise<string> {
      if (!this.currentMachine) throw new Error('还没连上机器')
      const result = (await host.request({ type: 'upload.sendFile', machineID: this.currentMachine, handle })) as {
        path: string
      }
      return result.path
    }
  }
})