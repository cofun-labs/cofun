// Our worker: the hosted model's provider, and the reads of the signed-in user's own credits and the
// purchases they start. Model requests go to the worker through pi, with this provider.
import { CheckoutPage } from '../credits'
import { z } from '../zod'
import { HOSTED_HISTORY, looseText, parseError, type CallCost, type ModelProvider } from './provider'
import { WebError, WebPage, type AgentConfig } from './types'

const SIGN_IN = 'Please sign in first.'

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

/** The worker's answer to a page it read: the page, and what reading it cost. */
const WebReply = WebPage.extend({ cost: z.object({ micro_credits: z.number().int().nonnegative() }) })

/** A refusal from the worker, with its code. */
const CodedError = z.object({ error: z.object({ code: looseText, message: looseText }) })

/** What the user is told when the worker's limit on pages read stops a question. */
const TOO_MANY_PAGES = 'Notico read too many web pages in a minute. Wait a minute, then ask again.'

/**
 * Has the worker read the web page at `url` (see ToolContext.readWeb): fetched plainly, or rendered
 * in a browser when `render` is set. Resolves with the page and what it cost, in micro-credits;
 * throws a WebError when the worker could not read it, which stops the question when the worker
 * turned the request away for coming too often.
 */
export async function readWebPage(
  { apiUrl, getToken, client }: Pick<AgentConfig, 'apiUrl' | 'getToken' | 'client'>,
  url: string,
  maxChars: number,
  render: boolean,
  signal?: AbortSignal,
): Promise<{ page: WebPage; microCredits: number }> {
  const token = await getToken()
  if (!token) throw new Error(SIGN_IN)
  const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/web/${render ? 'render' : 'read'}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-cofun-client': client },
    body: JSON.stringify({ url, max_chars: maxChars }),
    signal,
  })
  const body: unknown = await res.json().catch(() => undefined)
  if (!res.ok) {
    const refusal = CodedError.safeParse(body).data?.error
    const code = refusal?.code ?? `http_${res.status}`
    throw new WebError(
      code,
      refusal?.message ?? `HTTP ${res.status}`,
      code === 'rate_limited' ? TOO_MANY_PAGES : undefined,
    )
  }
  const { cost, ...page } = WebReply.parse(body)
  return { page, microCredits: cost.micro_credits }
}
