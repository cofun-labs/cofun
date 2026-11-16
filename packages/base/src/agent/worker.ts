// Our worker: the hosted model's provider, and the reads of the signed-in user's own credits and the
// purchases they start. Model requests go to the worker through pi, with this provider.
import { CheckoutPage, Credits, Grants, Packs, type PastGrant } from '../credits'
import { z } from '../zod'
import { HOSTED_HISTORY, looseText, parseError, type CallCost, type ModelProvider, type Turn } from './provider'

export interface WorkerConfig {
  /** Base URL including /v1. */
  apiUrl: string
  /** Returns a fresh Clerk session token. Called before every request to the worker. */
  getToken: () => Promise<string | null>
  /**
   * The extension and its version, sent to the worker with each model request as
   * X-Cofun-Client, which records the call under that product.
   */
  client: string
}

const SIGN_IN = 'Please sign in first.'

/** Get a fresh Clerk session token for a Worker request. */
export async function requireToken(getToken: WorkerConfig['getToken']): Promise<string> {
  const token = await getToken()
  if (!token) throw new Error(SIGN_IN)
  return token
}

/** The headers that tell the worker which chat and question a request is for (see Turn); none it doesn't know. */
export function turnHeaders({ chat, turn }: Turn = {}): Record<string, string> {
  return { ...(chat && { 'x-cofun-chat-id': chat }), ...(turn && { 'x-cofun-turn-id': turn }) }
}

/**
 * Our worker. It fixes the model, so the agent asks it which one; each request carries a fresh Clerk
 * session token (they expire within minutes).
 */
export function hostedProvider({ apiUrl, getToken, client }: WorkerConfig): ModelProvider {
  const baseUrl = apiUrl.replace(/\/+$/, '')
  const token = () => requireToken(getToken)
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
  { apiUrl, getToken }: Pick<WorkerConfig, 'apiUrl' | 'getToken'>,
  quantity: number,
): Promise<string> {
  const token = await requireToken(getToken)
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
async function readOwn<S extends z.ZodType>(
  { apiUrl, getToken }: Pick<WorkerConfig, 'apiUrl' | 'getToken'>,
  path: string,
  query: Record<string, string | undefined>,
  schema: S,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  const token = await requireToken(getToken)
  const url = new URL(`${apiUrl.replace(/\/+$/, '')}/${path}`)
  for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, value)
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal })
  const body: unknown = await res.json().catch(() => undefined)
  if (!res.ok) throw new Error(ErrorReply.safeParse(body).data?.error?.message ?? `HTTP ${res.status}`)
  return schema.parse(body)
}

/** The signed-in user's credits, on their own clock. Reading them changes nothing. */
export function readCredits(config: Pick<WorkerConfig, 'apiUrl' | 'getToken'>, signal?: AbortSignal): Promise<Credits> {
  const utcOffset = String(-new Date().getTimezoneOffset())
  return readOwn(config, 'credits', { utc_offset: utcOffset }, Credits, signal)
}

/** Every grant the user was given, newest first. */
export async function readCreditGrants(config: Pick<WorkerConfig, 'apiUrl' | 'getToken'>): Promise<PastGrant[]> {
  return (await readOwn(config, 'credits/grants', {}, Grants)).grants
}

/** The packs of credits on offer. */
export function readCreditPacks(config: Pick<WorkerConfig, 'apiUrl' | 'getToken'>): Promise<Packs> {
  return readOwn(config, 'billing/packs', {}, Packs)
}
