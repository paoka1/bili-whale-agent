// 动态类型、运行状态、工具名的中文显示。她用 log 工具写的类型是自由文本，不认识的原样显示。
type Kind = { label: string; color: string; system?: boolean }
const KINDS: Record<string, Kind> = {
  watch: { label: '看视频', color: 'blue' },
  fav: { label: '收藏', color: 'yellow' },
  share: { label: '分享', color: 'pink' },
  comment: { label: '评论', color: 'grape' },
  reply: { label: '回复', color: 'grape' },
  reply_owner: { label: '回复主人', color: 'grape' },
  reply_draft: { label: '写草稿', color: 'grape' },
  dm: { label: '私信', color: 'grape' },
  wake: { label: '醒来', color: 'teal' },
  diary: { label: '日记', color: 'cyan' },
  'pref-change': { label: '口味调整', color: 'orange' },
  'dry-run': { label: '演练', color: 'gray' },
  run: { label: '运行', color: 'gray', system: true },
  scheduler: { label: '系统', color: 'gray', system: true },
}
export const kindOf = (kind: string): Kind => KINDS[kind] ?? { label: kind, color: 'gray' }

export const RUN_KIND: Record<string, string> = { wake: '定时醒来', manual: '手动唤醒', 'owner-message': '处理主人消息', 'stranger-message': '处理陌生人消息' }
export const RUN_STATUS: Record<string, { label: string; color: string }> = {
  ok: { label: '完成', color: 'green' }, failed: { label: '失败', color: 'red' }, timeout: { label: '超时', color: 'orange' },
  paused: { label: '请求保护暂停', color: 'orange' }, 'login-expired': { label: '登录失效', color: 'red' },
}
const TOOLS: Record<string, string> = {
  feed: '选题', search: '搜索', video_brief: '看视频', video_deep: '深读', comments: '看评论', inbox: '收件箱',
  diary_read: '读日记', quota_status: '查额度', comment_post: '发评论', reply_owner: '回复主人', reply_draft: '写草稿',
  fav: '收藏', dm_owner: '私信主人', diary_write: '写日记', log: '记录',
  diary_append: '追加日记', memory_write: '整理记忆', diary_search: '查旧日记',
}
export const toolLabel = (name: string) => TOOLS[name] ?? name
/** 运行中的进度：连续同名工具合并成「搜索 ×4」，失败的加 ✗ */
export function progressText(calls: { name: string; ok: boolean }[]): string {
  const groups: { name: string; ok: boolean; n: number }[] = []
  for (const c of calls) {
    const last = groups.at(-1)
    if (last && last.name === c.name && last.ok === c.ok) last.n++
    else groups.push({ ...c, n: 1 })
  }
  return groups.map((g) => `${toolLabel(g.name)}${g.n > 1 ? ` ×${g.n}` : ''}${g.ok ? '' : ' ✗'}`).join(' → ')
}
