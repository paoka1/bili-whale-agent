import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { serveStatic } from '@hono/node-server/serve-static'
import type { BiliContext, QrLogin } from '@bili-whale/bili'
import type { Scheduler } from '../scheduler.js'
import { ConfigError } from '../config.js'
import { AuthError, type Auth } from './auth.js'
import { InputError, registerRoutes, SESSION_COOKIE } from './routes.js'

export type AppDeps = { dataDir: string; auth: Auth; scheduler: Scheduler; getCtx: () => BiliContext; qr: QrLogin; webDist?: string }
export type ServerEnv = { Variables: { session: string } }

export function createApp(deps: AppDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>()
  // 覆盖框架默认的异常日志，避免将第三方错误中的凭据打印到终端或回传。
  app.onError((error, c) => {
    if (error instanceof InputError) return c.json({ error: '请求参数格式或取值不符合要求' }, 400)
    if (error instanceof ConfigError || error instanceof AuthError) return c.json({ error: error.message }, 400)
    return c.json({ error: '服务暂时无法完成请求，请检查配置与本地状态' }, 500)
  })
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    const read = c.req.method === 'GET' || c.req.method === 'HEAD'
    if (!read && c.req.header('Origin') && c.req.header('Origin') !== new URL(c.req.url).origin) {
      return c.json({ error: '请求来源不符合要求' }, 403)
    }
    if (c.req.method === 'POST' && ['/api/setup', '/api/login'].includes(c.req.path)) return next()
    const session = getCookie(c, SESSION_COOKIE) ?? ''
    if (deps.auth.needsSetup() || !deps.auth.verify(session)) return c.json({ error: '请先设置密码并登录', needsSetup: deps.auth.needsSetup() }, 401)
    if (!read && !deps.auth.verifyCsrf(session, c.req.header('X-CSRF-Token') ?? '')) return c.json({ error: '请求校验失败，请刷新页面后重试' }, 403)
    c.set('session', session)
    await next()
  })
  app.use('/api/*', bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: '请求内容不能超过 256KB' }, 413) }))
  registerRoutes(app, deps)
  // API 路径必须先终止，不能被前端的单页回退匹配。
  app.all('/api/*', (c) => c.json({ error: '没有这个接口' }, 404))
  app.all('/api', (c) => c.json({ error: '没有这个接口' }, 404))
  if (deps.webDist) {
    app.use('*', serveStatic({ root: deps.webDist }))
    app.get('*', serveStatic({ root: deps.webDist, path: 'index.html' }))
  }
  app.notFound((c) => c.json({ error: '没有这个页面' }, 404))
  return app
}
