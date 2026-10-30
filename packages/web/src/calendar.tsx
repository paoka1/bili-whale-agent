// 日记月历：写过日记的日子带圆点，点一天只看那天的日记。自己画格子，不为这一处引入日期组件库。
import { Button, Group, SimpleGrid, Text, UnstyledButton } from '@mantine/core'
import { useState } from 'react'

const pad = (n: number) => String(n).padStart(2, '0')

/** 一个月的格子，周一开头；月初前用 null 补位，其余是 YYYY-MM-DD */
export function monthCells(year: number, month: number): (string | null)[] {
  const blanks = (new Date(year, month - 1, 1).getDay() + 6) % 7
  const days = new Date(year, month, 0).getDate()
  return [...Array<null>(blanks).fill(null), ...Array.from({ length: days }, (_, i) => `${year}-${pad(month)}-${pad(i + 1)}`)]
}

export function DiaryCalendar({ counts, day, onPick }: { counts: Map<string, number>; day: string | null; onPick: (day: string | null) => void }) {
  // 默认停在选中的那天或最近写日记的那个月
  const start = day ?? [...counts.keys()].sort().at(-1) ?? new Date().toLocaleDateString('sv-SE')
  const [ym, setYm] = useState({ year: Number(start.slice(0, 4)), month: Number(start.slice(5, 7)) })
  const shift = (delta: number) => setYm(({ year, month }) => {
    const d = new Date(year, month - 1 + delta, 1)
    return { year: d.getFullYear(), month: d.getMonth() + 1 }
  })
  return (
    <div style={{ maxWidth: 360 }}>
      <Group justify="space-between" mb={4}>
        <Button size="compact-sm" variant="subtle" onClick={() => shift(-1)} fz={22} aria-label="上个月">‹</Button>
        <Text size="sm" fw={500}>{ym.year} 年 {ym.month} 月</Text>
        <Button size="compact-sm" variant="subtle" onClick={() => shift(1)} fz={22} aria-label="下个月">›</Button>
      </Group>
      <SimpleGrid cols={7} spacing={2} verticalSpacing={2}>
        {['一', '二', '三', '四', '五', '六', '日'].map((w) => <Text key={w} size="xs" c="dimmed" ta="center">{w}</Text>)}
        {monthCells(ym.year, ym.month).map((date, i) => {
          if (!date) return <div key={i} />
          const n = counts.get(date) ?? 0
          const label = Number(date.slice(8))
          if (!n) return <Text key={date} size="sm" c="dimmed" ta="center" py={4}>{label}</Text>
          return (
            <UnstyledButton key={date} onClick={() => onPick(day === date ? null : date)} title={`${date} · ${n} 篇`}
              style={{ textAlign: 'center', padding: '4px 0', borderRadius: 6, background: day === date ? 'var(--mantine-color-blue-light)' : undefined }}>
              <Text size="sm" fw={500}>{label}</Text>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--mantine-color-blue-filled)', margin: '1px auto 0' }} />
            </UnstyledButton>
          )
        })}
      </SimpleGrid>
    </div>
  )
}
