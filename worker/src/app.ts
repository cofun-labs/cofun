import { verifyToken } from '@clerk/backend'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/** The slice of the Workers AI binding this worker uses. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
}

export interface Env {
  AI: AiBinding
  MODEL: string
  AI_GATEWAY_ID?: string
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
    try {
      const claims = await verifyToken(token, {
        jwtKey,
        authorizedParties: authorizedParties.length ? authorizedParties : undefined,
      })
      c.set('userId', claims.sub)
    } catch {
      throw new HttpError(401, 'unauthorized', 'invalid or expired session')
    }
    await next()
  })

  app.get('/v1/me', (c) => c.json({ userId: c.get('userId'), model: c.env.MODEL }))

  // OpenAI-compatible chat completions. The model is fixed by the server.
  app.post('/v1/chat/completions', async (c) => {
    const body = await readJson(c)
    const { messages, stream, max_tokens } = body
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new HttpError(400, 'bad_request', 'messages must be a non-empty array')
    }
    if (messages.length > MAX_MESSAGES) throw new HttpError(400, 'bad_request', `at most ${MAX_MESSAGES} messages`)
    if (body.model !== undefined && body.model !== c.env.MODEL) {
      throw new HttpError(400, 'bad_request', `unsupported model; use ${c.env.MODEL} or omit it`)
    }

    const inputs: Record<string, unknown> = { messages }
    if (typeof max_tokens === 'number') inputs.max_tokens = max_tokens
    if (stream) inputs.stream = true
    const options = c.env.AI_GATEWAY_ID
      ? { gateway: { id: c.env.AI_GATEWAY_ID, metadata: { app: 'notion-kit', user: c.get('userId') } } }
      : undefined

    let out: unknown
    try {
      out = await c.env.AI.run(c.env.MODEL, inputs, options)
    } catch (err) {
      throw new HttpError(502, 'provider_error', err instanceof Error ? err.message : String(err))
    }

    if (stream) {
      // Workers AI already streams OpenAI-style SSE; pass it through.
      return new Response(out as ReadableStream, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      })
    }
    return c.json(out as Record<string, unknown>)
  })

  return app
}
