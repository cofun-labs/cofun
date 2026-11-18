// The client for the Cofun Worker every extension calls: which model it serves, the signed-in user's
// own credits and the purchases they start, and the web pages and searches it reads for an
// extension. Each request carries a fresh Clerk session token (they expire within minutes). The
// hosted model's own requests are made by the extension's agent, with what `token`, `modelHeaders`,
// `turnHeaders`, and `callCost` give it.
//
// The worker's answers are what this module parses: it must keep reading what the worker sends to
// the extension versions on the Chrome Web Store, and nothing else in the extension reads them.
import { CheckoutPage, Credits, Grants, Packs, type PastGrant } from './credits'
import { z } from './zod'

const SIGN_IN = 'Please sign in first.'

/** Where the worker is, who asks, and for which extension. */
export interface WorkerClientOptions {
  /** Base URL including /v1. */
  apiUrl: string
  /** Returns a fresh Clerk session token, or null when nobody is signed in. Called before every request. */
  getToken: () => Promise<string | null>
  /**
   * The extension and its version, `notico/0.3.0`: sent with each request that spends credits as
   * X-Cofun-Client, which records the call under that product.
   */
  clientName: string
  /** The extension's name as its users know it, `Notico`: used only in what the user is told. */
  product: string
}

/**
 * Which chat (a session's id) and which question of it (an id made for the question) a request to
 * the worker is for, sent as X-Cofun-Chat-Id and X-Cofun-Turn-Id, so the worker records what the
 * request spent with them. Random ids: they say nothing about the content.
 */
export interface Turn {
  chat?: string
  turn?: string
}

/** The headers that tell the worker which chat and question a request is for (see Turn); none it doesn't know. */
export function turnHeaders({ chat, turn }: Turn = {}): Record<string, string> {
  return { ...(chat && { 'x-cofun-chat-id': chat }), ...(turn && { 'x-cofun-turn-id': turn }) }
}

/** What one model call cost, as the worker charged it: in micro-credits, and whether from estimated tokens. */
export interface CallCost {
  microCredits: number
  estimated: boolean
}

/**
 * What the worker says a model call cost: in its own chunk, the last of the stream before `[DONE]`
 * (and in the body of a reply that isn't streamed). The worker is the only place that prices a call.
 */
const CostChunk = z.object({
  cost: z.object({ micro_credits: z.number().int().nonnegative(), estimated: z.boolean() }).optional(),
})

/**
 * The cost a chunk of the hosted model's stream carries, if it carries one. A cost that is not what
 * the extension expects throws, saying what is wrong: a reply must not show a number it could not read.
 */
export function callCost(chunk: unknown): CallCost | undefined {
  // Most chunks are the model's own, and carry no cost.
  if (!chunk || typeof chunk !== 'object' || !('cost' in chunk)) return undefined
  const cost = CostChunk.parse(chunk).cost
  return cost && { microCredits: cost.micro_credits, estimated: cost.estimated }
}

/** A web page the worker read. `scripted`: it showed little text and runs scripts. */
export const WebPage = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string(),
  chars: z.number().int().nonnegative(),
  scripted: z.boolean(),
})
export type WebPage = z.infer<typeof WebPage>

/** A result of a web search the worker made: a page's address, title, and description. */
export const WebSearchResult = z.object({ url: z.string(), title: z.string(), description: z.string() })
export type WebSearchResult = z.infer<typeof WebSearchResult>

/**
 * Why the worker could not read a web page or search the web: its code (`no_access`, `no_text`, …)
 * and message.
 */
export class WorkerError extends Error {
  /**
   * Set when the worker, or a service before or behind it, turned the request away: for coming too
   * often, for credits that ran out, or because the renderer or the search provider is busy. What
   * the user is told. Nothing more is to be sent to it for what the user asked.
   */
  readonly turnedAway?: string
  /** Set when the call was or may have been charged (a render, a search), so it is not to be made again. */
  readonly charged: boolean

  constructor(
    readonly code: string,
    message: string,
    { turnedAway, charged = false, cause }: { turnedAway?: string; charged?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause })
    this.name = 'WorkerError'
    if (turnedAway) this.turnedAway = turnedAway
    this.charged = charged
  }
}

/**
 * What a read or a search is for, besides its own arguments: `signal` stops it; `turn` is the chat
 * and question it is for; and for a paid one (a render, a search), `charged` gets what it cost in
 * micro-credits, or undefined when that is not known.
 */
export interface WebCall {
  signal?: AbortSignal
  turn?: Turn
  charged?: (microCredits: number | undefined) => void
}

// What the worker answers, as far as the client reads it. Each field is read loosely: one that is not
// text counts as missing, so an answer the client can't read ends in the fallback, never in a wrong value.
const looseText = z.string().optional().catch(undefined)

/** A refusal from the worker, as far as its message. */
const ErrorReply = z.object({ error: z.object({ message: looseText }).optional().catch(undefined) })

/** The worker's answer to `/me`: the model it uses, or why it refused. */
const MeReply = ErrorReply.extend({ model: looseText })

/** A refusal from the worker, with its code. */
const CodedError = z.object({ error: z.object({ code: looseText, message: looseText }) })

/** What a render or a search cost, as each of its answers says; a plain read, or one turned away first, says nothing. */
const Charged = z.object({ cost: z.object({ micro_credits: z.number().int().nonnegative() }).optional() })

/** The worker's answer to a search. */
const WebSearch = z.object({ results: z.array(WebSearchResult) })

/**
 * How far the user's clock is ahead of UTC, in minutes: the worker totals usage per day, and a day
 * should be the user's own.
 */
const utcOffset = () => String(-new Date().getTimezoneOffset())

/**
 * Whether a render or a search was or may have been charged, by the worker's answer, after calling
 * `charged` with what it cost in micro-credits, or with undefined when the answer does not say so,
 * so what it cost is not known. Results always say what they cost; a refusal only when the worker
 * rendered or searched.
 */
function chargedBy(res: Response, body: unknown, charged?: (microCredits: number | undefined) => void): boolean {
  const cost = Charged.safeParse(body)
  if (!cost.success || (res.ok && !cost.data.cost)) {
    charged?.(undefined)
    return true
  }
  if (!cost.data.cost) return false
  charged?.(cost.data.cost.micro_credits)
  return cost.data.cost.micro_credits > 0
}

/** The worker's refusal: its code and message, or the HTTP status when it gave none. */
function refusalOf(res: Response, body: unknown): { code: string; message: string } {
  const refusal = CodedError.safeParse(body).data?.error
  return { code: refusal?.code ?? `http_${res.status}`, message: refusal?.message ?? `HTTP ${res.status}` }
}

/** The client for the Cofun Worker (see WorkerClientOptions). */
export class WorkerClient {
  /** The worker's base URL, including /v1, without a trailing slash. */
  readonly baseUrl: string
  /** The headers a hosted model request carries besides its token: which extension asks (see `clientName`). */
  readonly modelHeaders: Record<string, string>
  private readonly getToken: () => Promise<string | null>
  private readonly clientName: string
  private readonly product: string

  constructor({ apiUrl, getToken, clientName, product }: WorkerClientOptions) {
    // Without a regular expression, which takes polynomial time on a run of slashes not at the end.
    let end = apiUrl.length
    while (end > 0 && apiUrl[end - 1] === '/') end--
    this.baseUrl = apiUrl.slice(0, end)
    this.getToken = getToken
    this.clientName = clientName
    this.product = product
    this.modelHeaders = { 'x-cofun-client': clientName }
  }

  /** A fresh session token for one request. Throws, asking the user to sign in, when nobody is. */
  token = async (): Promise<string> => {
    const value = await this.getToken()
    if (!value) throw new Error(SIGN_IN)
    return value
  }

  /** The model the worker serves, which it fixes: hosted model requests name it. Throws, in the worker's words when it gives them. */
  async model(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/me`, { headers: { authorization: `Bearer ${await this.token()}` } })
    const body = MeReply.safeParse(await res.json().catch(() => undefined)).data
    const model = body?.model
    if (!res.ok || !model) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
    return model
  }

  /**
   * The signed-in user's credits, with the usage per day of their own clock. Reading them changes
   * nothing. Throws when they can't be read, when the answer is not what the client expects, or
   * when `signal` aborts.
   */
  async credits({ signal }: { signal?: AbortSignal } = {}): Promise<Credits> {
    return this.readOwn('credits', { utc_offset: utcOffset() }, Credits, signal)
  }

  /** Every grant the user was given, newest first, the expired ones included. */
  async grants(): Promise<PastGrant[]> {
    return (await this.readOwn('credits/grants', {}, Grants)).grants
  }

  /** The packs of credits on sale. */
  async packs(): Promise<Packs> {
    return this.readOwn('billing/packs', {}, Packs)
  }

  /**
   * Starts buying the pack of `quantity` (a pack's quantity, as `packs` lists it): the worker makes
   * a Stripe Checkout Session for it, for the signed-in user, and gives the URL of its page, which
   * is only ever Stripe's. Nothing is bought until the user pays there.
   */
  async checkout(quantity: number): Promise<string> {
    const res = await fetch(`${this.baseUrl}/billing/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ quantity }),
    })
    const body: unknown = await res.json().catch(() => undefined)
    if (!res.ok) throw new Error(ErrorReply.safeParse(body).data?.error?.message ?? `HTTP ${res.status}`)
    return CheckoutPage.parse(body).url
  }

  /**
   * Has the worker read the web page at `url`, up to `maxChars` of its text; `render` renders it in
   * a browser first, for a page drawn by scripts, which costs credits. A plain read is free. Throws
   * a WorkerError when the page could not be read (see askWeb).
   */
  async readWebPage(url: string, maxChars: number, render: boolean, call: WebCall = {}): Promise<WebPage> {
    const how = { paid: render, failed: 'read_failed', turnedAway: this.readTurnedAway }
    const path = `web/${render ? 'render' : 'read'}`
    const { body, mayHaveCost } = await this.askWeb(path, { url, max_chars: maxChars }, how, call)
    const page = WebPage.safeParse(body)
    if (!page.success)
      throw new WorkerError('read_failed', this.unreadable, { charged: mayHaveCost, cause: page.error })
    return page.data
  }

  /**
   * Has the worker search the web for `query`, for at most `limit` results; it costs credits, so it
   * is never retried. Throws a WorkerError when the search failed (see askWeb).
   */
  async searchWeb(query: string, limit: number, call: WebCall = {}): Promise<WebSearchResult[]> {
    const how = { paid: true, failed: 'search_failed', turnedAway: this.searchTurnedAway }
    const { body, mayHaveCost } = await this.askWeb('web/search', { query, limit }, how, call)
    const answer = WebSearch.safeParse(body)
    if (!answer.success)
      throw new WorkerError('search_failed', this.unreadable, { charged: mayHaveCost, cause: answer.error })
    return answer.data.results
  }

  /** What the user is told when the worker's answer could not be read. */
  private get unreadable() {
    return `${this.product}'s service gave an answer ${this.product} could not read`
  }

  /**
   * What the user is told when a 429 without a code of the worker's turns a read or a search away:
   * one sent before the worker (by Cloudflare, say), for coming too often.
   */
  private get tooOften() {
    return `${this.product}'s service turned away its requests for coming too often. Wait a minute, then ask again.`
  }

  /**
   * What the user is told when the worker's answer to a read turned it away, or undefined when it
   * didn't: for coming too often, or for credits that ran out. Any other failure is the caller's to
   * handle: a read changes nothing and involves no account of the user's (CLAUDE.md, "Calling
   * outside services").
   */
  private readTurnedAway = (code: string, message: string): string | undefined => {
    if (code === 'rate_limited')
      return `${this.product} read too many web pages in a minute. Wait a minute, then ask again.`
    if (code === 'http_429') return this.tooOften
    // The worker's own words: they say when the next free credits arrive.
    if (code === 'out_of_credits') return message
    if (code === 'site_busy')
      return `A site turned away ${this.product}'s requests for coming too often. Wait a while, then ask again.`
    // The browser that renders pages turned the render away: another would be turned away too.
    if (code === 'render_busy') return `${this.product} could not render the page: ${message}.`
    return undefined
  }

  /**
   * What the user is told when the worker's answer to a search turned it away, or undefined when it
   * didn't: as for a read (see readTurnedAway), by the worker or by the provider, for coming too
   * often or for a balance that ran out.
   */
  private searchTurnedAway = (code: string, message: string): string | undefined => {
    if (code === 'rate_limited')
      return `${this.product} searched the web too many times in a minute. Wait a minute, then ask again.`
    if (code === 'http_429') return this.tooOften
    // The worker's own words: they say when the next free credits arrive.
    if (code === 'out_of_credits') return message
    // The provider is busy, or the account's credits for it ran out: another search would be turned away too.
    if (code === 'search_busy' || code === 'search_unavailable')
      return `${this.product} could not search the web: ${message}.`
    return undefined
  }

  /**
   * Something of the signed-in user's own that the worker reports, checked against `schema`.
   * Reading changes nothing. Throws when it can't be read, or is not what the client expects.
   */
  private async readOwn<S extends z.ZodType>(
    path: string,
    query: Record<string, string | undefined>,
    schema: S,
    signal?: AbortSignal,
  ): Promise<z.output<S>> {
    const url = new URL(`${this.baseUrl}/${path}`)
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, value)
    const res = await fetch(url, { headers: { authorization: `Bearer ${await this.token()}` }, signal })
    const body: unknown = await res.json().catch(() => undefined)
    if (!res.ok) throw new Error(ErrorReply.safeParse(body).data?.error?.message ?? `HTTP ${res.status}`)
    return schema.parse(body)
  }

  /**
   * Asks the worker's web route `path`, and gives its answer, with whether it may have cost credits.
   * Throws a WorkerError: coded `failed` when the worker can't be reached, else the refusal's code,
   * turned away when `turnedAway` says so. For a `paid` route, `charged` gets what the call cost, or
   * undefined when that's unknown. A Stop throws what `fetch` or reading the answer threw.
   */
  private async askWeb(
    path: string,
    payload: unknown,
    {
      paid,
      failed,
      turnedAway,
    }: { paid: boolean; failed: string; turnedAway: (code: string, message: string) => string | undefined },
    { signal, turn, charged }: WebCall,
  ): Promise<{ body: unknown; mayHaveCost: boolean }> {
    const token = await this.token()
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-cofun-client': this.clientName,
          ...turnHeaders(turn),
        },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (err) {
      // The worker may have rendered or searched, and charged it.
      if (paid) charged?.(undefined)
      if (signal?.aborted) throw err
      throw new WorkerError(failed, `${this.product}'s service could not be reached`, { charged: paid, cause: err })
    }
    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      // A Stop while the answer is read is a Stop, not an unreadable answer.
      if (signal?.aborted) {
        if (paid) charged?.(undefined)
        throw err
      }
    }
    const mayHaveCost = paid && chargedBy(res, body, charged)
    if (!res.ok) {
      const { code, message } = refusalOf(res, body)
      throw new WorkerError(code, message, { turnedAway: turnedAway(code, message), charged: mayHaveCost })
    }
    return { body, mayHaveCost }
  }
}
