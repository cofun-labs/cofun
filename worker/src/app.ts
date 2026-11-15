// The worker's Hono app, composed from its routes. What every route shares (the bindings, the
// options, errors, and request parsing) is in http.ts; each area's routes are a sub-app in routes/.
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { priceOf } from './pricing'
import { HttpError, errorSummary, type App, type AppOptions, type Deps } from './http'
import { adminRoutes } from './routes/admin'
import { billingRoutes, stripeRoutes } from './routes/billing'
import { chatRoutes, CLIENT_HEADER } from './routes/chat'
import { creditsRoutes } from './routes/credits'
import { pageRoutes } from './routes/pages'
import { defaultRateLimit } from './routes/rate-limit'
import { requireSession } from './routes/session'
import { webRoutes } from './routes/web'

export type { AiBinding, Env } from './http'

/**
 * The largest request body the worker reads, on every route. The chat's is the largest: its text is
 * capped at MAX_CONTENT_CHARS (200,000 characters), at most 800 kB in UTF-8 or 1.2 MB written as
 * JSON escapes (\uXXXX), and the JSON around it adds little. Routes may refuse less (the Stripe
 * webhook does).
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024

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
  app.use('*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type', CLIENT_HEADER], maxAge: 86400 }))
  // A body over the limit is refused before it is read whole: by its content-length, or, sent
  // without one (chunked), as soon as the bytes read pass the limit.
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new HttpError(413, 'too_large', `request body is larger than ${MAX_BODY_BYTES} bytes`)
      },
    }),
  )

  // Sub-apps have no error handler of their own, so this one answers for their routes too.
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status)
    logError(`request failed: ${errorSummary(err)}`)
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500)
  })

  // Without a Clerk session: the worker's pages, and what Stripe sends buyers and events to.
  app.route('/', pageRoutes())
  app.route('/', stripeRoutes(deps))
  // Everything else is under /v1, and needs a session.
  app.route('/v1', v1Routes(deps))

  return app
}

/**
 * The routes under /v1. The session check is this sub-app's first handler, so every route mounted
 * here runs after it: a route under /v1 can't be added without it.
 *
 * Handlers run in the order they are added. The chat comes before the default rate limit, since it
 * has a limit of its own and its calls must not count toward this one; every route added after the
 * limit gets it. `worker/test/rate-limit.test.ts` checks that the chat is the only route without it.
 */
function v1Routes(deps: Deps): App {
  const v1: App = new Hono()
  v1.use('*', requireSession)
  v1.route('/chat', chatRoutes(deps))
  v1.use('*', defaultRateLimit)
  v1.route('/admin', adminRoutes(deps))
  v1.get('/me', (c) => c.json({ userId: c.get('userId'), model: c.env.MODEL }))
  v1.route('/billing', billingRoutes(deps))
  v1.route('/credits', creditsRoutes(deps))
  v1.route('/web', webRoutes())
  return v1
}
