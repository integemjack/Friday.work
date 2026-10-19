// 消息补丁的应用（v2.3 messagePatch）：与 Qt src/core/remote/MessagePatch.cpp 逐行对齐。
// 应用失败（版本对不上、补丁引用了不存在的块）返回 false，调用方走 message.get 拿整条。

import type { BlocksPatch, ChatMessage, MessageBlock, MessagePatchParams, ToolEvent } from './protocol.js'

/** 线上形状：带关联值的 case 包在 `_0` 里（Swift 枚举 Codable）：`{tool:{_0:{…}}}`、`{text:{_0:"…"}}` */
function unwrapCase(value: unknown): unknown {
  if (value && typeof value === 'object' && '_0' in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>)['_0']
  }
  return value
}

/** 写回时保持原来的包装形式（原来包了 _0 就继续包） */
function wrapLike(original: unknown, value: unknown): unknown {
  if (original && typeof original === 'object' && '_0' in (original as Record<string, unknown>)) {
    return { _0: value }
  }
  return value
}

/** 一层块的补丁应用。返回 false = 打不上（调用方应重新拉整条消息） */
export function applyBlocks(blocks: MessageBlock[], patch: BlocksPatch): boolean {
  const index = new Map<string, number>()
  let order: string[] = []
  for (let i = 0; i < blocks.length; ++i) {
    index.set(blocks[i].id, i)
    order.push(blocks[i].id)
  }

  // 换掉的块（整块的、改了一部分的工具块）
  const replaced = new Map<string, MessageBlock>()
  for (const value of patch.set ?? []) {
    if (value && typeof value === 'object' && typeof (value as MessageBlock).id === 'string') {
      replaced.set((value as MessageBlock).id, value)
    }
  }

  for (const item of patch.tools ?? []) {
    if (!item || typeof item.id !== 'string') return false
    let base: MessageBlock | undefined = replaced.get(item.id)
    if (!base) {
      const at = index.get(item.id)
      if (at !== undefined) base = blocks[at]
    }
    if (!base) return false
    const rawTool = (base.kind as Record<string, unknown>).tool
    const baseTool = unwrapCase(rawTool) as ToolEvent | undefined
    if (!baseTool || typeof baseTool !== 'object') return false

    const event: ToolEvent = { ...baseTool }
    if (item.tool) {
      // 服务端发来的工具字段不带 transcript，保留原有的运行记录
      const incoming = unwrapCase(item.tool) as ToolEvent & { transcript?: unknown }
      const incomingRecord = { ...incoming } as Record<string, unknown>
      delete incomingRecord.transcript
      Object.assign(event, incomingRecord, { transcript: event.transcript })
    }
    if (item.transcript) {
      const transcript: MessageBlock[] = event.transcript ? cloneBlocks(event.transcript) : []
      if (!applyBlocks(transcript, item.transcript)) return false
      event.transcript = transcript
    }
    replaced.set(item.id, { id: base.id, kind: { tool: wrapLike(rawTool, event) } })
  }

  if (patch.ids) order = patch.ids.filter((id): id is string => typeof id === 'string')

  const result: MessageBlock[] = []
  for (const id of order) {
    const swap = replaced.get(id)
    if (swap) {
      result.push(swap)
      continue
    }
    const at = index.get(id)
    if (at === undefined) return false
    result.push(blocks[at])
  }
  blocks.length = 0
  blocks.push(...result)
  return true
}

function cloneBlocks(blocks: MessageBlock[]): MessageBlock[] {
  return blocks.map((block) => ({ id: block.id, kind: { ...(block.kind as object) } as MessageBlock['kind'] }))
}

/** 把一条消息补丁应用到本地消息。fields 是除 blocks 以外的全部字段 */
export function applyMessagePatch(message: ChatMessage, patch: MessagePatchParams): boolean {
  let updated: ChatMessage = message
  if (patch.fields) {
    updated = { ...patch.fields, blocks: message.blocks }
    if (updated.id !== message.id) return false
  }
  const blocks = [...updated.blocks]
  if (patch.blocks && !applyBlocks(blocks, patch.blocks)) return false
  updated = { ...updated, blocks }
  Object.assign(message, updated)
  return true
}
