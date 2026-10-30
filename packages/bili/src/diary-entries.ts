// 日记条目只是一份原文的视图；不改写旧文件，序号也不受展示排序影响。
export type DiaryWhich = 'public' | 'private'
export type DiaryEntry = {
  id: string; which: DiaryWhich; index: number; date: string | null
  title: string; markdown: string; bvids: string[]
}

/** 只识别围栏外的一、二级标题，保留原文件中的字符位置。 */
export function scanDiary(markdown: string) {
  const headings: { offset: number; level: number; title: string }[] = []
  let fence: { marker: string; length: number } | null = null
  for (const match of markdown.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0].replace(/\r?\n$/, '')
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null
      continue
    }
    if (marker) {
      fence = { marker: marker[1]![0]!, length: marker[1]!.length }
      continue
    }
    const heading = /^(#{1,2}) (.*)$/.exec(line)
    if (heading) headings.push({ offset: match.index!, level: heading[1]!.length, title: heading[2]!.trim() })
  }
  return { headings, openFence: fence !== null }
}

function validDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

export function parseDiary(which: DiaryWhich, markdown: string): DiaryEntry[] {
  if (!markdown) return []
  const headings = scanDiary(markdown).headings.filter((h) => h.level === 2)
  const starts = headings[0]?.offset === 0 ? headings : [{ offset: 0, level: 0, title: '' }, ...headings]
  return starts.map((heading, index) => {
    const text = markdown.slice(heading.offset, starts[index + 1]?.offset)
    const dated = /^(\d{4}-\d{2}-\d{2}) · (.*)$/.exec(heading.title)
    const date = dated && validDate(dated[1]!) ? dated[1]! : null
    const title = heading.level === 0
      ? Array.from(text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '序言').slice(0, 60).join('')
      : date ? dated![2]! : heading.title
    return { id: `${which}:${index}`, which, index, date, title, markdown: text,
      bvids: [...new Set(text.match(/BV[0-9A-Za-z]{10}/g) ?? [])] }
  })
}

function timeOf(title: string): number {
  const time = /(\d{1,2}):(\d{2})/.exec(title)
  if (time) return Number(time[1]) * 60 + Number(time[2])
  if (/晚|夜/.test(title)) return 20 * 60
  if (/午/.test(title) && !/上午/.test(title)) return 12 * 60
  if (/早|上午/.test(title)) return 8 * 60
  return -1
}

export function sortEntries(entries: DiaryEntry[]): DiaryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.date !== b.date) return (b.date ?? '').localeCompare(a.date ?? '')
    if (a.date) {
      const time = timeOf(b.title) - timeOf(a.title)
      if (time) return time
    }
    // 两本之间公开在前；同一本里按文件顺序（旧日记越靠前越新）
    return a.which !== b.which ? (a.which === 'public' ? -1 : 1) : a.index - b.index
  })
}
