import { verifyToken } from '@clerk/backend'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { loginPage } from './login'
import type { QuotaNamespace } from './quota'
import { finishReason, meterStream, recordUsage, tokenCount, type UsageDataset, type UsageRecord } from './usage'

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
  /** Per-user daily request counters (Durable Object namespace). */
  QUOTA: QuotaNamespace
  /** Chat requests each user may make per UTC day. */
  DAILY_REQUEST_LIMIT?: string | number
  /** Per-request usage records (Workers Analytics Engine dataset). Never holds message content. */
  USAGE: UsageDataset
}

export interface AppOptions {
  /** Clock used for the daily quota. Tests pass their own to move between days. */
  now?: () => Date
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
const MAX_TOKENS = 16_384
const MAX_CONTENT_CHARS = 200_000
const MAX_TOOLS = 64
const MAX_TOOL_CALLS = 32
const MAX_ID_CHARS = 256
const MAX_SCHEMA_DEPTH = 64
/** OpenAI's rule for function names. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/
// `none` is left out on purpose: the model ignores it and writes fake tool calls into the reply text.
// Clients that want no tool calls leave out `tools`.
const TOOL_CHOICES = new Set(['auto', 'required'])

async function readJson(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    if (body && typeof body === 'object' && !Array.isArray(body)) return body
  } catch {}
  throw new HttpError(400, 'bad_request', 'body must be a JSON object')
}

const badRequest = (message: string) => new HttpError(400, 'bad_request', message)

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Whether a JSON value nests objects or arrays more than `max` levels deep. Stops at `max`, so it can't overflow. */
function nestedDeeperThan(value: unknown, max: number): boolean {
  if (!value || typeof value !== 'object') return false
  if (max === 0) return true
  return Object.values(value).some((child) => nestedDeeperThan(child, max - 1))
}

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS

/** What the model gets: the fields it needs from each part of the request, nothing else. */
interface ModelInputs {
  messages: Record<string, unknown>[]
  tools?: Record<string, unknown>[]
  tool_choice?: unknown
}

/** Rebuilds an assistant message's tool calls from the fields the model needs. */
function parseToolCalls(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOOL_CALLS) {
    throw badRequest(`tool_calls must be an array of 1 to ${MAX_TOOL_CALLS} calls`)
  }
  return value.map((call) => {
    const fn = isObject(call) ? call.function : undefined
    if (
      !isObject(call) ||
      !isId(call.id) ||
      call.type !== 'function' ||
      !isObject(fn) ||
      typeof fn.name !== 'string' ||
      !TOOL_NAME.test(fn.name) ||
      typeof fn.arguments !== 'string'
    ) {
      throw badRequest('each tool call needs an id, type "function", and a function with a name and string arguments')
    }
    return { id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } }
  })
}

/** Rebuilds one message from the fields the model needs for its role. */
function parseMessage(m: unknown): Record<string, unknown> {
  if (!isObject(m)) throw badRequest('each message must be an object')
  switch (m.role) {
    case 'system':
    case 'user':
      if (typeof m.content !== 'string') throw badRequest(`${m.role} messages need string content`)
      return { role: m.role, content: m.content }
    case 'assistant': {
      if (m.tool_calls === undefined || m.tool_calls === null) {
        if (typeof m.content !== 'string') throw badRequest('assistant messages need string content or tool_calls')
        return { role: 'assistant', content: m.content }
      }
      if (m.content !== undefined && m.content !== null && typeof m.content !== 'string') {
        throw badRequest('assistant content must be a string or null')
      }
      // The model accepts an empty string next to tool calls; OpenAI clients often send null.
      return { role: 'assistant', content: m.content ?? '', tool_calls: parseToolCalls(m.tool_calls) }
    }
    case 'tool':
      if (!isId(m.tool_call_id) || typeof m.content !== 'string') {
        throw badRequest('tool messages need a tool_call_id and string content')
      }
      return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content }
    default:
      throw badRequest('each message needs a role: system, user, assistant, or tool')
  }
}

/** Rebuilds the tool definitions: function tools only, with unique names. */
function parseTools(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOOLS) {
    throw badRequest(`tools must be an array of 1 to ${MAX_TOOLS} tools`)
  }
  const names = new Set<string>()
  return value.map((tool) => {
    const fn = isObject(tool) ? tool.function : undefined
    if (!isObject(tool) || tool.type !== 'function' || !isObject(fn)) {
      throw badRequest('each tool needs type "function" and a function definition')
    }
    if (typeof fn.name !== 'string' || !TOOL_NAME.test(fn.name)) {
      throw badRequest('tool names are 1 to 64 letters, digits, underscores, or dashes')
    }
    if (names.has(fn.name)) throw badRequest(`tool ${fn.name} is defined twice`)
    names.add(fn.name)
    if (fn.description !== undefined && typeof fn.description !== 'string') {
      throw badRequest('tool descriptions must be strings')
    }
    if (fn.parameters !== undefined && !isObject(fn.parameters)) {
      throw badRequest('tool parameters must be an object')
    }
    // Bounded, so serializing the request (here and in the AI binding) can never run out of stack.
    if (nestedDeeperThan(fn.parameters, MAX_SCHEMA_DEPTH)) {
      throw badRequest(`tool parameters are nested more than ${MAX_SCHEMA_DEPTH} levels deep`)
    }
    const out: Record<string, unknown> = { name: fn.name }
    if (fn.description !== undefined) out.description = fn.description
    if (fn.parameters !== undefined) out.parameters = fn.parameters
    return { type: 'function', function: out }
  })
}

function parseToolChoice(value: unknown, tools: Record<string, unknown>[] | undefined): unknown {
  if (!tools) throw badRequest('tool_choice needs tools')
  if (value === 'none') throw badRequest('tool_choice none is not supported; leave out tools instead')
  if (typeof value === 'string' && TOOL_CHOICES.has(value)) return value
  const name =
    isObject(value) && value.type === 'function' && isObject(value.function) ? value.function.name : undefined
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
    throw badRequest('tool_choice must be auto, required, or {"type":"function","function":{"name":...}}')
  }
  if (!tools.some((t) => (t.function as { name: string }).name === name)) {
    throw badRequest(`tool_choice names an unknown tool: ${name}`)
  }
  return { type: 'function', function: { name } }
}

/**
 * Validates the conversation and tools, and returns only what the model needs.
 * `chars` counts message text, tool calls and results, and tool definitions, so tools can't get around
 * the size limit.
 */
function parseModelInputs(body: Record<string, unknown>): { inputs: ModelInputs; chars: number } {
  const { messages } = body
  if (!Array.isArray(messages) || messages.length === 0) throw badRequest('messages must be a non-empty array')
  if (messages.length > MAX_MESSAGES) throw badRequest(`at most ${MAX_MESSAGES} messages`)
  const inputs: ModelInputs = { messages: messages.map(parseMessage) }
  if (body.tools !== undefined && body.tools !== null) inputs.tools = parseTools(body.tools)
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    inputs.tool_choice = parseToolChoice(body.tool_choice, inputs.tools)
  }

  // As OpenAI requires, an assistant message with tool calls is followed right away by one result per
  // call (in any order), before any other message. Ids only need to be unique within one assistant
  // message: results are paired with the calls right before them.
  let pending = new Set<string>()
  const unanswered = () => badRequest('each tool call needs its result right after the assistant message')
  let chars = 0
  for (const m of inputs.messages) {
    chars += (m.content as string).length
    if (m.role === 'tool') {
      const id = m.tool_call_id as string
      if (!pending.delete(id)) {
        throw badRequest('each tool message must answer a call from the assistant message before it')
      }
      chars += id.length
      continue
    }
    if (pending.size) throw unanswered()
    const toolCalls = m.tool_calls as { id: string }[] | undefined
    if (toolCalls) {
      pending = new Set(toolCalls.map((call) => call.id))
      if (pending.size !== toolCalls.length) throw badRequest('tool call ids in one message must be unique')
      chars += JSON.stringify(toolCalls).length
    }
  }
  if (pending.size) throw unanswered()
  if (inputs.tools) chars += JSON.stringify(inputs.tools).length
  return { inputs, chars }
}

export function createApp({ now = () => new Date() }: AppOptions = {}) {
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
    // This page holds the Clerk session the extension syncs from, so no other site may frame it.
    c.header('content-security-policy', "frame-ancestors 'none'")
    c.header('x-frame-options', 'DENY')
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
  // Every request that passed auth leaves one usage record, however it ends.
  app.post('/v1/chat/completions', async (c) => {
    const started = Date.now()
    const usage: UsageRecord = {
      userId: c.get('userId'),
      model: c.env.MODEL,
      stream: false,
      outcome: '',
      messages: 0,
      inputChars: 0,
      promptTokens: 0,
      completionTokens: 0,
      finishReason: '',
      durationMs: 0,
    }
    const record = (outcome: string) => {
      usage.outcome = outcome
      usage.durationMs = Date.now() - started
      recordUsage(c.env.USAGE, usage)
    }
    try {
      return await chatCompletion(c, usage, record)
    } catch (err) {
      record(err instanceof HttpError ? err.code : 'internal')
      throw err
    }
  })

  /**
   * Fills `usage` with sizes and token counts only, and calls `record` once the reply is complete.
   * Throws HttpError for refusals; the caller records those.
   */
  async function chatCompletion(c: Ctx, usage: UsageRecord, record: (outcome: string) => void): Promise<Response> {
    const body = await readJson(c)
    const { stream } = body
    usage.stream = stream === true
    const max_tokens = body.max_tokens ?? undefined // null means not set
    const { inputs: modelInputs, chars } = parseModelInputs(body)
    usage.messages = modelInputs.messages.length
    usage.inputChars = chars
    if (chars > MAX_CONTENT_CHARS)
      throw new HttpError(400, 'bad_request', `messages and tools exceed ${MAX_CONTENT_CHARS} characters`)
    if (
      max_tokens !== undefined &&
      !(Number.isInteger(max_tokens) && (max_tokens as number) > 0 && (max_tokens as number) <= MAX_TOKENS)
    ) {
      throw new HttpError(400, 'bad_request', `max_tokens must be an integer from 1 to ${MAX_TOKENS}`)
    }
    if (stream !== undefined && typeof stream !== 'boolean')
      throw new HttpError(400, 'bad_request', 'stream must be a boolean')
    if (body.model !== undefined && body.model !== c.env.MODEL) {
      // A distinct code lets a client that cached the old model name notice and look it up again.
      throw new HttpError(400, 'unsupported_model', `unsupported model; use ${c.env.MODEL} or omit it`)
    }

    // Count the request once it is valid, before the model is called. A failed model call
    // still counts: the quota caps attempts, so retry loops can't get around it.
    const rawLimit = String(c.env.DAILY_REQUEST_LIMIT ?? '').trim()
    if (!/^\d+$/.test(rawLimit)) {
      throw new HttpError(503, 'not_configured', 'DAILY_REQUEST_LIMIT must be a non-negative integer')
    }
    const limit = Number(rawLimit)
    if (limit === 0) throw new HttpError(503, 'chat_disabled', 'Chat is turned off for now. Try again later.')
    const today = now().toISOString().slice(0, 10)
    let allowed: boolean
    try {
      allowed = await c.env.QUOTA.getByName(c.get('userId')).consume(today, limit)
    } catch (err) {
      console.error('quota check failed', err)
      throw new HttpError(503, 'quota_unavailable', 'Usage tracking is unavailable, try again in a moment.')
    }
    if (!allowed) {
      throw new HttpError(
        429,
        'rate_limited',
        `You have used all ${limit} requests for today. The quota resets at 00:00 UTC.`,
      )
    }

    // Pass only the fields the model needs; drop anything else a client added.
    const inputs: Record<string, unknown> = { ...modelInputs }
    // Without an explicit limit, models fall back to their own default, which can be
    // small enough to cut replies short.
    inputs.max_tokens = max_tokens ?? MAX_TOKENS
    if (stream === true) {
      inputs.stream = true
      // Ask for token usage in the final chunk, so streamed replies can be metered too.
      inputs.stream_options = { include_usage: true }
    }
    // collectLog: false keeps prompts and replies out of the gateway logs, and skipCache: true
    // keeps them out of its cache even if caching is turned on in the dashboard. The gateway's
    // analytics (requests, tokens, cost, metadata) still work.
    const options = c.env.AI_GATEWAY_ID
      ? {
          gateway: {
            id: c.env.AI_GATEWAY_ID,
            collectLog: false,
            skipCache: true,
            metadata: { app: 'notion-copilot', user: c.get('userId') },
          },
        }
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
      // Workers AI already streams OpenAI-style SSE; pass it through, reading usage on the way.
      const metered = meterStream(out as ReadableStream<Uint8Array>, (outcome, summary) => {
        Object.assign(usage, summary)
        record(outcome)
      })
      return new Response(metered, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      })
    }
    const reply = out as { usage?: Record<string, unknown>; choices?: { finish_reason?: unknown }[] } | null
    usage.promptTokens = tokenCount(reply?.usage?.prompt_tokens)
    usage.completionTokens = tokenCount(reply?.usage?.completion_tokens)
    usage.finishReason = finishReason(reply?.choices?.[0]?.finish_reason)
    // Build the response first: if that throws, the request is recorded once, as internal.
    const res = c.json(out as Record<string, unknown>)
    record('ok')
    return res
  }

  return app
}
