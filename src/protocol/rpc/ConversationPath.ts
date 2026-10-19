// 会话消息树的当前路径（方案 §5.3：按 parentID + selectedChildren 渲染，节点有多个孩子时切换分支）。
// 纯函数，和 Qt 的 ConversationStore 取当前路径同一套规则。

import type { ChatMessage } from './protocol.js'

export interface BranchInfo {
  /** 当前是第几个（0 起） */
  index: number
  count: number
  siblings: string[]
  /** 父消息 id；根消息是空串 */
  parentKey: string
}

export function conversationPath(
  nodes: ChatMessage[],
  selectedChildren: Record<string, string>
): { path: ChatMessage[]; branches: Record<string, BranchInfo> } {
  const ids = new Set(nodes.map((node) => node.id))
  const byParent = new Map<string, ChatMessage[]>()
  for (const node of nodes) {
    const parent = node.parentID && ids.has(node.parentID) ? node.parentID : ''
    const list = byParent.get(parent) ?? []
    list.push(node)
    byParent.set(parent, list)
  }
  // 同一层按创建时间排（服务端的顺序不保证）
  for (const list of byParent.values()) {
    list.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
  }

  const path: ChatMessage[] = []
  const branches: Record<string, BranchInfo> = {}
  let level = byParent.get('') ?? []
  let parentKey = ''
  while (level.length > 0) {
    const selectedID = selectedChildren[parentKey]
    let index = selectedID ? level.findIndex((node) => node.id === selectedID) : 0
    if (index < 0) index = 0
    const current = level[index]!
    if (level.length > 1) {
      branches[current.id] = {
        index,
        count: level.length,
        siblings: level.map((node) => node.id),
        parentKey
      }
    }
    path.push(current)
    parentKey = current.id
    level = byParent.get(current.id) ?? []
  }
  return { path, branches }
}
