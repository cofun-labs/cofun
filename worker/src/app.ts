// The worker's Hono app, composed from its routes. What every route shares (the bindings, the
// options, errors, and request parsing) is in http.ts; each area's routes are in routes/.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { priceOf } from './pricing'
import { HttpError, errorSummary, type App, type AppOptions, type Deps } from './http'
import { adminRoutes } from './routes/admin'
import { billingRoutes, stripeRoutes } from './routes/billing'
import { chatRoutes } from './routes/chat'
import { creditsRoutes } from './routes/credits'
import { pageRoutes } from './routes/pages'
import { sessionAuth } from './routes/session'

export type { AiBinding, Env } from './http'

export function createApp({
  now = () => new Date(),
  priceOf: priceFor = priceOf,
  logError = (line) => console.error(line),
  logAdmin = (line) => console.log(line),
  logBilling = (line) => console.log(line),
}: AppOptions = {}) {
  const deps: Deps = { now, priceOf: priceFor, logError, logAdmin, logBilling }
  const app: App = new Hono()

  // The extension calls from a chrome-extension:// origin. Auth is a bearer token, not cookies.
  app.use('*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type'], maxAge: 86400 }))

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status)
    logError(`request failed: ${errorSummary(err)}`)
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500)
  })

  // The routes are added in this order: those under /v1 only after the session check, which comes
  // before them.
  pageRoutes(app)
  stripeRoutes(app, deps)
  sessionAuth(app)
  adminRoutes(app, deps)
  app.get('/v1/me', (c) => c.json({ userId: c.get('userId'), model: c.env.MODEL }))
  billingRoutes(app, deps)
  creditsRoutes(app, deps)
  chatRoutes(app, deps)

  return app
}
