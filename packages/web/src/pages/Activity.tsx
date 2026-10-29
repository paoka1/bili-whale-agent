// 顶部状态 + 立即唤醒；待审草稿；动态时间线；两本日记。每 15 秒刷新一次。
import { Alert, Anchor, Badge, Button, Group, Loader, Paper, SimpleGrid, Stack, Tabs, Text, Textarea, Timeline, Title, Typography } from '@mantine/core'
import { useCallback, useEffect, useState } from 'react'
import { api, type Draft, type LogEntry, type Status, type WriteResult } from '../api'
import { Markdown } from '../components/Markdown'

/** 按服务器时区显示，作息也按它算 */
const timeIn = (zone: string, value: number | string, withDate = false) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false, ...(withDate ? { month: 'numeric', day: 'numeric' } : {}),
}).format(new Date(value))
const KIND: Record<string, string> = { wake: '定时醒来', manual: '手动唤醒', 'owner-message': '处理主人消息', 'stranger-message': '处理陌生人消息' }

/** 活动里的 BV 号链接到视频页（target 形如 BV1… 或 BV:BV1…） */
function Target({ value }: { value: string | null }) {
  const bv = value?.match(/BV[0-9A-Za-z]{10}/)?.[0]
  if (bv) return <Anchor href={`https://www.bilibili.com/video/${bv}`} target="_blank" rel="noopener noreferrer" size="xs">{bv}</Anchor>
  return value ? <Text span size="xs" c="dimmed">{value}</Text> : null
}

export function Activity() {
  const [status, setStatus] = useState<Status | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [log, setLog] = useState<LogEntry[]>([])
  const [diaries, setDiaries] = useState<{ public: string; private: string } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(() => {
    Promise.all([
      api<Status>('/api/status').then(setStatus),
      api<Draft[]>('/api/drafts').then(setDrafts),
      api<LogEntry[]>('/api/activity?limit=100').then((rows) => setLog(rows.reverse())),
      api<{ public: string; private: string }>('/api/diaries').then(setDiaries),
    ]).then(() => setError('')).catch((e) => setError((e as Error).message))
  }, [])
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 15_000)
    return () => clearInterval(timer)
  }, [refresh])

  const wake = async () => {
    try {
      const r = await api<{ queued: boolean }>('/api/wake', 'POST')
      setNotice(r.queued ? '她正在忙，已排队，忙完就醒' : '已叫醒她')
      refresh()
    } catch (e) { setError((e as Error).message) }
  }

  if (!status) return error ? <Alert color="red">{error}</Alert> : <Loader />
  const zone = status.timezone
  const { share, favorites, traffic } = status.quota
  return (
    <Stack>
      <Paper withBorder p="md">
        <Group justify="space-between" align="start">
          <Stack gap={4}>
            <Group gap="xs">
              <Title order={4}>{status.running ? `醒着：${KIND[status.running] ?? status.running}` : '睡着'}</Title>
              {status.dryRun && <Badge color="yellow">演练模式</Badge>}
              {status.queue.length > 0 && <Badge variant="light">排队 {status.queue.length}</Badge>}
            </Group>
            <Text size="sm" c="dimmed">服务器时间 {timeIn(zone, status.serverTime)}（{zone}）</Text>
            <Text size="sm">下次醒来：{status.nextWakeAt ? `${timeIn(zone, status.nextWakeAt, true)}（${status.nextWindow}）` : '今天没有了'}</Text>
            {status.lastRunAt && <Text size="sm">上次醒来：{timeIn(zone, status.lastRunAt, true)}</Text>}
          </Stack>
          <Button onClick={wake}>立即唤醒</Button>
        </Group>
        <SimpleGrid cols={{ base: 2, sm: 4 }} mt="sm">
          <Text size="sm">分享 {share.used}/{share.enabled ? share.configuredDaily : '已关'}</Text>
          <Text size="sm">收藏 {favorites.used}/{favorites.daily}</Text>
          <Text size="sm">今日请求 读 {traffic.readDay} · 写 {traffic.writeDay}</Text>
        </SimpleGrid>
        {traffic.reason && <Alert color="orange" mt="sm">请求保护已暂停{traffic.pausedUntil ? `（到 ${timeIn(zone, traffic.pausedUntil, true)}）` : ''}：{traffic.reason}</Alert>}
      </Paper>
      {notice && <Alert color="blue" withCloseButton onClose={() => setNotice('')}>{notice}</Alert>}
      {error && <Alert color="red">{error}</Alert>}

      {drafts.length > 0 && (
        <Paper withBorder p="md">
          <Title order={5} mb="sm">待审回复（{drafts.length}）</Title>
          <Stack>{drafts.map((d) => <DraftCard key={d.id} draft={d} onDone={refresh} />)}</Stack>
        </Paper>
      )}

      <Paper withBorder p="md">
        <Title order={5} mb="sm">动态</Title>
        {log.length === 0 ? <Text size="sm" c="dimmed">还没有活动</Text> : (
          <Timeline bulletSize={12} lineWidth={2}>
            {log.map((e, i) => (
              <Timeline.Item key={i} title={<Group gap="xs"><Text size="sm" fw={500}>{e.kind}</Text><Target value={e.target} /></Group>}>
                <Text size="sm" className="pre-line">{e.note}</Text>
                <Text size="xs" c="dimmed">{timeIn(zone, e.at, true)}</Text>
              </Timeline.Item>
            ))}
          </Timeline>
        )}
      </Paper>

      {diaries && (
        <Paper withBorder p="md">
          <Tabs defaultValue="public">
            <Tabs.List>
              <Tabs.Tab value="public">日记</Tabs.Tab>
              <Tabs.Tab value="private">私人日记</Tabs.Tab>
            </Tabs.List>
            {(['public', 'private'] as const).map((which) => (
              <Tabs.Panel key={which} value={which} pt="md">
                {diaries[which].trim() ? <Typography><Markdown source={diaries[which]} /></Typography> : <Text size="sm" c="dimmed">还没写</Text>}
              </Tabs.Panel>
            ))}
          </Tabs>
        </Paper>
      )}
    </Stack>
  )
}

function DraftCard({ draft, onDone }: { draft: Draft; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)
  const act = async (approve: boolean) => {
    setBusy(true)
    try {
      if (approve) {
        const r = await api<WriteResult>(`/api/drafts/${draft.id}/approve`, 'POST')
        setResult(r.status === 'dry-run' ? '演练模式：没有真的发出，草稿保留' : '已发出')
      } else {
        await api(`/api/drafts/${draft.id}/reject`, 'POST', { reason })
      }
      onDone()
    } catch (e) { setResult((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Paper withBorder p="sm">
      <Group gap="xs" mb={4}><Text size="sm" fw={500}>回复 {draft.who}</Text><Target value={draft.bvid} /></Group>
      <Text size="xs" c="dimmed" className="pre-line">原评论：{draft.src}</Text>
      <Text size="sm" mt={4} className="pre-line">{draft.message}</Text>
      <Group mt="xs" align="end">
        <Button size="xs" onClick={() => act(true)} loading={busy}>发</Button>
        <Textarea size="xs" placeholder="不发的理由（可选，仅记录）" autosize minRows={1} style={{ flex: 1 }} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        <Button size="xs" variant="default" onClick={() => act(false)} loading={busy}>不发</Button>
      </Group>
      {result && <Text size="xs" mt={4}>{result}</Text>}
    </Paper>
  )
}
