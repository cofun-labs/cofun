// The worker's Hono app, composed from its routes. What every route shares (the bindings, the
// options, errors, and request parsing) is in http.ts; each area's routes are a sub-app in routes/.
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { modelOf } from './pricing'
import { HttpError, errorSummary, type App, type AppOptions, type Deps } from './http'
import { adminRoutes } from './routes/admin'
import { billingRoutes, stripeRoutes } from './routes/billing'
import { chatRoutes } from './routes/chat'
import { MAX_TOKENS } from './routes/chat-request'
import { CHAT_HEADER, CLIENT_HEADER, TURN_HEADER } from './charge'
import { creditsRoutes } from './routes/credits'
import { pageRoutes } from './routes/pages'
import { defaultRateLimit } from './routes/rate-limit'
import { requireSession } from './routes/session'
import { webRoutes } from './routes/web'

export type { AiBinding, Env } from './http'

/**
 * The largest request body the worker reads, on every route. The chat's is the largest: the model's
 * context window bounds its text, and a full window of text (1,048,576 tokens) is about 4 MB as
 * JSON. Pi counts a 413 as a context overflow, so the agent compacts and sends again, as it does
 * when the model refuses a long input. Routes may refuse less (the Stripe webhook does).
 */
const MAX_BODY_BYTES = 6 * 1024 * 1024

export function createApp({
  now = () => new Date(),
  modelOf: modelFor = modelOf,
  logError = (line) => console.error(line),
  logAdmin = (line) => console.log(line),
  logBilling = (line) => console.log(line),
  after = (ms, fire) => {
    const timer = setTimeout(fire, ms)
    return () => clearTimeout(timer)
  },
}: AppOptions = {}) {
  const deps: Deps = { now, modelOf: modelFor, logError, logAdmin, logBilling, after }
  const app: App = new Hono()

  // The extension calls from a chrome-extension:// origin. Auth is a bearer token, not cookies.
  app.use(
    '*',
    cors({
      origin: '*',
      allowHeaders: ['authorization', 'content-type', CLIENT_HEADER, CHAT_HEADER, TURN_HEADER],
      maxAge: 86400,
    }),
  )
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
  // The model the worker serves, and the tokens a request to it can hold and a reply can take,
  // which the agent budgets a conversation by.
  v1.get('/me', (c) => {
    const model = deps.modelOf(c.env.MODEL)
    if (!model) throw new HttpError(503, 'not_configured', 'MODEL is not in the model table')
    return c.json({
      userId: c.get('userId'),
      model: c.env.MODEL,
      context_window: model.contextWindow,
      max_tokens: MAX_TOKENS,
    })
  })
  v1.route('/billing', billingRoutes(deps))
  v1.route('/credits', creditsRoutes(deps))
  v1.route('/web', webRoutes(deps))
  return v1
}
