// 顶部状态 + 立即唤醒；她最近的信；待审草稿；动态 / 运行记录 / 两本日记。每 15 秒刷新一次。
import { Alert, Anchor, Badge, Button, Group, Loader, Paper, SimpleGrid, Spoiler, Stack, Tabs, Text, Textarea, Timeline, Title, Typography } from '@mantine/core'
import { useCallback, useEffect, useState } from 'react'
import { api, type Draft, type LogEntry, type RunRecord, type Status, type WriteResult } from '../api'
import { Markdown } from '../components/Markdown'
import { kindOf, RUN_KIND, RUN_STATUS, toolLabel } from '../labels'

/** 按服务器时区显示，作息也按它算 */
const timeIn = (zone: string, value: number | string, withDate = false) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false, ...(withDate ? { month: 'numeric', day: 'numeric' } : {}),
}).format(new Date(value))
const PAGE = 20 // 动态每次显示的条数，太长翻不到底
const RUN_PAGE = 10

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
  const [shown, setShown] = useState(PAGE)
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [runsShown, setRunsShown] = useState(RUN_PAGE)

  const refresh = useCallback(() => {
    Promise.all([
      api<Status>('/api/status').then(setStatus),
      api<Draft[]>('/api/drafts').then(setDrafts),
      api<LogEntry[]>('/api/activity?limit=500').then((rows) => setLog(rows.reverse())),
      api<RunRecord[]>('/api/runs?limit=200').then((rows) => setRuns(rows.reverse())),
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

  const resume = async () => {
    try { await api('/api/traffic/resume', 'POST'); setNotice('已恢复请求'); refresh() } catch (e) { setError((e as Error).message) }
  }

  if (!status) return error ? <Alert color="red">{error}</Alert> : <Loader />
  const zone = status.timezone
  const { share, favorites, traffic } = status.quota
  // 醒来写的最后一段话就是给主人的信；处理消息的运行最后只是处理说明，不算信
  const letter = runs.find((r) => (r.kind === 'wake' || r.kind === 'manual') && r.status === 'ok' && r.finalText.trim())
  return (
    <Stack>
      <Paper withBorder p="md">
        <Group justify="space-between" align="start">
          <Stack gap={4}>
            <Group gap="xs">
              <Title order={4}>{status.running ? `醒着：${RUN_KIND[status.running] ?? status.running}` : '睡着'}</Title>
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
        {traffic.reason && (
          <Alert color="orange" mt="sm">
            <Text size="sm">请求保护已暂停{traffic.pausedUntil ? `（到 ${timeIn(zone, traffic.pausedUntil, true)}）` : ''}：{traffic.reason}</Text>
            <Text size="xs" c="dimmed" mt={4}>登录失效就到配置页重新扫码；要过验证码就先在 B 站上用这个号处理完，再点下面的按钮。</Text>
            <Button size="xs" variant="light" color="orange" mt="xs" onClick={resume}>已处理，恢复请求</Button>
          </Alert>
        )}
      </Paper>
      {notice && <Alert color="blue" withCloseButton onClose={() => setNotice('')}>{notice}</Alert>}
      {error && <Alert color="red">{error}</Alert>}

      {letter && (
        <Paper withBorder p="md">
          <Group justify="space-between" mb="xs">
            <Title order={5}>她最近的信</Title>
            <Text size="xs" c="dimmed">{RUN_KIND[letter.kind] ?? letter.kind} · {timeIn(zone, letter.endedAt, true)}</Text>
          </Group>
          <Spoiler maxHeight={180} showLabel="展开" hideLabel="收起">
            <Typography><Markdown source={letter.finalText} /></Typography>
          </Spoiler>
        </Paper>
      )}

      {drafts.length > 0 && (
        <Paper withBorder p="md">
          <Title order={5} mb="sm">待审回复（{drafts.length}）</Title>
          <Stack>{drafts.map((d) => <DraftCard key={d.id} draft={d} onDone={refresh} />)}</Stack>
        </Paper>
      )}

      {/* 动态和日记放在同一张卡片的分页签里：动态再长也不会把日记挤到页面最底下 */}
      <Paper withBorder p="md">
        <Tabs defaultValue="log">
          <Tabs.List>
            <Tabs.Tab value="log">动态</Tabs.Tab>
            <Tabs.Tab value="runs">运行记录</Tabs.Tab>
            <Tabs.Tab value="public">日记</Tabs.Tab>
            <Tabs.Tab value="private">私人日记</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="log" pt="md">
            {log.length === 0 ? <Text size="sm" c="dimmed">还没有活动</Text> : (
              <>
                <Timeline bulletSize={12} lineWidth={2}>
                  {log.slice(0, shown).map((e, i) => {
                    const kind = kindOf(e.kind)
                    // 系统记录（运行摘要、监听失败等）淡显，不盖过她自己的动态
                    return (
                      <Timeline.Item key={i} color={kind.color} opacity={kind.system ? 0.55 : 1}
                        title={<Group gap="xs"><Badge size="sm" variant="light" color={kind.color}>{kind.label}</Badge>{!kind.system && <Target value={e.target} />}</Group>}>
                        <Text size={kind.system ? 'xs' : 'sm'} className="pre-line">{e.note}</Text>
                        <Text size="xs" c="dimmed">{timeIn(zone, e.at, true)}</Text>
                      </Timeline.Item>
                    )
                  })}
                </Timeline>
                <Group mt="md" gap="xs">
                  {shown < log.length && <Button size="xs" variant="light" onClick={() => setShown(shown + PAGE)}>再看 {Math.min(PAGE, log.length - shown)} 条（共 {log.length} 条）</Button>}
                  {shown > PAGE && <Button size="xs" variant="subtle" onClick={() => setShown(PAGE)}>收起</Button>}
                </Group>
              </>
            )}
          </Tabs.Panel>
          <Tabs.Panel value="runs" pt="md">
            {runs.length === 0 ? <Text size="sm" c="dimmed">还没有运行过</Text> : (
              <Stack gap="sm">
                {runs.slice(0, runsShown).map((r) => <RunCard key={r.id} run={r} zone={zone} />)}
                <Group gap="xs">
                  {runsShown < runs.length && <Button size="xs" variant="light" onClick={() => setRunsShown(runsShown + RUN_PAGE)}>再看 {Math.min(RUN_PAGE, runs.length - runsShown)} 次（共 {runs.length} 次）</Button>}
                  {runsShown > RUN_PAGE && <Button size="xs" variant="subtle" onClick={() => setRunsShown(RUN_PAGE)}>收起</Button>}
                </Group>
              </Stack>
            )}
          </Tabs.Panel>
          {(['public', 'private'] as const).map((which) => (
            <Tabs.Panel key={which} value={which} pt="md">
              {diaries?.[which].trim() ? <Typography><Markdown source={diaries[which]} /></Typography> : <Text size="sm" c="dimmed">还没写</Text>}
            </Tabs.Panel>
          ))}
        </Tabs>
      </Paper>
    </Stack>
  )
}

/** 一次运行：类型、状态、用时、调用了哪些工具（失败的标红）、报错与最后的话 */
function RunCard({ run, zone }: { run: RunRecord; zone: string }) {
  const status = RUN_STATUS[run.status] ?? { label: run.status, color: 'gray' }
  const minutes = Math.max(0, Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 6000) / 10)
  return (
    <Paper withBorder p="sm">
      <Group gap="xs">
        <Text size="sm" fw={500}>{RUN_KIND[run.kind] ?? run.kind}</Text>
        <Badge size="sm" color={status.color} variant="light">{status.label}</Badge>
        <Text size="xs" c="dimmed">{timeIn(zone, run.startedAt, true)} · {minutes} 分钟 · {run.steps} 步{run.draftsAdded ? ` · 新草稿 ${run.draftsAdded}` : ''}</Text>
      </Group>
      {run.toolCalls.length > 0 && (
        <Group gap={4} mt={6}>
          {run.toolCalls.map((t, i) => <Badge key={i} size="xs" variant={t.ok ? 'default' : 'filled'} color={t.ok ? 'gray' : 'red'}>{toolLabel(t.name)}{t.ok ? '' : ' ✗'}</Badge>)}
        </Group>
      )}
      {run.error && <Text size="xs" c="red" mt={6}>{run.error}</Text>}
      {run.finalText.trim() && (
        <Spoiler maxHeight={60} showLabel="展开" hideLabel="收起" mt={6}>
          <Text size="xs" c="dimmed" className="pre-line">{run.finalText}</Text>
        </Spoiler>
      )}
    </Paper>
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
