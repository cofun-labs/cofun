import { verifyToken } from '@clerk/backend'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import * as z from './zod'
import { adminPage } from './admin'
import { readAccounts, readOverview, type Period } from './overview'
import { loginPage } from './login'
import { billingPage } from './billing-page'
import { CREDITS_PER_UNIT, handleEvent, offerOf, type Offer } from './billing'
import { stripeOverHttp, verifiedEvent, type StripeApi } from './stripe'
import {
  FREE_CREDITS,
  FREE_PERIOD_MS,
  Ledger,
  MICRO_CREDITS,
  type Account,
  type Balance,
  type Database,
  type GrantsCursor,
  type Standing,
} from './credits'
import { costOf, estimateCachedTokens, estimateTokens, priceOf, type Tokens } from './pricing'
import {
  finishReason,
  meterStream,
  recordUsage,
  replyInfo,
  tokensOf,
  type StreamSummary,
  type UsageDataset,
  type UsageRecord,
} from './usage'

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
  /**
   * Which product each extension is, by its origin: `{"chrome-extension://<id>": "notico"}`. A JSON
   * object in wrangler.jsonc, so it arrives as an object; read through `Products`. A caller whose
   * origin is not listed (the admin page, a token with no azp) is the product `unknown`.
   */
  PRODUCTS?: unknown
  /** Every user's credits: their grants, and their model calls with what each cost (D1 database, schema in migrations/). */
  DB: Database
  /** Per-request usage records (Workers Analytics Engine dataset). Never holds message content. */
  USAGE: UsageDataset
  /** Stripe's API. Tests pass a fake; deployed, it is Stripe's own API with STRIPE_SECRET_KEY. */
  STRIPE?: StripeApi
  /** The Stripe account's secret key (a worker secret, never committed). Without it nothing can be bought. */
  STRIPE_SECRET_KEY?: string
  /** The signing secret of the Stripe webhook endpoint (a worker secret). Without it no event is accepted. */
  STRIPE_WEBHOOK_SECRET?: string
  /** The id of the Stripe price of 1,000 credits, US$1. A pack is a quantity of it. */
  CREDIT_PRICE?: string
  /** The quantities of CREDIT_PRICE on sale as packs: `[5, 10, 20, 50]` (see `offerOf` in billing.ts). */
  CREDIT_PACKS?: unknown
}

export interface AppOptions {
  /** Clock used for credits: when they are granted and when they expire. Tests pass their own to move through the weeks. */
  now?: () => Date
  /** What a model's tokens cost: the price table by default. Tests pass their own to price a model it does not list. */
  priceOf?: typeof priceOf
  /** Where error lines go: Workers Logs by default. Tests pass their own to read what was logged. */
  logError?: (line: string) => void
  /** Where the record of what admins did goes: Workers Logs by default. Tests pass their own to read it. */
  logAdmin?: (line: string) => void
  /** Where the record of purchases granted and taken back goes: Workers Logs by default. Tests pass their own. */
  logBilling?: (line: string) => void
}

/** `claims` is the verified session token's payload, as Clerk wrote it: read it through a schema. */
type Vars = { userId: string; claims: unknown }
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

const MAX_LOGGED_NAME_CHARS = 60
const MAX_LOGGED_MESSAGE_CHARS = 200

/**
 * What the logs keep of an error the worker did not write: its name and the start of its message,
 * never the object. Such an error may carry anything, a quote of the request included, in its
 * message, its stack (which repeats the message), its cause, or other fields; this bounds how much
 * of that can reach Workers Logs.
 */
function errorSummary(err: unknown): string {
  if (!(err instanceof Error)) return `non-error value of type ${typeof err}`
  const name = String(err.name).slice(0, MAX_LOGGED_NAME_CHARS)
  const message = String(err.message).slice(0, MAX_LOGGED_MESSAGE_CHARS)
  return `${name}: ${message}`
}

/** A time as the out-of-credits message gives it: to the minute, in UTC, since the worker does not know the user's time zone. */
function utcMinute(ms: number): string {
  // Rounded up, so the time named is never before the credits arrive.
  const iso = new Date(Math.ceil(ms / 60_000) * 60_000).toISOString()
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`
}

/** The largest event the Stripe webhook reads. Stripe's events about a Checkout Session or a charge are a few kB. */
const MAX_EVENT_BYTES = 256 * 1024

const MAX_MESSAGES = 200
const MAX_TOKENS = 16_384
const MAX_CONTENT_CHARS = 200_000
const MAX_TOOLS = 64
const MAX_TOOL_CALLS = 32
const MAX_ID_CHARS = 256
const MAX_SCHEMA_DEPTH = 64
/** OpenAI's rule for function names. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/
const badRequest = (message: string) => new HttpError(400, 'bad_request', message)

/**
 * What a session token must say for its user to be an admin. `role` is a custom claim: the Clerk
 * instance's session token is customized to carry `"role": "{{user.public_metadata.role}}"`, and
 * an admin is a user whose public metadata in Clerk has `"role": "admin"`. Only Clerk's dashboard
 * and Backend API can write public metadata, so users cannot give themselves the role. `azp` is
 * the origin the token was issued to: admin requests come only from the admin page, which this
 * worker serves, so a token issued to the extension or to any other origin is not an admin's.
 */
const AdminClaims = z.object({ role: z.literal('admin'), azp: z.string() })

/** The product of a model call whose caller is no listed extension. */
const UNKNOWN_PRODUCT = 'unknown'

/** The PRODUCTS var: extension origins, each with a product name of lowercase letters. */
const Products = z.record(
  z.string().regex(/^chrome-extension:\/\/[a-p]{32}$/, { error: 'keys must be chrome-extension://<extension id>' }),
  z
    .string()
    .regex(/^[a-z]{1,32}$/, { error: 'product names are 1 to 32 lowercase letters' })
    .refine((name) => name !== UNKNOWN_PRODUCT, { error: `${UNKNOWN_PRODUCT} is not a product name` }),
)

/** The origin a session token was issued to, when it names one. */
const Azp = z.object({ azp: z.string().optional() })

/**
 * The product a model call comes from: the one PRODUCTS lists for the origin the session token was
 * issued to (its `azp`, which Clerk signs, so a client cannot pick it), or `unknown`. Unknown callers
 * are not refused: the product only sorts what was spent, credits are one balance across products.
 */
function productOf(env: Env, claims: unknown): string {
  const products = Products.optional().safeParse(env.PRODUCTS)
  if (!products.success) {
    throw new HttpError(503, 'not_configured', `PRODUCTS is invalid: ${products.error.issues[0].message}`)
  }
  const listed = products.data ?? {}
  const azp = Azp.safeParse(claims).data?.azp
  return azp !== undefined && Object.hasOwn(listed, azp) ? listed[azp] : UNKNOWN_PRODUCT
}

/** The most credits one grant by hand can give, and the longest it can last: a typo must not grant a fortune, or credits that never expire. */
const MAX_GRANT_CREDITS = 50_000
const MAX_GRANT_DAYS = 366
const DAY_MS = 24 * 60 * 60 * 1000

/** A Clerk user id, as far as its shape goes: the worker cannot ask Clerk whether the user exists. */
const UserId = part(z.string().regex(/^user_[A-Za-z0-9]{1,64}$/), 'the user id must look like user_… (a Clerk user id)')

const GrantBody = part(z.looseObject({}), 'body must be a JSON object').pipe(
  z.object({
    credits: part(
      z.int().min(1).max(MAX_GRANT_CREDITS),
      `credits must be a whole number from 1 to ${MAX_GRANT_CREDITS}`,
    ),
    days: part(z.int().min(1).max(MAX_GRANT_DAYS), `days must be a whole number from 1 to ${MAX_GRANT_DAYS}`),
  }),
)

/** The longest period the overview covers, and the most accounts one list shows: one request never reads more of the tables than this. */
const MAX_PERIOD_DAYS = 92
const MAX_ACCOUNTS = 200
const DEFAULT_ACCOUNTS = 50
/** No clock is further from UTC than 14 hours. */
const MAX_UTC_OFFSET = 14 * 60

/** A calendar date of this century written YYYY-MM-DD, as the UTC midnight that starts it. */
const CalendarDate = z
  .string()
  .regex(/^20\d{2}-\d{2}-\d{2}$/)
  .transform((date, ctx) => {
    const ms = Date.parse(`${date}T00:00:00Z`)
    // A date that does not exist (02-30) is either not parsed or moved to another day.
    if (!Number.isNaN(ms) && new Date(ms).toISOString().startsWith(date)) return ms
    ctx.addIssue({ code: 'custom', message: 'not a date' })
    return z.NEVER
  })

/** A whole number as a query parameter carries it. */
const WholeNumber = z
  .string()
  .regex(/^-?\d{1,6}$/)
  .transform(Number)

/**
 * The period an admin asks for, as query parameters: its first and last day, both counted in full,
 * and how many minutes the admin's clock is ahead of UTC (0 when not given: UTC days). The worker
 * does not know the admin's time zone, so the page sends its own offset.
 */
const PeriodQuery = z
  .object({
    from: part(CalendarDate, 'from must be a date like 2026-11-12'),
    to: part(CalendarDate, 'to must be a date like 2026-11-12'),
    utcOffset: part(
      WholeNumber.pipe(z.int().min(-MAX_UTC_OFFSET).max(MAX_UTC_OFFSET)),
      `utcOffset must be a whole number of minutes from -${MAX_UTC_OFFSET} to ${MAX_UTC_OFFSET}`,
    ).optional(),
  })
  .transform(({ from, to, utcOffset = 0 }, ctx): Period => {
    const days = (to - from) / DAY_MS + 1
    if (days < 1) ctx.addIssue({ code: 'custom', message: 'to must not be before from' })
    else if (days > MAX_PERIOD_DAYS) {
      ctx.addIssue({ code: 'custom', message: `the period must be at most ${MAX_PERIOD_DAYS} days` })
    }
    // Midnight on the admin's clock is that much before (or after) midnight UTC.
    const offsetMs = utcOffset * 60_000
    return { from: from - offsetMs, to: to + DAY_MS - offsetMs, utcOffset }
  })

const AccountsLimit = part(
  WholeNumber.pipe(z.int().min(1).max(MAX_ACCOUNTS)),
  `limit must be a whole number from 1 to ${MAX_ACCOUNTS}`,
).optional()

/** How many recent days of spending a user is shown, today included. */
const USAGE_DAYS = 30
const MINUTE_MS = 60 * 1000

/**
 * How far the user's clock is ahead of UTC, in minutes, as the side panel sends it: the worker does
 * not know the user's time zone, and a day of usage should be the user's own day. Bounded to the
 * offsets that exist (UTC-12:00 to UTC+14:00). Without it, days are UTC days.
 */
const UtcOffset = part(
  z
    .string()
    .regex(/^-?\d{1,3}$/)
    .transform(Number)
    .pipe(z.int().min(-720).max(840))
    .default(0),
  'utc_offset must be a whole number of minutes from -720 to 840',
)

/** A day counted from 1970-01-01, as a date: YYYY-MM-DD. */
const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10)

/** The day a period of usage ends before, as the side panel sends it: a date, as a day counted from 1970-01-01. */
const UsageBefore = part(
  CalendarDate.transform((ms) => ms / DAY_MS).optional(),
  'before must be a date like 2026-11-12',
)

/**
 * Where a page of grants starts, as the page before it gave it in `next`: a time in ms, and how
 * many grants of that millisecond were shown already. Both bounded, so the query is.
 */
const GrantsBefore = part(
  z
    .string()
    .regex(/^\d{1,15}\.\d{1,4}$/)
    .transform((cursor): GrantsCursor => {
      const [at, skip] = cursor.split('.').map(Number)
      return { at, skip }
    })
    .optional(),
  'before must be the next of an earlier page',
)
const cursorText = ({ at, skip }: GrantsCursor) => `${at}.${skip}`

/**
 * A user's credits as the side panel shows them. Amounts stay in micro-credits; the panel rounds
 * them. Only what is the user's to see: a grant made by hand does not name the admin who made it.
 */
const creditsJson = ({ balance, free, grants, usage }: Standing) => ({
  balance,
  free: free.started ? free : { ...free, lastsMs: FREE_PERIOD_MS },
  grants: grants.map(({ source, left, expiresAt }) => ({ source, left, expiresAt })),
  usage: {
    days: USAGE_DAYS,
    byDay: usage.map(({ day, microCredits }) => ({ day: dateOf(day), microCredits })),
  },
})

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Whether a value can be read as a stream. Judged by the method the worker calls, not by class: the
 * AI binding's stream need not be an instance of this module's `ReadableStream`.
 */
function isStream(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof value === 'object' && 'getReader' in value && typeof value.getReader === 'function'
}

/** Whether a JSON value nests objects or arrays more than `max` levels deep. Stops at `max`, so it can't overflow. */
function nestedDeeperThan(value: unknown, max: number): boolean {
  if (!value || typeof value !== 'object') return false
  if (max === 0) return true
  return Object.values(value).some((child) => nestedDeeperThan(child, max - 1))
}

// What the worker accepts in a chat request. Every part is a zod schema that keeps only the fields
// the model needs, so anything else a client added is dropped. A request is refused with the first
// thing wrong with it, in the words below: the client is told what the part needs, not zod's own
// description of the mismatch.

/** `schema`, refused with `message` whatever is wrong inside it. */
function part<S extends z.ZodType>(schema: S, message: string) {
  return z.unknown().transform((value, ctx): z.output<S> => {
    const parsed = schema.safeParse(value)
    if (parsed.success) return parsed.data
    ctx.addIssue({ code: 'custom', message })
    return z.NEVER
  })
}

/** The value as `schema` gives it, or a 400 with the first thing wrong with it. */
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  throw badRequest(parsed.error.issues[0].message)
}

/** The body: a JSON object. Its fields are checked one by one, in the order the refusals are given. */
const Body = part(
  z.object({
    messages: z.unknown().optional(),
    tools: z.unknown().optional(),
    tool_choice: z.unknown().optional(),
    max_tokens: z.unknown().optional(),
    stream: z.unknown().optional(),
    model: z.unknown().optional(),
  }),
  'body must be a JSON object',
)

/**
 * A tool call's id: 1 to 256 characters as JavaScript counts them. Not `.max()`: zod counts a string
 * over the limit by code point, which would let an id of emoji be twice as long.
 */
const isId = (id: string) => id.length > 0 && id.length <= MAX_ID_CHARS
const Id = z.string().refine(isId)
const ToolName = z.string().regex(TOOL_NAME)

const ToolCalls = part(
  z.array(z.unknown()).min(1).max(MAX_TOOL_CALLS),
  `tool_calls must be an array of 1 to ${MAX_TOOL_CALLS} calls`,
).pipe(
  z.array(
    part(
      z.object({
        id: Id,
        type: z.literal('function'),
        function: z.object({ name: ToolName, arguments: z.string() }),
      }),
      'each tool call needs an id, type "function", and a function with a name and string arguments',
    ),
  ),
)

/** An assistant message: its text, or the tools it called, with text or without. */
const AssistantMessage = z
  .object({ role: z.literal('assistant'), content: z.unknown().optional(), tool_calls: z.unknown().optional() })
  .transform((m, ctx) => {
    const refuse = (message: string) => {
      ctx.addIssue({ code: 'custom', message })
      return z.NEVER
    }
    if (m.tool_calls === undefined || m.tool_calls === null) {
      if (typeof m.content !== 'string') return refuse('assistant messages need string content or tool_calls')
      return { role: m.role, content: m.content }
    }
    if (m.content !== undefined && m.content !== null && typeof m.content !== 'string') {
      return refuse('assistant content must be a string or null')
    }
    const calls = ToolCalls.safeParse(m.tool_calls)
    if (!calls.success) return refuse(calls.error.issues[0].message)
    // The model accepts an empty string next to tool calls; OpenAI clients often send null.
    return { role: m.role, content: m.content ?? '', tool_calls: calls.data }
  })

const TOOL_MESSAGE = 'tool messages need a tool_call_id and string content'

/** One message, with the fields the model needs for its role. */
const Message = part(z.looseObject({}), 'each message must be an object').pipe(
  z.discriminatedUnion(
    'role',
    [
      z.object({ role: z.literal('system'), content: z.string({ error: 'system messages need string content' }) }),
      z.object({ role: z.literal('user'), content: z.string({ error: 'user messages need string content' }) }),
      AssistantMessage,
      z.object({
        role: z.literal('tool'),
        tool_call_id: z.string({ error: TOOL_MESSAGE }).refine(isId, { error: TOOL_MESSAGE }),
        content: z.string({ error: TOOL_MESSAGE }),
      }),
    ],
    { error: 'each message needs a role: system, user, assistant, or tool' },
  ),
)

const Messages = part(z.array(z.unknown()).min(1), 'messages must be a non-empty array')
  .refine((messages) => messages.length <= MAX_MESSAGES, { error: `at most ${MAX_MESSAGES} messages`, abort: true })
  .pipe(z.array(Message))

const TOOL = 'each tool needs type "function" and a function definition'
const TOOL_NAMES = 'tool names are 1 to 64 letters, digits, underscores, or dashes'

/** A tool as far as its name: a function tool. What else its function holds is read after the name is known to be new. */
const ToolHead = z.object(
  {
    type: z.literal('function', { error: TOOL }),
    function: z.looseObject(
      { name: z.string({ error: TOOL_NAMES }).regex(TOOL_NAME, { error: TOOL_NAMES }) },
      { error: TOOL },
    ),
  },
  { error: TOOL },
)

const ToolBody = z.object({
  description: z.string({ error: 'tool descriptions must be strings' }).optional(),
  // Passed on as it is. Bounded, so serializing the request (here and in the AI binding) can never
  // run out of stack.
  parameters: z
    .custom<Record<string, unknown>>(isObject, { error: 'tool parameters must be an object' })
    .refine((parameters) => !nestedDeeperThan(parameters, MAX_SCHEMA_DEPTH), {
      error: `tool parameters are nested more than ${MAX_SCHEMA_DEPTH} levels deep`,
    })
    .optional(),
})

/**
 * The tool definitions: function tools only, with unique names. Tools are read one at a time, so the
 * first thing wrong in the list is what the client is told.
 */
const Tools = part(
  z.array(z.unknown()).min(1).max(MAX_TOOLS),
  `tools must be an array of 1 to ${MAX_TOOLS} tools`,
).transform((list, ctx) => {
  const refuse = (message: string) => {
    ctx.addIssue({ code: 'custom', message })
    return z.NEVER
  }
  const names = new Set<string>()
  const tools: { type: 'function'; function: { name: string } & z.output<typeof ToolBody> }[] = []
  for (const item of list) {
    const head = ToolHead.safeParse(item)
    if (!head.success) return refuse(head.error.issues[0].message)
    const { name } = head.data.function
    if (names.has(name)) return refuse(`tool ${name} is defined twice`)
    names.add(name)
    const body = ToolBody.safeParse(head.data.function)
    if (!body.success) return refuse(body.error.issues[0].message)
    tools.push({ type: 'function', function: { name, ...body.data } })
  }
  return tools
})

// `none` is left out on purpose: the model ignores it and writes fake tool calls into the reply text.
// Clients that want no tool calls leave out `tools`.
const ToolChoice = part(
  z.union([
    z.enum(['auto', 'required']),
    z.object({ type: z.literal('function'), function: z.object({ name: ToolName }) }),
  ]),
  'tool_choice must be auto, required, or {"type":"function","function":{"name":...}}',
)

const MaxTokens = part(z.int().min(1).max(MAX_TOKENS), `max_tokens must be an integer from 1 to ${MAX_TOKENS}`)
const Stream = part(z.boolean().optional(), 'stream must be a boolean')

type Tools = z.output<typeof Tools>

/** What the model gets: the fields it needs from each part of the request, nothing else. */
interface ModelInputs {
  messages: z.output<typeof Messages>
  tools?: Tools
  tool_choice?: z.output<typeof ToolChoice>
}

function parseToolChoice(value: unknown, tools: Tools | undefined): z.output<typeof ToolChoice> {
  if (!tools) throw badRequest('tool_choice needs tools')
  if (value === 'none') throw badRequest('tool_choice none is not supported; leave out tools instead')
  const choice = parse(ToolChoice, value)
  if (typeof choice === 'string') return choice
  const { name } = choice.function
  if (!tools.some((tool) => tool.function.name === name)) {
    throw badRequest(`tool_choice names an unknown tool: ${name}`)
  }
  return choice
}

/**
 * Validates the conversation and tools, and returns only what the model needs.
 * `chars` counts message text, tool calls and results, and tool definitions, so tools can't get around
 * the size limit.
 */
function parseModelInputs(body: z.output<typeof Body>): { inputs: ModelInputs; chars: number } {
  const inputs: ModelInputs = { messages: parse(Messages, body.messages) }
  if (body.tools !== undefined && body.tools !== null) inputs.tools = parse(Tools, body.tools)
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
    chars += m.content.length
    if (m.role === 'tool') {
      if (!pending.delete(m.tool_call_id)) {
        throw badRequest('each tool message must answer a call from the assistant message before it')
      }
      chars += m.tool_call_id.length
      continue
    }
    if (pending.size) throw unanswered()
    const toolCalls = 'tool_calls' in m ? m.tool_calls : undefined
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

export function createApp({
  now = () => new Date(),
  priceOf: priceFor = priceOf,
  logError = (line) => console.error(line),
  logAdmin = (line) => console.log(line),
  logBilling = (line) => console.log(line),
}: AppOptions = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>()

  // The extension calls from a chrome-extension:// origin. Auth is a bearer token, not cookies.
  app.use('*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type'], maxAge: 86400 }))

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status)
    logError(`request failed: ${errorSummary(err)}`)
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

  // Admin page: look up an account's credits and grant credits by hand. The page holds no data;
  // everything it shows comes from /v1/admin/*, which checks the session and the admin role.
  app.get('/admin', (c) => {
    if (!c.env.CLERK_PUBLISHABLE_KEY) throw new HttpError(503, 'not_configured', 'CLERK_PUBLISHABLE_KEY is not set')
    // No other site may frame it, so none can trick an admin into clicking through a grant.
    c.header('content-security-policy', "frame-ancestors 'none'")
    c.header('x-frame-options', 'DENY')
    return c.html(adminPage(c.env.CLERK_PUBLISHABLE_KEY))
  })

  // Where Stripe's Checkout sends the buyer back: a page that says what happened and leads back to
  // the side panel. It holds nothing and changes nothing: credits are added by the webhook below.
  app.get('/billing/paid', (c) => c.html(billingPage('paid')))
  app.get('/billing/cancelled', (c) => c.html(billingPage('cancelled')))

  // Stripe's webhook. No Clerk session: the event is trusted only when it carries Stripe's
  // signature, made with the endpoint's signing secret. It answers 2xx once the event is handled or
  // is one the worker does not act on; anything else makes Stripe send the event again later, which
  // is safe, since a payment grants once and a purchase is taken back once.
  app.post('/stripe/webhook', async (c) => {
    const secret = c.env.STRIPE_WEBHOOK_SECRET
    if (!secret) throw new HttpError(503, 'not_configured', 'STRIPE_WEBHOOK_SECRET is not set')
    const length = Number(c.req.header('content-length') ?? 0)
    if (length > MAX_EVENT_BYTES) throw new HttpError(413, 'too_large', 'event too large')
    const payload = await c.req.text()
    if (payload.length > MAX_EVENT_BYTES) throw new HttpError(413, 'too_large', 'event too large')
    const event = await verifiedEvent(payload, c.req.header('stripe-signature'), secret, now().getTime())
    if (event === undefined) throw new HttpError(400, 'bad_signature', 'not signed by Stripe')
    // Granting a purchase reads its line items from Stripe, so the webhook needs buying set up too.
    const { stripe } = billing(c.env)
    let handled
    try {
      handled = await handleEvent(c.env.DB, stripe, now().getTime(), event)
    } catch (err) {
      // An event the worker could not handle: the database failed, or the event is not what the
      // worker expects. Nothing is guessed; Stripe sends it again, and the log says why.
      logError(`stripe event failed: ${errorSummary(err)}`)
      throw new HttpError(500, 'internal', 'the event could not be handled')
    }
    if (handled.log) logBilling(handled.log)
    if (handled.done === 'retry') throw new HttpError(409, 'not_yet', 'the payment has made no grant yet')
    return c.json({ received: true, done: handled.done })
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
    // Clerk sets azp to the origin that requested the token: chrome-extension://<id> for an
    // extension, this worker's origin for the admin page. A token with an azp must come from an
    // allowed origin; one with none (no origin asked for it) is let through, as before.
    const azp = typeof claims.azp === 'string' ? claims.azp : undefined
    if (azp && !authorizedParties.includes(azp)) {
      throw new HttpError(401, 'unauthorized', 'invalid or expired session')
    }
    c.set('userId', claims.sub)
    c.set('claims', claims)
    await next()
  })

  // ---- Admin: /v1/admin/* needs a session whose token says its user is an admin ----

  app.use('/v1/admin/*', async (c, next) => {
    // One refusal for every reason, and for every path, existing or not: someone who is not an
    // admin learns nothing about what is here.
    const claims = AdminClaims.safeParse(c.get('claims'))
    if (!claims.success || claims.data.azp !== new URL(c.req.url).origin) {
      throw new HttpError(403, 'forbidden', 'This account is not an admin.')
    }
    await next()
  })

  /** An account as the admin page shows it. Amounts stay in micro-credits; the page rounds them. */
  const accountJson = (userId: string, account: Account) => ({ userId, ...account })

  /** Runs one call on a user's ledger, or refuses the request with `message` when the call fails. */
  async function onLedger(c: Ctx, userId: string, message: string, call: (ledger: Ledger) => Promise<Account>) {
    try {
      return await call(new Ledger(c.env.DB, userId))
    } catch (err) {
      logError(`admin ledger call failed: ${errorSummary(err)}`)
      throw new HttpError(503, 'credits_unavailable', message)
    }
  }

  app.get('/v1/admin/accounts/:userId', async (c) => {
    const userId = parse(UserId, c.req.param('userId'))
    const unavailable = 'Credits are unavailable, try again in a moment.'
    const account = await onLedger(c, userId, unavailable, (ledger) => ledger.read(now().getTime()))
    return c.json(accountJson(userId, account))
  })

  /** Runs a read across accounts, or refuses the request when it fails. */
  async function onOverview<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read()
    } catch (err) {
      logError(`admin overview failed: ${errorSummary(err)}`)
      throw new HttpError(503, 'credits_unavailable', 'Credits are unavailable, try again in a moment.')
    }
  }

  // What was granted and spent in a period across every account, in all and per day.
  app.get('/v1/admin/overview', async (c) => {
    const period = parse(PeriodQuery, c.req.query())
    const overview = await onOverview(() => readOverview(c.env.DB, period))
    return c.json({ period, ...overview })
  })

  // The accounts with a grant or a model call in a period, the biggest spenders first.
  app.get('/v1/admin/accounts', async (c) => {
    const period = parse(PeriodQuery, c.req.query())
    const limit = parse(AccountsLimit, c.req.query('limit')) ?? DEFAULT_ACCOUNTS
    // The balances are as of this moment, like an account's own lookup.
    const at = now().getTime()
    const accounts = await onOverview(() => readAccounts(c.env.DB, period, at, limit))
    return c.json({ period, at, ...accounts })
  })

  app.post('/v1/admin/accounts/:userId/grants', async (c) => {
    const userId = parse(UserId, c.req.param('userId'))
    const { credits, days } = parse(GrantBody, await c.req.json().catch(() => undefined))
    const at = now().getTime()
    const grant = { amount: credits * MICRO_CREDITS, expiresAt: at + days * DAY_MS, by: c.get('userId') }
    // A call that fails may still have written the grant, and granting again would give it twice:
    // the admin is told to look before trying again, not to try again.
    const unknown = 'The grant may or may not have been made. Look the account up before granting again.'
    const account = await onLedger(c, userId, unknown, (ledger) => ledger.grant(at, grant))
    // The record of who granted what to whom. Ids, numbers, and a time only: both ids are bounded
    // (the target by its shape, the admin's by the cut here), and nothing else of the request is logged.
    const admin = grant.by.slice(0, MAX_ID_CHARS)
    logAdmin(
      `manual grant: admin=${admin} user=${userId} credits=${credits} expires=${new Date(grant.expiresAt).toISOString()}`,
    )
    return c.json(accountJson(userId, account))
  })

  app.get('/v1/me', (c) => c.json({ userId: c.get('userId'), model: c.env.MODEL }))

  /** What is on sale, and Stripe's API to sell it: or a refusal when buying is not set up. */
  function billing(env: Env): { offer: Offer; stripe: StripeApi } {
    const offered = offerOf(env.CREDIT_PRICE, env.CREDIT_PACKS)
    if ('error' in offered) throw new HttpError(503, 'not_configured', `${offered.error}`)
    const stripe = env.STRIPE ?? (env.STRIPE_SECRET_KEY ? stripeOverHttp(env.STRIPE_SECRET_KEY) : undefined)
    if (!stripe || !offered.offer) throw new HttpError(503, 'not_configured', 'buying credits is not set up')
    return { offer: offered.offer, stripe }
  }

  // The packs of credits a signed-in user can buy, smallest first: each a quantity of the credit
  // price, US$1 for 1,000 credits, with its credits and its price in US cents. Checkout may show the
  // price in the buyer's currency, with tax.
  app.get('/v1/billing/packs', (c) => {
    const { offer } = billing(c.env)
    return c.json({
      packs: offer.quantities.map((quantity) => ({
        quantity,
        credits: quantity * CREDITS_PER_UNIT,
        usdCents: quantity * 100,
      })),
    })
  })

  // Starts buying a pack: makes a Stripe Checkout Session for it, for the signed-in user, and gives
  // the URL of its page, which the side panel opens in a new tab. Nothing is granted here: the
  // webhook grants the credits once Stripe says the payment went through.
  app.post('/v1/billing/checkout', async (c) => {
    const { offer, stripe } = billing(c.env)
    const { quantity } = parse(
      part(z.object({ quantity: z.int() }), 'body must be {"quantity": <a pack\'s quantity>}'),
      await c.req.json().catch(() => undefined),
    )
    if (!offer.quantities.includes(quantity)) {
      throw badRequest(`quantity must be one of the packs on sale: ${offer.quantities.join(', ')}`)
    }
    const origin = new URL(c.req.url).origin
    try {
      const { url } = await stripe.createCheckout({
        price: offer.price,
        quantity,
        credits: quantity * CREDITS_PER_UNIT,
        userId: c.get('userId'),
        successUrl: `${origin}/billing/paid`,
        cancelUrl: `${origin}/billing/cancelled`,
      })
      return c.json({ url })
    } catch (err) {
      logError(`checkout failed: ${errorSummary(err)}`)
      throw new HttpError(502, 'payment_unavailable', 'Checkout is unavailable, try again in a moment.')
    }
  })

  // The signed-in user's own credits, for the side panel: what is left, when it expires and when
  // more arrive, and what was spent per day. It only reads: the weekly free grant still waits for
  // the user's next question, and is reported as not started until then.
  app.get('/v1/credits', async (c) => {
    const offsetMs = parse(UtcOffset, c.req.query('utc_offset')) * MINUTE_MS
    const period = { days: USAGE_DAYS, offsetMs }
    return c.json(creditsJson(await onOwnLedger(c, (ledger) => ledger.look(now().getTime(), period))))
  })

  /** Runs a read of the caller's own credits, or refuses the request when it fails. */
  async function onOwnLedger<T>(c: Ctx, read: (ledger: Ledger) => Promise<T>): Promise<T> {
    try {
      return await read(new Ledger(c.env.DB, c.get('userId')))
    } catch (err) {
      logError(`credit read failed: ${errorSummary(err)}`)
      throw new HttpError(503, 'credits_unavailable', 'Credits are unavailable, try again in a moment.')
    }
  }

  // The history of the signed-in user's credits, read by the side panel only when the user opens
  // it, a page at a time, so the read above stays small. Both only read, for the caller only.

  // Every grant the user was given, newest first, the expired ones included, with what is left of
  // each (for an expired one: what went unspent). Never the admin who made a grant by hand.
  app.get('/v1/credits/grants', async (c) => {
    const from = parse(GrantsBefore, c.req.query('before'))
    const { grants, next } = await onOwnLedger(c, (ledger) => ledger.grantsPage(from))
    return c.json({
      grants: grants.map(({ source, amount, left, grantedAt, expiresAt, revoked }) => ({
        source,
        amount,
        left,
        grantedAt,
        expiresAt,
        // A purchase taken back ended at `expiresAt`, and `left` is what was taken back.
        ...(revoked ? { revoked } : {}),
      })),
      next: next ? cursorText(next) : null,
    })
  })

  // Credits used per day over one period as long as the one /v1/credits reports, by the same days:
  // the most recent one, or the one that ends before `before`. `earlier` is the `before` that
  // leads to the user's usage before this period, skipping the days they made no call.
  app.get('/v1/credits/usage', async (c) => {
    const offsetMs = parse(UtcOffset, c.req.query('utc_offset')) * MINUTE_MS
    const before = parse(UsageBefore, c.req.query('before'))
    const period = { days: USAGE_DAYS, offsetMs, ...(before === undefined ? {} : { before }) }
    const { first, last, usage, earlier } = await onOwnLedger(c, (ledger) => ledger.usage(now().getTime(), period))
    return c.json({
      from: dateOf(first),
      to: dateOf(last),
      byDay: usage.map(({ day, microCredits }) => ({ day: dateOf(day), microCredits })),
      earlier: earlier === undefined ? null : dateOf(earlier),
    })
  })

  // OpenAI-compatible chat completions. The model is fixed by the server.
  // Every request that passed auth leaves one usage record, however it ends.
  app.post('/v1/chat/completions', async (c) => {
    const started = Date.now()
    const usage: UsageRecord = {
      userId: c.get('userId'),
      product: UNKNOWN_PRODUCT,
      model: c.env.MODEL,
      stream: false,
      outcome: '',
      messages: 0,
      inputChars: 0,
      promptTokens: 0,
      cachedTokens: 0,
      completionTokens: 0,
      microCredits: 0,
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
    const product = productOf(c.env, c.get('claims'))
    usage.product = product
    const body = parse(Body, await c.req.json().catch(() => undefined))
    usage.stream = body.stream === true
    const { inputs: modelInputs, chars } = parseModelInputs(body)
    usage.messages = modelInputs.messages.length
    usage.inputChars = chars
    if (chars > MAX_CONTENT_CHARS)
      throw new HttpError(400, 'bad_request', `messages and tools exceed ${MAX_CONTENT_CHARS} characters`)
    // null means not set.
    const max_tokens =
      body.max_tokens === undefined || body.max_tokens === null ? undefined : parse(MaxTokens, body.max_tokens)
    const stream = parse(Stream, body.stream)
    if (body.model !== undefined && body.model !== c.env.MODEL) {
      // A distinct code lets a client that cached the old model name notice and look it up again.
      throw new HttpError(400, 'unsupported_model', `unsupported model; use ${c.env.MODEL} or omit it`)
    }

    const price = priceFor(c.env.MODEL)
    if (!price) throw new HttpError(503, 'not_configured', 'MODEL has no price')

    // Charged after use: a call goes ahead while the user has credits, and its cost is taken when
    // the reply ends. The last call may take the balance below zero; the next grant pays that back
    // first. Calls sent at once all start on the same balance, so together they can overspend by
    // more than one call: accepted, since one call costs little and what was overspent is owed.
    const maxTokens = max_tokens ?? MAX_TOKENS
    const ledger = new Ledger(c.env.DB, c.get('userId'))
    let balance: Balance
    try {
      balance = await ledger.open(now().getTime())
    } catch (err) {
      logError(`credit check failed: ${errorSummary(err)}`)
      throw new HttpError(503, 'credits_unavailable', 'Credits are unavailable, try again in a moment.')
    }
    if (balance.balance <= 0) {
      throw new HttpError(
        402,
        'out_of_credits',
        `You have no credits left. Your next ${FREE_CREDITS} free credits arrive on ${utcMinute(balance.nextGrantAt)}, or you can buy credits.`,
      )
    }

    /**
     * Ends the call, once: records it in the database with how it ended and its tokens, takes what
     * it cost from the user's credits, and puts the cost in the usage record. Every call that
     * reached the model is recorded, failed ones too; one that failed costs nothing. A record that
     * fails is logged and the reply still goes out: the model has already answered.
     */
    const startedAt = now().getTime()
    let ended = false
    const endCall = async (outcome: string, tokens: Tokens, finish: string, estimated: boolean) => {
      if (ended) return
      ended = true
      const cost = costOf(price, tokens)
      try {
        await ledger.endCall({
          product,
          model: c.env.MODEL,
          startedAt,
          endedAt: Math.max(startedAt, now().getTime()),
          stream: stream === true,
          outcome,
          finishReason: finish,
          ...tokens,
          estimated,
          cost,
        })
        usage.microCredits = cost
      } catch (err) {
        logError(`model call record failed: ${errorSummary(err)}`)
      }
    }
    const nothing: Tokens = { promptTokens: 0, cachedTokens: 0, completionTokens: 0 }

    const call = callModel().catch(async (err: unknown) => {
      await endCall(err instanceof HttpError ? err.code : 'internal', nothing, '', false)
      throw err
    })
    // The model is called and the call charged even if the client goes away meanwhile: a request
    // dropped right after it was sent must not be a free call.
    c.executionCtx.waitUntil(call.catch(() => {}))
    return await call

    async function callModel(): Promise<Response> {
      // Pass only the fields the model needs; drop anything else a client added.
      const inputs: Record<string, unknown> = { ...modelInputs }
      // Without an explicit limit, models fall back to their own default, which can be
      // small enough to cut replies short.
      inputs.max_tokens = maxTokens
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
              metadata: { product, user: c.get('userId') },
            },
          }
        : undefined

      let out: unknown
      try {
        out = await c.env.AI.run(c.env.MODEL, inputs, options)
      } catch (err) {
        // A summary goes to Workers Logs, not to the client. Never log the error itself: nothing
        // shows that what the provider returns can't quote the request.
        logError(`model call failed: ${errorSummary(err)}`)
        throw new HttpError(502, 'provider_error', 'the model is unavailable, try again later')
      }

      if (stream === true) {
        // Workers AI already streams OpenAI-style SSE; pass it through, reading usage on the way.
        if (!isStream(out)) throw new Error('the model returned no stream')
        const settle = async (outcome: string, summary: StreamSummary) => {
          const { promptTokens, cachedTokens, completionTokens } = summary
          const tokens: Tokens = { promptTokens, cachedTokens, completionTokens }
          // A reply the user stopped, or a stream that broke off, costs what it used. Its totals come
          // in the stream's last chunks, which never arrived, so they are estimated: the prompt from
          // the size of the input when no chunk gave it, the reply from the characters that were
          // streamed (never below what the stream did report), and the part of the prompt read from
          // the cache as a fixed share of it, since nothing says how much it was.
          // Two cases cost what the stream reported and no more. One that ran to its end has its
          // totals, even when the client stopped reading right there. And one that broke off before
          // it reported or carried anything is a call that failed without usage: it costs nothing.
          // (A reply the user stopped that early is still charged its prompt: the model was reading it.)
          const cutShort = outcome === 'cancelled' || outcome === 'incomplete' || outcome === 'stream_error'
          const empty = outcome !== 'cancelled' && !promptTokens && !completionTokens && !summary.replyChars
          const estimated = cutShort && !summary.ended && !empty
          if (estimated) {
            tokens.promptTokens ||= estimateTokens(chars)
            tokens.cachedTokens = estimateCachedTokens(tokens.promptTokens)
            tokens.completionTokens = Math.max(tokens.completionTokens, estimateTokens(summary.replyChars))
          }
          usage.promptTokens = tokens.promptTokens
          usage.cachedTokens = tokens.cachedTokens
          usage.completionTokens = tokens.completionTokens
          usage.finishReason = summary.finishReason
          await endCall(outcome, tokens, summary.finishReason, estimated)
          record(outcome)
        }
        const metered = meterStream(
          out,
          (outcome, summary) => {
            const settled = settle(outcome, summary)
            // A client that went away must not take the charge with it.
            c.executionCtx.waitUntil(settled)
            return settled
          },
          (err) => logError(`model stream failed: ${errorSummary(err)}`),
        )
        return new Response(metered, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        })
      }
      const reply = replyInfo(out)
      const tokens = tokensOf(reply?.usage)
      Object.assign(usage, tokens)
      usage.finishReason = finishReason(reply?.finish_reason)
      // The reply as the model gave it. Build the response first: if that throws, the request is
      // recorded once, as internal, and nothing is charged.
      const res = c.newResponse(JSON.stringify(out), 200, { 'content-type': 'application/json' })
      await endCall('ok', tokens, usage.finishReason, false)
      record('ok')
      return res
    }
  }

  return app
}
