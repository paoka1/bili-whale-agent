import { Alert, Button, Center, Paper, PasswordInput, Stack, Title } from '@mantine/core'
import { useState, type FormEvent } from 'react'
import { api, saveCsrf } from '../api'

/** 登录并保存 CSRF 令牌；Setup 设完密码后也走这里 */
export async function login(password: string): Promise<void> {
  const { csrf } = await api<{ csrf: string }>('/api/login', 'POST', { password })
  saveCsrf(csrf)
}

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try { await login(password); onDone() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <Center mih="80vh" p="md">
      <Paper withBorder p="lg" w={360} component="form" onSubmit={submit}>
        <Stack>
          <Title order={3}>登录 bili-whale</Title>
          <PasswordInput label="网页密码" value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoFocus />
          {error && <Alert color="red">{error}</Alert>}
          <Button type="submit" loading={busy} disabled={!password}>登录</Button>
        </Stack>
      </Paper>
    </Center>
  )
}
