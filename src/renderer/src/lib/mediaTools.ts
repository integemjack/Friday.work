// 会直接内嵌媒体的工具（看图 analyze_image / 看视频 analyze_video）：
// 工具名 → 参数里装媒体路径的字段名 + 媒体类型。toolMedia.ts（取媒体）与
// stores/app.ts（操作卡不自动渐隐）共用，放独立小模块避免 store ↔ composable 循环依赖。
export const TOOL_MEDIA_ARG: Record<string, { field: string; kind: 'image' | 'video' }> = {
  analyze_image: { field: 'image', kind: 'image' },
  analyze_video: { field: 'video', kind: 'video' }
}

/** 这个工具的调用要不要内嵌媒体（看图/看视频） */
export function isMediaTool(name: string): boolean {
  return Boolean(TOOL_MEDIA_ARG[name.toLowerCase()])
}

/** 从工具参数 JSON 里取媒体源（字段名/类型按工具查表）：
 *  不是看图/看视频、参数没流完整或没填媒体路径时返回 null。
 *  toolMedia.ts（渲染内嵌媒体）与 stores/app.ts（成功后归进桌面叠）共用 */
export function mediaArgSource(name: string, args: string | undefined): { kind: 'image' | 'video'; src: string } | null {
  const rule = TOOL_MEDIA_ARG[(name ?? '').toLowerCase()]
  const raw = args?.trim()
  if (!rule || !raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const src = typeof parsed[rule.field] === 'string' ? (parsed[rule.field] as string).trim() : ''
    return src ? { kind: rule.kind, src } : null
  } catch {
    return null // 参数 JSON 还没流完整，等下一块补丁
  }
}
