// 会直接内嵌媒体的工具（看图 analyze_image / 看视频 analyze_video / 听录音 transcribe_audio）：
// 工具名 → 参数里装媒体路径的字段名 + 媒体类型。toolMedia.ts（取媒体）与
// stores/app.ts（成功后归进附件面板）共用，放独立小模块避免 store ↔ composable 循环依赖。
export type MediaArgKind = 'image' | 'video' | 'audio'

export const TOOL_MEDIA_ARG: Record<string, { field: string; kind: MediaArgKind }> = {
  analyze_image: { field: 'image', kind: 'image' },
  analyze_video: { field: 'video', kind: 'video' },
  transcribe_audio: { field: 'audio', kind: 'audio' }
}

/** 这个工具的调用要不要内嵌媒体（看图/看视频/听录音） */
export function isMediaTool(name: string): boolean {
  return Boolean(TOOL_MEDIA_ARG[name.toLowerCase()])
}

/** 从工具参数 JSON 里取媒体源（字段名/类型按工具查表）：
 *  不是看图/看视频/听录音、参数没流完整或没填媒体路径时返回 null。
 *  toolMedia.ts（渲染内嵌媒体）与 stores/app.ts（成功后归进附件面板）共用 */
export function mediaArgSource(name: string, args: string | undefined): { kind: MediaArgKind; src: string } | null {
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
