import { verifyToken } from '@clerk/backend'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { loginPage } from './login'

/** The slice of the Workers AI binding this worker uses. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
}

export interface Env {
  AI: AiBinding
  MODEL: string
  AI_GATEWAY_ID?: string
  /** Clerk publishable key, used by the sign-in page. */
  CLERK_PUBLISHABLE_KEY?: string
  /** Clerk JWT public key (PEM), from Clerk Dashboard > API keys. Verifies session tokens without a network call. */
  CLERK_JWT_KEY?: string
  /** Comma-separated origins allowed to call, e.g. chrome-extension://<id>. Checked against the token's azp claim. */
  CLERK_AUTHORIZED_PARTIES?: string
}

type Vars = { userId: string }
type Ctx = Context<{ Bindings: Env; Variables: Vars }>

class HttpError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

const MAX_MESSAGES = 200
const MAX_TOKENS = 4096
const MAX_CONTENT_CHARS = 200_000
const ROLES = new Set(['system', 'user', 'assistant'])

async function readJson(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    if (body && typeof body === 'object' && !Array.isArray(body)) return body
  } catch {}
  throw new HttpError(400, 'bad_request', 'body must be a JSON object')
}

export function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>()

  // The extension calls from a chrome-extension:// origin. Auth is a bearer token, not cookies.
  app.use('*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type'], maxAge: 86400 }))

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status)
    console.error(err)
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500)
  })

  app.get('/health', (c) => c.json({ ok: true }))

  // Sign-in page for the extension (Clerk Sync Host).
  app.get('/', (c) => c.redirect('/login'))
  app.get('/login', (c) => {
    if (!c.env.CLERK_PUBLISHABLE_KEY) throw new HttpError(503, 'not_configured', 'CLERK_PUBLISHABLE_KEY is not set')
    return c.html(loginPage(c.env.CLERK_PUBLISHABLE_KEY))
  })

  // ---- Clerk session auth for /v1/* ----

  app.use('/v1/*', async (c, next) => {
    const jwtKey = c.env.CLERK_JWT_KEY
    if (!jwtKey) throw new HttpError(503, 'not_configured', 'CLERK_JWT_KEY is not set')

    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!token) throw new HttpError(401, 'unauthorized', 'sign in first')

    const authorizedParties = (c.env.CLERK_AUTHORIZED_PARTIES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!authorizedParties.length) throw new HttpError(503, 'not_configured', 'CLERK_AUTHORIZED_PARTIES is not set')
    let claims: Awaited<ReturnType<typeof verifyToken>>
    try {
      claims = await verifyToken(token, { jwtKey })
    } catch {
      throw new HttpError(401, 'unauthorized', 'invalid or expired session')
    }
    // Clerk sets azp to the origin that requested the token. Tokens the extension
    // gets through Clerk's Native API have no origin, so they carry no azp.
    // A token with an azp must come from an allowed origin.
    const azp = typeof claims.azp === 'string' ? claims.azp : undefined
    if (azp && !authorizedParties.includes(azp)) {
      throw new HttpError(401, 'unauthorized', 'invalid or expired session')
    }
    c.set('userId', claims.sub)
    await next()
  })

  app.get('/v1/me', (c) => c.json({ userId: c.get('userId'), model: c.env.MODEL }))

  // OpenAI-compatible chat completions. The model is fixed by the server.
  app.post('/v1/chat/completions', async (c) => {
    const body = await readJson(c)
    const { messages, stream } = body
    const max_tokens = body.max_tokens ?? undefined // null means not set
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new HttpError(400, 'bad_request', 'messages must be a non-empty array')
    }
    if (messages.length > MAX_MESSAGES) throw new HttpError(400, 'bad_request', `at most ${MAX_MESSAGES} messages`)
    let chars = 0
    for (const m of messages) {
      if (!m || typeof m !== 'object' || !ROLES.has(m.role) || typeof m.content !== 'string') {
        throw new HttpError(
          400,
          'bad_request',
          'each message needs a role (system, user, assistant) and string content',
        )
      }
      chars += m.content.length
    }
    if (chars > MAX_CONTENT_CHARS)
      throw new HttpError(400, 'bad_request', `messages exceed ${MAX_CONTENT_CHARS} characters`)
    if (
      max_tokens !== undefined &&
      !(Number.isInteger(max_tokens) && (max_tokens as number) > 0 && (max_tokens as number) <= MAX_TOKENS)
    ) {
      throw new HttpError(400, 'bad_request', `max_tokens must be an integer from 1 to ${MAX_TOKENS}`)
    }
    if (stream !== undefined && typeof stream !== 'boolean')
      throw new HttpError(400, 'bad_request', 'stream must be a boolean')
    if (body.model !== undefined && body.model !== c.env.MODEL) {
      throw new HttpError(400, 'bad_request', `unsupported model; use ${c.env.MODEL} or omit it`)
    }

    // Pass only the fields the model needs; drop anything else a client added.
    const inputs: Record<string, unknown> = {
      messages: messages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })),
    }
    // Without an explicit limit, models fall back to their own default, which can be
    // small enough to cut replies short.
    inputs.max_tokens = max_tokens ?? MAX_TOKENS
    if (stream === true) inputs.stream = true
    const options = c.env.AI_GATEWAY_ID
      ? { gateway: { id: c.env.AI_GATEWAY_ID, metadata: { app: 'notion-copilot', user: c.get('userId') } } }
      : undefined

    let out: unknown
    try {
      out = await c.env.AI.run(c.env.MODEL, inputs, options)
    } catch (err) {
      // Details go to Workers Logs, not to the client.
      console.error('model call failed', err)
      throw new HttpError(502, 'provider_error', 'the model is unavailable, try again later')
    }

    if (stream === true) {
      // Workers AI already streams OpenAI-style SSE; pass it through.
      return new Response(out as ReadableStream, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      })
    }
    return c.json(out as Record<string, unknown>)
  })

  return app
}
