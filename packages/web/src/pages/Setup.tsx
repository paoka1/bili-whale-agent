import { Alert, Button, Center, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core'
import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { login } from './Login'

export function Setup({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mismatch = confirm !== '' && confirm !== password
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/api/setup', 'POST', { code: code.trim(), password })
      await login(password)
      onDone()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <Center mih="80vh" p="md">
      <Paper withBorder p="lg" w={400} component="form" onSubmit={submit}>
        <Stack>
          <Title order={3}>首次设置</Title>
          <Text size="sm" c="dimmed">设置码在启动程序的终端里（8 位数字）。设好的密码以后用来登录这个网页。</Text>
          <TextInput label="设置码" value={code} onChange={(e) => setCode(e.currentTarget.value)} autoFocus />
          <PasswordInput label="网页密码" description="至少 10 位" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
          <PasswordInput label="再输一次" value={confirm} error={mismatch && '两次输入不一致'} onChange={(e) => setConfirm(e.currentTarget.value)} />
          {error && <Alert color="red">{error}</Alert>}
          <Button type="submit" loading={busy} disabled={!code || password.length < 10 || password !== confirm}>设置并登录</Button>
        </Stack>
      </Paper>
    </Center>
  )
}
