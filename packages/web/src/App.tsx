import { Alert, AppShell, Button, Center, Container, Group, Loader, SegmentedControl, Title } from '@mantine/core'
import { useEffect, useState } from 'react'
import { api, ApiError, plainHttpWarning, setUnauthorizedHandler } from './api'
import { Activity } from './pages/Activity'
import { Config } from './pages/Config'
import { Login } from './pages/Login'
import { Setup } from './pages/Setup'

type Phase = 'loading' | 'setup' | 'login' | 'ready'
const HTTP_HIDDEN_KEY = 'whale_http_banner_hidden'

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [page, setPage] = useState<'activity' | 'config'>('activity')
  // 明文提示关掉后在这个浏览器里记住（存储不可用时下次还会显示）
  const [httpHidden, setHttpHidden] = useState(() => { try { return localStorage.getItem(HTTP_HIDDEN_KEY) === '1' } catch { return false } })
  const hideHttp = () => { setHttpHidden(true); try { localStorage.setItem(HTTP_HIDDEN_KEY, '1') } catch { /* 只关本次 */ } }

  useEffect(() => {
    setUnauthorizedHandler((needsSetup) => setPhase(needsSetup ? 'setup' : 'login'))
    api('/api/status').then(() => setPhase('ready')).catch((e) => {
      if (!(e instanceof ApiError && (e.status === 401 || e.status === 403))) setPhase('ready')
    })
  }, [])

  const logout = async () => {
    await api('/api/logout', 'POST').catch(() => {})
    setPhase('login')
  }

  if (phase === 'loading') return <Center h="100vh"><Loader /></Center>
  const banner = plainHttpWarning(location) && !httpHidden && (
    <Alert color="yellow" py={6} mb="md" withCloseButton closeButtonLabel="关闭提示" onClose={hideHttp}>
      当前通过 http 从其他设备访问，密码与登录状态是明文传输；只在可信网络里使用，或在「高级」里配置 HTTPS。
    </Alert>
  )
  if (phase === 'setup') return <Container size="md" pt="md">{banner}<Setup onDone={() => setPhase('ready')} /></Container>
  if (phase === 'login') return <Container size="md" pt="md">{banner}<Login onDone={() => setPhase('ready')} /></Container>

  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Container size="md" h={56}>
          <Group h="100%" justify="space-between" wrap="nowrap">
            <Title order={4}>bili-whale</Title>
            <Group gap="xs" wrap="nowrap">
              <SegmentedControl size="sm" value={page} onChange={(v) => setPage(v as typeof page)}
                data={[{ value: 'activity', label: '活动' }, { value: 'config', label: '配置' }]} />
              <Button size="sm" variant="subtle" onClick={logout}>退出</Button>
            </Group>
          </Group>
        </Container>
      </AppShell.Header>
      <AppShell.Main>
        <Container size="md">{banner}{page === 'activity' ? <Activity /> : <Config onLoggedOut={() => setPhase('login')} />}</Container>
      </AppShell.Main>
    </AppShell>
  )
}
