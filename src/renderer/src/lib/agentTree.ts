// 子 Agent 树（TeamState.runs → 每个会话一棵）：会话列表行下、沉浸模式背景列表里树状显示用。
// TeamRun.parentKey 指到同一会话里另一个 run.id 的，挂它下面（子 Agent 还能再往下派）；
// 指不到的（会话主 Agent 直接派的——parentKey 是会话根的 key）落回会话下当第一层。

import type { ChatMessage, MessageBlock, TeamRun, ToolEvent } from '../../../protocol/rpc/protocol.js'
import { blockCase, blockPayload } from '../../../protocol/rpc/protocol.js'

/** 树状显示用的一行：子 Agent + 第几层（0 = 会话主 Agent 直接派的） */
export interface AgentRow {
  run: TeamRun
  depth: number
}

/** 同层排序：跑着的在前（还在干活的先看到），其余按派出时间先后 */
function byOrder(a: TeamRun, b: TeamRun): number {
  if (a.running !== b.running) return a.running ? -1 : 1
  return a.started.localeCompare(b.started)
}

/**
 * 一台机器的全部子 Agent，按会话分好组、各自拍平成带层级的行序（深度优先，父在子前）。
 * 没有 子 Agent 的会话不出现在 Map 里。
 */
export function agentTreesByConversation(runs: TeamRun[]): Map<string, AgentRow[]> {
  const groups = new Map<string, TeamRun[]>()
  for (const run of runs) {
    const list = groups.get(run.conversationID)
    if (list) list.push(run)
    else groups.set(run.conversationID, [run])
  }

  const out = new Map<string, AgentRow[]>()
  for (const [conversationID, group] of groups) {
    const ids = new Set(group.map((run) => run.id))
    const childrenOf = new Map<string, TeamRun[]>()
    const roots: TeamRun[] = []
    for (const run of group) {
      if (run.parentKey && ids.has(run.parentKey)) {
        const children = childrenOf.get(run.parentKey)
        if (children) children.push(run)
        else childrenOf.set(run.parentKey, [run])
      } else {
        roots.push(run)
      }
    }

    const rows: AgentRow[] = []
    const walk = (run: TeamRun, depth: number): void => {
      rows.push({ run, depth })
      const children = childrenOf.get(run.id)
      if (children) {
        children.sort(byOrder)
        for (const child of children) walk(child, depth + 1)
      }
    }
    roots.sort(byOrder)
    for (const root of roots) walk(root, 0)
    out.set(conversationID, rows)
  }
  return out
}

/**
 * 只留活着的分支：子 Agent 还在跑的那几条路径，祖先链保留（层级不变），
 * 全跑完的分支整条不显示——背景水印噪音要小（GhostSessions 用）。
 */
export function liveAgentRows(rows: AgentRow[]): AgentRow[] {
  const byID = new Map(rows.map((row) => [row.run.id, row.run]))
  const alive = new Set<string>()
  for (const row of rows) {
    if (!row.run.running) continue
    let current: TeamRun | undefined = row.run
    while (current && !alive.has(current.id)) {
      alive.add(current.id)
      current = current.parentKey ? byID.get(current.parentKey) : undefined
    }
  }
  return rows.filter((row) => alive.has(row.run.id))
}

/**
 * 在会话消息里找某个子 Agent 的工具事件：run.id 即工具事件 id（直接 delegate 的在消息块上），
 * 并行/后台组工具的子 Agent 在组事件 transcript 里（孙层同理递归）。
 * 会话列表点子 Agent 行 → 右栏显示它的运行记录时用它拿 transcript。
 */
export function findAgentEvent(nodes: ChatMessage[], runID: string): ToolEvent | null {
  const search = (blocks: MessageBlock[]): ToolEvent | null => {
    for (const block of blocks) {
      if (blockCase(block) !== 'tool') continue
      const event = blockPayload<ToolEvent>(block, 'tool')
      if (!event) continue
      if (event.id === runID) return event
      if (event.transcript?.length) {
        const found = search(event.transcript)
        if (found) return found
      }
    }
    return null
  }
  for (const node of nodes) {
    const found = search(node.blocks ?? [])
    if (found) return found
  }
  return null
}

/** 子 Agent 此刻在干嘛，一句话短语（AgentsCard 里有带运行时长的详细版） */
export function agentActivityLabel(run: TeamRun): string {
  if (!run.running) return '已结束'
  const activity = run.activity
  if (!activity) return '在想'
  switch (activity.kind) {
    case 'generating':
      return '在生成'
    case 'tool':
      return `在执行「${activity.title}」`
    case 'waitingChildren':
      return '在等子 Agent'
    case 'waitingApproval':
      return `在等确认：${activity.title}`
    default:
      return activity.title || '排队中'
  }
}
