// Our worker: the hosted model's provider, and the reads of the signed-in user's own credits and the
// purchases they start. Model requests go to the worker through pi, with this provider.
import { CheckoutPage } from '../credits'
import { z } from '../zod'
import { HOSTED_HISTORY, looseText, parseError, type CallCost, type ModelProvider } from './provider'
import { WebError, WebPage, WebSearchResult, type AgentConfig, type Turn } from './types'

const SIGN_IN = 'Please sign in first.'

/** The headers that tell the worker which chat and question a request is for (see Turn); none it doesn't know. */
function turnHeaders({ chat, turn }: Turn = {}): Record<string, string> {
  return { ...(chat && { 'x-cofun-chat-id': chat }), ...(turn && { 'x-cofun-turn-id': turn }) }
}

/**
 * Our worker. It fixes the model, so the agent asks it which one; each request carries a fresh Clerk
 * session token (they expire within minutes).
 */
export function hostedProvider({
  apiUrl,
  getToken,
  client,
}: Pick<AgentConfig, 'apiUrl' | 'getToken' | 'client'>): ModelProvider {
  const baseUrl = apiUrl.replace(/\/+$/, '')
  const token = async () => {
    const value = await getToken()
    if (!value) throw new Error(SIGN_IN)
    return value
  }
  return {
    name: 'Cofun',
    async loadModel() {
      const res = await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${await token()}` } })
      const body = MeReply.safeParse(await res.json().catch(() => undefined)).data
      const model = body?.model
      if (!res.ok || !model) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
      return {
        id: model,
        name: model,
        api: 'openai-completions',
        provider: 'cofun',
        baseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // Which extension asks, so the worker records the call under its product.
        headers: { 'x-cofun-client': client },
        contextWindow: 128_000,
        maxTokens: 16_384,
        // What the worker accepts: system (not developer) messages, max_tokens, no store field.
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsStore: false,
          supportsStrictMode: false,
          maxTokensField: 'max_tokens',
        },
      }
    },
    apiKey: token,
    history: HOSTED_HISTORY,
    // No provider attribution headers; the worker is our own.
    identity: { attribution: null },
    parseError,
    // The worker's model changed since the panel looked it up (a deploy).
    modelChanged: (failure) => failure.code === 'unsupported_model',
    callCost,
    turnHeaders,
  }
}

/**
 * What the worker says a model call cost: in its own chunk, the last of the stream before `[DONE]`
 * (and in the body of a reply that isn't streamed). The worker is the only place that prices a call.
 */
const CostChunk = z.object({
  cost: z.object({ micro_credits: z.number().int().nonnegative(), estimated: z.boolean() }).optional(),
})

/**
 * The cost a chunk of the worker's stream carries, if it carries one. A cost that is not what the
 * panel expects throws, saying what is wrong: a reply must not show a number it could not read.
 */
function callCost(chunk: unknown): CallCost | undefined {
  // Most chunks are the model's own, and carry no cost.
  if (!chunk || typeof chunk !== 'object' || !('cost' in chunk)) return undefined
  const cost = CostChunk.parse(chunk).cost
  return cost && { microCredits: cost.micro_credits, estimated: cost.estimated }
}

/** A refusal from the worker, as far as its message. */
const ErrorReply = z.object({ error: z.object({ message: looseText }).optional().catch(undefined) })

/** The worker's answer to `/me`: the model it uses, or why it refused. */
const MeReply = ErrorReply.extend({ model: looseText })

/**
 * Starts buying the pack of `quantity` (a pack's quantity, as `creditPacks` lists it): the worker
 * makes a Stripe Checkout Session for it, for the signed-in user, and gives the URL of its page.
 * Nothing is bought until the user pays there.
 */
export async function checkout(
  { apiUrl, getToken }: Pick<AgentConfig, 'apiUrl' | 'getToken'>,
  quantity: number,
): Promise<string> {
  const token = await getToken()
  if (!token) throw new Error(SIGN_IN)
  const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/billing/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ quantity }),
  })
  const body: unknown = await res.json().catch(() => undefined)
  if (!res.ok) throw new Error(ErrorReply.safeParse(body).data?.error?.message ?? `HTTP ${res.status}`)
  return CheckoutPage.parse(body).url
}

/**
 * Something of the signed-in user's own that the worker reports, checked against `schema`.
 * Reading changes nothing. Throws when it can't be read, or is not what the panel expects.
 */
export async function readOwn<S extends z.ZodType>(
  { apiUrl, getToken }: Pick<AgentConfig, 'apiUrl' | 'getToken'>,
  path: string,
  query: Record<string, string | undefined>,
  schema: S,
): Promise<z.output<S>> {
  const token = await getToken()
  if (!token) throw new Error(SIGN_IN)
  const url = new URL(`${apiUrl.replace(/\/+$/, '')}/${path}`)
  for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, value)
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  const body: unknown = await res.json().catch(() => undefined)
  if (!res.ok) throw new Error(ErrorReply.safeParse(body).data?.error?.message ?? `HTTP ${res.status}`)
  return schema.parse(body)
}

/** A refusal from the worker, with its code. */
const CodedError = z.object({ error: z.object({ code: looseText, message: looseText }) })

/** What a render or a search cost, as each of its answers says; a plain read, or one turned away first, says nothing. */
const Charged = z.object({ cost: z.object({ micro_credits: z.number().int().nonnegative() }).optional() })

/** What the user is told when the worker's limit on pages read stops a question. */
const TOO_MANY_PAGES = 'Notico read too many web pages in a minute. Wait a minute, then ask again.'

/**
 * What the user is told when a 429 without a code of the worker's turns a read or a search away:
 * one sent before the worker (by Cloudflare, say), for coming too often.
 */
const TURNED_AWAY = "Notico's service turned away its requests for coming too often. Wait a minute, then ask again."

/** What the model is told when the worker could not be reached, or its answer could not be read. */
const UNREACHABLE = "Notico's service could not be reached"
const UNREADABLE = "Notico's service gave an answer Notico could not read"

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

/**
 * What the user is told when the worker's answer to a read stops the question, or undefined when
 * it doesn't. Only a request turned away stops it: for coming too often, or for credits that ran
 * out. Any other failure goes to the model: a read changes nothing and involves no account of the
 * user's (CLAUDE.md, "Calling outside services"). A stopped question sends nothing more.
 */
function stopsReading(code: string, message: string): string | undefined {
  if (code === 'rate_limited') return TOO_MANY_PAGES
  if (code === 'http_429') return TURNED_AWAY
  // The worker's own words: they say when the next free credits arrive.
  if (code === 'out_of_credits') return message
  if (code === 'site_busy')
    return "A site turned away Notico's requests for coming too often. Wait a while, then ask again."
  // The browser that renders pages turned the render away: another would be turned away too.
  if (code === 'render_busy') return `Notico could not render the page: ${message}.`
  return undefined
}

/**
 * What the user is told when the worker's answer to a search stops the question, or undefined when
 * it doesn't: as for a read (see stopsReading), only a search turned away stops it, by the worker
 * or by the provider, for coming too often or for a balance that ran out.
 */
function stopsSearching(code: string, message: string): string | undefined {
  if (code === 'rate_limited')
    return 'Notico searched the web too many times in a minute. Wait a minute, then ask again.'
  if (code === 'http_429') return TURNED_AWAY
  // The worker's own words: they say when the next free credits arrive.
  if (code === 'out_of_credits') return message
  // The provider is busy, or the account's credits for it ran out: another search would be turned away too.
  if (code === 'search_busy' || code === 'search_unavailable') return `Notico could not search the web: ${message}.`
  return undefined
}

/** What a request to the worker's web routes needs: where the worker is, the session, and the question it is for. */
type WebConfig = Pick<AgentConfig, 'apiUrl' | 'getToken' | 'client'> & { turn?: Turn }

/**
 * Asks the worker's web route `path`, and gives its answer, with whether it may have cost credits.
 * Throws a WebError: coded `failed` when the worker can't be reached, else the refusal's code,
 * stopping the question when `stops` says so. For a `paid` route, `charged` gets what the call
 * cost, or undefined when that's unknown. A Stop throws what `fetch` or reading the answer threw.
 */
async function askWeb(
  { apiUrl, getToken, client, turn }: WebConfig,
  path: string,
  payload: unknown,
  {
    paid,
    failed,
    stops,
  }: { paid: boolean; failed: string; stops: (code: string, message: string) => string | undefined },
  signal?: AbortSignal,
  charged?: (microCredits: number | undefined) => void,
): Promise<{ body: unknown; mayHaveCost: boolean }> {
  const token = await getToken()
  if (!token) throw new Error(SIGN_IN)
  let res: Response
  try {
    res = await fetch(`${apiUrl.replace(/\/+$/, '')}/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-cofun-client': client,
        ...turnHeaders(turn),
      },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (err) {
    // The worker may have rendered or searched, and charged it.
    if (paid) charged?.(undefined)
    if (signal?.aborted) throw err
    throw new WebError(failed, UNREACHABLE, { charged: paid, cause: err })
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
    throw new WebError(code, message, { stopsQuestion: stops(code, message), charged: mayHaveCost })
  }
  return { body, mayHaveCost }
}

/** Has the worker read the web page at `url`, rendered when `render` is set (see ToolContext.readWeb and askWeb). */
export async function readWebPage(
  config: WebConfig,
  url: string,
  maxChars: number,
  render: boolean,
  signal?: AbortSignal,
  charged?: (microCredits: number | undefined) => void,
): Promise<WebPage> {
  const how = { paid: render, failed: 'read_failed', stops: stopsReading }
  const path = `web/${render ? 'render' : 'read'}`
  const { body, mayHaveCost } = await askWeb(config, path, { url, max_chars: maxChars }, how, signal, charged)
  const page = WebPage.safeParse(body)
  if (!page.success) throw new WebError('read_failed', UNREADABLE, { charged: mayHaveCost, cause: page.error })
  return page.data
}

/** The worker's answer to a search. */
const WebSearch = z.object({ results: z.array(WebSearchResult) })

/** Has the worker search the web for `query`, for at most `limit` results, never retried (see ToolContext.searchWeb and askWeb). */
export async function searchWebFor(
  config: WebConfig,
  query: string,
  limit: number,
  signal?: AbortSignal,
  charged?: (microCredits: number | undefined) => void,
): Promise<WebSearchResult[]> {
  const how = { paid: true, failed: 'search_failed', stops: stopsSearching }
  const { body, mayHaveCost } = await askWeb(config, 'web/search', { query, limit }, how, signal, charged)
  const answer = WebSearch.safeParse(body)
  if (!answer.success) throw new WebError('search_failed', UNREADABLE, { charged: mayHaveCost, cause: answer.error })
  return answer.data.results
}
