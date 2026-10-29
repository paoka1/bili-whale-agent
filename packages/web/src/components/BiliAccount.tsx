// B 站账号：显示当前登录，扫码登录 / 换号（换号要当前网页密码），二维码每 2 秒轮询一次。
import { Alert, Button, Group, Image, PasswordInput, Stack, Text } from '@mantine/core'
import { useCallback, useEffect, useState } from 'react'
import { api, type Account, type QrState } from '../api'

const STATUS: Record<QrState['status'], string> = {
  waiting: '请用 B 站 App 扫码', scanned: '已扫码，请在手机上确认', confirmed: '登录成功', expired: '二维码已过期', failed: '登录失败',
}

export function BiliAccount() {
  const [account, setAccount] = useState<Account | null>(null)
  const [qr, setQr] = useState<QrState | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const loadAccount = useCallback(() => {
    api<Account>('/api/account').then(setAccount).catch((e) => setError((e as Error).message))
  }, [])
  useEffect(loadAccount, [loadAccount])

  const pending = qr?.status === 'waiting' || qr?.status === 'scanned'
  useEffect(() => {
    if (!qr || !pending) return
    const timer = setInterval(() => {
      api<QrState>(`/api/qr/${qr.id}`).then((next) => {
        setQr(next)
        if (next.status === 'confirmed') { setPassword(''); loadAccount() }
      }).catch((e) => { setError((e as Error).message); setQr(null) })
    }, 2000)
    return () => clearInterval(timer)
  }, [qr, pending, loadAccount])

  const start = async () => {
    setError('')
    try { setQr(await api<QrState>('/api/qr/start', 'POST', account?.loggedIn ? { password } : {})) } catch (e) { setError((e as Error).message) }
  }

  return (
    <Stack gap="xs">
      <Text size="sm">{account === null ? '读取中…' : account.loggedIn ? `已登录：${account.name}（mid ${account.mid}）` : '未登录'}</Text>
      {account?.loggedIn && !pending && (
        <PasswordInput label="当前网页密码" description="更换 B 站账号时需要；有待审草稿或正在运行时不能换号" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
      )}
      {!pending && (
        <Group><Button variant="light" onClick={start} disabled={account?.loggedIn === true && !password}>{account?.loggedIn ? '换号重新扫码' : '扫码登录'}</Button></Group>
      )}
      {qr && (
        <Stack gap={4}>
          {qr.image && pending && <Image src={qr.image} w={200} h={200} alt="B 站登录二维码" />}
          <Text size="sm" c={qr.status === 'failed' ? 'red' : undefined}>{STATUS[qr.status]}{qr.error ? `：${qr.error}` : ''}</Text>
        </Stack>
      )}
      {error && <Alert color="red">{error}</Alert>}
    </Stack>
  )
}
