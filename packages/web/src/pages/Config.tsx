// 一页表单：保存即生效（监听地址 / 端口要重启）。key 只写不回显，随「保存配置」一起保存。
import {
  Accordion, ActionIcon, Alert, Button, Checkbox, Divider, Group, Loader, NumberInput, Paper, PasswordInput,
  SegmentedControl, Select, SimpleGrid, Stack, Switch, TagsInput, Text, Textarea, TextInput, Title,
} from '@mantine/core'
import { useEffect, useState, type ReactNode } from 'react'
import { api, configPayload, listenReadsPerDay, type AppConfig, type ConfigResponse } from '../api'
import { BiliAccount } from '../components/BiliAccount'

const num = (v: string | number) => (v === '' ? 0 : Number(v))
type Section = Exclude<keyof AppConfig, 'dryRun'>

// 页面很长：顶部一排导航跳到对应分块；scrollMarginTop 让出固定顶栏和导航条的高度
const SECTIONS = ['模型', 'B 站账号', '主人', '她是谁', '口味', '作息', '分享与推送', '监听', '高级']
const sectionId = (title: string) => `sec-${SECTIONS.indexOf(title)}`
// 监听间隔按分钟给几档；存的仍是秒数，字段名沿用 commentIntervalSec，私信监听也用它
const INTERVALS = [1, 3, 5, 10].map((m) => ({ value: String(m * 60), label: `${m} 分钟` }))

function Block({ title, children }: { title: string; children: ReactNode }) {
  return <Paper withBorder p="md" id={sectionId(title)} style={{ scrollMarginTop: 120 }}><Stack gap="sm"><Title order={5}>{title}</Title>{children}</Stack></Paper>
}

export function Config({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [data, setData] = useState<ConfigResponse | null>(null)
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [persona, setPersona] = useState('')
  const [keys, setKeys] = useState({ llmApiKey: '', visionApiKey: '' })
  const [notice, setNotice] = useState<{ color: string; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [advanced, setAdvanced] = useState<string | null>(null)

  const load = () => api<ConfigResponse>('/api/config').then((r) => { setData(r); setCfg(r.config); setPersona(r.persona) })
    .catch((e) => setNotice({ color: 'red', text: (e as Error).message }))
  useEffect(() => { load() }, [])

  if (!cfg || !data) return notice ? <Alert color={notice.color}>{notice.text}</Alert> : <Loader />
  const set = <K extends Section>(key: K, patch: Partial<AppConfig[K]>) => setCfg({ ...cfg, [key]: { ...cfg[key], ...patch } })
  const windows = cfg.night.windows
  const setWindow = (i: number, patch: Partial<AppConfig['night']['windows'][number]>) =>
    set('night', { windows: windows.map((w, j) => (j === i ? { ...w, ...patch } : w)) })
  const interval = cfg.listen.commentIntervalSec
  const listening = cfg.listen.dm || cfg.listen.comment
  const reads = listenReadsPerDay(cfg.listen)
  const listenHint = !listening ? '两项都关着，不检查。' : [
    INTERVALS.some((o) => o.value === String(interval)) ? '' : `当前是自定义的 ${interval} 秒，选一档会替换它。`,
    `有新消息最慢约 ${interval % 60 ? `${interval} 秒` : `${interval / 60} 分钟`}处理；监听每天约读 ${reads} 次`,
    cfg.risk.readDaily > 0 ? `，占每日读取上限 ${cfg.risk.readDaily} 次的 ${Math.round(reads / cfg.risk.readDaily * 100)}%。` : '。',
  ].join('')

  const save = async () => {
    setSaving(true)
    setNotice(null)
    try {
      // 只发填了的 key；留空表示不修改
      const keyPatch = Object.fromEntries(Object.entries(keys).filter(([, v]) => v))
      if (Object.keys(keyPatch).length) await api('/api/secrets', 'PUT', keyPatch)
      setKeys({ llmApiKey: '', visionApiKey: '' })
      const r = await api<{ restartRequired: boolean }>('/api/config', 'PUT', { config: configPayload(cfg), persona })
      setNotice({ color: 'green', text: r.restartRequired ? '已保存。监听地址或端口的修改要重启程序后生效。' : '已保存，立即生效。' })
      load()
    } catch (e) { setNotice({ color: 'red', text: (e as Error).message }) } finally { setSaving(false) }
  }

  const jump = (title: string) => {
    if (title === '高级') setAdvanced('advanced')
    document.getElementById(sectionId(title))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <Stack pb={80}>
      <Paper withBorder px="xs" py={6} pos="sticky" top={64} style={{ zIndex: 6, overflowX: 'auto' }}>
        <Group gap={4} wrap="nowrap">
          {SECTIONS.map((title) => <Button key={title} size="compact-sm" variant="subtle" onClick={() => jump(title)} style={{ flexShrink: 0 }}>{title}</Button>)}
        </Group>
      </Paper>
      <Paper withBorder p="md" bg={cfg.dryRun ? 'yellow.0' : undefined}>
        <Switch size="md" checked={cfg.dryRun} onChange={(e) => setCfg({ ...cfg, dryRun: e.currentTarget.checked })}
          label="演练模式" description="开着时评论、私信、收藏都只记录「本来会发什么」，不真的发到 B 站。确认效果后再关掉。" />
      </Paper>

      <Block title="模型">
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="接口地址（base url）" placeholder="https://api.deepseek.com" value={cfg.llm.baseURL} onChange={(e) => set('llm', { baseURL: e.currentTarget.value })} />
          <TextInput label="模型名" placeholder="deepseek-flash" value={cfg.llm.model} onChange={(e) => set('llm', { model: e.currentTarget.value })} />
        </SimpleGrid>
        <Checkbox label="主模型能看图（如 deepseek-flash）" description="勾上后抽帧拼图直接给主模型看；不勾就交给下面的看图模型，两个都没有则跳过看画面"
          checked={cfg.llm.images} onChange={(e) => set('llm', { images: e.currentTarget.checked })} />
        <Switch label="使用单独的看图模型" checked={cfg.vision.enabled} onChange={(e) => set('vision', { enabled: e.currentTarget.checked })} />
        {cfg.vision.enabled && (
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="看图模型接口地址" value={cfg.vision.baseURL} onChange={(e) => set('vision', { baseURL: e.currentTarget.value })} />
            <TextInput label="看图模型名" value={cfg.vision.model} onChange={(e) => set('vision', { model: e.currentTarget.value })} />
          </SimpleGrid>
        )}
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <PasswordInput label="主模型 API key" placeholder={data.secrets.llmApiKey ? '已设置，留空不修改' : '未设置'} autoComplete="off"
            value={keys.llmApiKey} onChange={(e) => setKeys({ ...keys, llmApiKey: e.currentTarget.value })} />
          {cfg.vision.enabled && (
            <PasswordInput label="看图模型 API key" placeholder={data.secrets.visionApiKey ? '已设置，留空不修改' : '未设置'} autoComplete="off"
              value={keys.visionApiKey} onChange={(e) => setKeys({ ...keys, visionApiKey: e.currentTarget.value })} />
          )}
        </SimpleGrid>
      </Block>

      <Block title="B 站账号"><BiliAccount /></Block>

      <Block title="主人">
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="主人 mid" description="只私信这个账号，要和她的小号互相关注；评论分享时 @ 他" value={cfg.owner.mid} onChange={(e) => set('owner', { mid: e.currentTarget.value.trim() })} />
          <TextInput label="主人昵称" description="分享评论里 @ 用的名字" value={cfg.owner.name} onChange={(e) => set('owner', { name: e.currentTarget.value })} />
        </SimpleGrid>
      </Block>

      <Block title="她是谁">
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput label="名字" value={cfg.persona.name} onChange={(e) => set('persona', { name: e.currentTarget.value })} />
          <TextInput label="怎么称呼主人" value={cfg.persona.ownerTitle} onChange={(e) => set('persona', { ownerTitle: e.currentTarget.value })} />
          <TextInput label="怎么自称" value={cfg.persona.selfClaim} onChange={(e) => set('persona', { selfClaim: e.currentTarget.value })} />
        </SimpleGrid>
        <Textarea label="人设" description={`说话方式、在意什么、不做什么（${persona.length}/3000 字）`} autosize minRows={6} maxRows={20}
          value={persona} error={persona.length > 3000 && '人设不能超过 3000 字'} onChange={(e) => setPersona(e.currentTarget.value)} />
      </Block>

      <Block title="口味">
        <TagsInput label="爱看" description="前 6 个用来搜索；可以写成「哈基米/哈基米音乐」，斜杠前面的词用来搜" value={cfg.preferences.like} onChange={(like) => set('preferences', { like })} />
        <TagsInput label="不爱看" value={cfg.preferences.dislike} onChange={(dislike) => set('preferences', { dislike })} />
      </Block>

      <Block title="作息">
        <Text size="sm" c="dimmed">每个时段里随机挑时间醒来，按服务器所在时区计算（活动页顶部有服务器时间）。</Text>
        {windows.map((w, i) => (
          <Group key={i} align="end" wrap="nowrap">
            <TextInput label={i === 0 ? '开始' : undefined} w={90} value={w.start} onChange={(e) => setWindow(i, { start: e.currentTarget.value })} />
            <TextInput label={i === 0 ? '结束' : undefined} w={90} value={w.end} onChange={(e) => setWindow(i, { end: e.currentTarget.value })} />
            <NumberInput label={i === 0 ? '醒几次' : undefined} w={90} min={0} max={12} value={w.wakes} onChange={(v) => setWindow(i, { wakes: num(v) })} />
            <ActionIcon variant="subtle" color="red" mb={4} disabled={windows.length === 1} aria-label="删除时段"
              onClick={() => set('night', { windows: windows.filter((_, j) => j !== i) })}>✕</ActionIcon>
          </Group>
        ))}
        <Group><Button size="sm" variant="light" onClick={() => set('night', { windows: [...windows, { start: '12:00', end: '14:00', wakes: 1 }] })}>添加时段</Button></Group>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <NumberInput label="跳过看视频的概率" description="跳过时只写日记" min={0} max={1} step={0.1} decimalScale={2} value={cfg.night.skipChance} onChange={(v) => set('night', { skipChance: num(v) })} />
          <NumberInput label="两次醒来至少隔（分钟）" min={1} value={cfg.night.minGapMin} onChange={(v) => set('night', { minGapMin: num(v) })} />
          <NumberInput label="每次最多看几个视频" min={1} max={20} value={cfg.night.maxVideos} onChange={(v) => set('night', { maxVideos: num(v) })} />
        </SimpleGrid>
      </Block>

      <Block title="分享与推送">
        <Switch label="把好视频分享给主人" checked={cfg.share.enabled} onChange={(e) => set('share', { enabled: e.currentTarget.checked })} />
        <Group>
          <Text size="sm">分享方式</Text>
          <SegmentedControl size="sm" value={cfg.share.via} onChange={(via) => set('share', { via: via as AppConfig['share']['via'] })}
            data={[{ value: 'comment', label: '评论区 @ 主人' }, { value: 'dm', label: '私信主人' }]} />
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <NumberInput label="每天最多分享几条" min={0} max={20} value={cfg.quota.shareDaily} onChange={(v) => set('quota', { shareDaily: num(v) })} />
          <NumberInput label="最低分享评分（满分 20）" min={0} max={20} value={cfg.share.minScore} onChange={(v) => set('share', { minScore: num(v) })} />
        </SimpleGrid>
        <Select label="推送（醒来写的信、待审回复、出问题时）" value={cfg.notify.type} allowDeselect={false}
          onChange={(type) => set('notify', { type: (type ?? 'none') as AppConfig['notify']['type'] })}
          data={[{ value: 'none', label: '不推送' }, { value: 'dm', label: 'B 站私信给主人（演练模式下不发）' }, { value: 'webhook', label: 'Webhook（飞书 / 钉钉 / 企业微信 / 通用 JSON）' }]} />
        {cfg.notify.type === 'webhook' && <TextInput label="Webhook 地址" value={cfg.notify.url} onChange={(e) => set('notify', { url: e.currentTarget.value.trim() })} />}
        {((cfg.share.enabled && cfg.share.via === 'dm') || cfg.notify.type === 'dm') && (
          <Alert color="blue" variant="light" py={8}>
            <Text size="sm">私信要求她的小号和主人互相关注：用主号关注小号，再用小号关注主号。没互关时私信发不出去，运行记录里会显示「私信通道要求双方互相关注」。</Text>
          </Alert>
        )}
      </Block>

      <Block title="监听">
        <Switch label="主人私信时及时回复" description="关掉后她看不到你的私信，也会以为你没理她、逐渐少分享" checked={cfg.listen.dm} onChange={(e) => set('listen', { dm: e.currentTarget.checked })} />
        <Switch label="有人回复或 @ 她时及时处理" description="关掉后，回复和 @ 留到她按作息醒来时一起看。新号长时间开着容易被风控" checked={cfg.listen.comment} onChange={(e) => set('listen', { comment: e.currentTarget.checked })} />
        <Stack gap={4}>
          <Text size="sm" fw={500}>多久检查一次（以上两项共用）</Text>
          <SegmentedControl fullWidth size="sm" data={INTERVALS} value={String(interval)} disabled={!listening}
            onChange={(v) => set('listen', { commentIntervalSec: Number(v) })} />
          <Text size="xs" c="dimmed">{listenHint}</Text>
        </Stack>
      </Block>

      <Accordion variant="contained" value={advanced} onChange={setAdvanced} id={sectionId('高级')} style={{ scrollMarginTop: 120 }}>
        <Accordion.Item value="advanced">
          <Accordion.Control>高级</Accordion.Control>
          <Accordion.Panel>
            <Stack>
              <Text fw={500} size="sm">风控额度</Text>
              <SimpleGrid cols={{ base: 2, sm: 4 }}>
                {([['minGapMs', '请求最小间隔（毫秒）'], ['readHourly', '每小时读'], ['readDaily', '每天读'], ['writeHourly', '每小时写'],
                  ['writeDaily', '每天写'], ['writeGapSec', '两次写间隔（秒）'], ['dmGapSec', '两次私信间隔（秒）']] as const).map(([key, label]) => (
                  <NumberInput key={key} label={label} min={0} value={cfg.risk[key]} onChange={(v) => set('risk', { [key]: num(v) })} />
                ))}
              </SimpleGrid>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <NumberInput label="每天最多醒几次" description="留空 = 各时段次数之和" min={0} max={12} value={cfg.night.maxWakesPerDay ?? ''}
                  onChange={(v) => set('night', { maxWakesPerDay: v === '' ? null : num(v) })} />
                <NumberInput label="主人几天没回应后少分享" description="之后逐天减少，第 7 天停止" min={0} value={cfg.share.silentAfterDays} onChange={(v) => set('share', { silentAfterDays: num(v) })} />
              </SimpleGrid>
              <Text fw={500} size="sm">网页监听（改完要重启）</Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput label="监听地址" description="0.0.0.0 = 允许其他设备访问" value={cfg.server.host} onChange={(e) => set('server', { host: e.currentTarget.value.trim() })} />
                <NumberInput label="端口" min={1} max={65535} value={cfg.server.port} onChange={(v) => set('server', { port: num(v) })} />
                <TextInput label="HTTPS 证书路径（可选）" value={cfg.server.tlsCert} onChange={(e) => set('server', { tlsCert: e.currentTarget.value.trim() })} />
                <TextInput label="HTTPS 私钥路径（可选）" value={cfg.server.tlsKey} onChange={(e) => set('server', { tlsKey: e.currentTarget.value.trim() })} />
              </SimpleGrid>
              <Divider />
              <PasswordChange onLoggedOut={onLoggedOut} />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      {notice && <Alert color={notice.color}>{notice.text}</Alert>}
      <Paper withBorder p="sm" pos="sticky" bottom={8} style={{ zIndex: 5 }}>
        <Group justify="flex-end"><Button onClick={save} loading={saving} disabled={persona.length > 3000}>保存配置</Button></Group>
      </Paper>
    </Stack>
  )
}

function PasswordChange({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [notice, setNotice] = useState<{ color: string; text: string } | null>(null)
  const change = async () => {
    try {
      await api('/api/password', 'PUT', { current, next })
      setCurrent(''); setNext('')
      setNotice({ color: 'green', text: '密码已修改，其他设备需要重新登录' })
    } catch (e) { setNotice({ color: 'red', text: (e as Error).message }) }
  }
  const logoutAll = async () => {
    await api('/api/logout-all', 'POST').catch(() => {})
    onLoggedOut()
  }
  return (
    <Stack gap="xs">
      <Text fw={500} size="sm">网页密码</Text>
      <Group align="end">
        <PasswordInput label="当前密码" w={200} value={current} onChange={(e) => setCurrent(e.currentTarget.value)} />
        <PasswordInput label="新密码（至少 10 位）" w={200} value={next} onChange={(e) => setNext(e.currentTarget.value)} />
        <Button variant="light" onClick={change} disabled={!current || next.length < 10}>修改密码</Button>
        <Button variant="subtle" color="red" onClick={logoutAll}>退出所有设备</Button>
      </Group>
      {notice && <Alert color={notice.color}>{notice.text}</Alert>}
    </Stack>
  )
}
