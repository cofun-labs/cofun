// OpenRouter, with the user's own key: the provider, and the models it lists.
import type { Model } from '@earendil-works/pi-ai'
import type { OwnModel } from '../models'
import { z } from '../zod'
import type { KeyCheck } from './own'
import { KEY_REJECTED, ownHistory, parseError, type Failure, type ModelProvider } from './provider'

/** OpenRouter's API, which answers requests from the extension's pages. */
const OPENROUTER = 'https://openrouter.ai/api/v1'

/**
 * OpenRouter with the user's own key, which goes to OpenRouter alone. Every model is asked through
 * the OpenAI-compatible API, the `anthropic/*` ones included (pi's catalog lists those under
 * Anthropic's own API, which would bring in another SDK); they use tools correctly this way (#46).
 */
export function openRouterProvider({ key, model }: { key: string; model: OwnModel }): ModelProvider {
  return {
    name: 'OpenRouter',
    loadModel: async () => openRouterModel(model),
    apiKey: async () => key,
    history: ownHistory(model.contextLength),
    // OpenRouter's app attribution headers would name the extension to it; nothing needs them.
    identity: { attribution: null },
    parseError: openRouterError,
    modelChanged: () => false,
  }
}

/** OpenRouter's error, with a refused key said plainly: its own words for it ("User not found.") are not. */
function openRouterError(message: string | undefined): Failure {
  if (message && /^40[13]\b/.test(message))
    return { text: 'OpenRouter turned your key away. Check it in Settings.', code: KEY_REJECTED }
  return parseError(message)
}

/** What OpenRouter's key endpoint answers, as far as the check reads it. */
const KeyInfo = z.object({
  data: z.object({
    /** Dollars left under the key's own limit; null when it has none. */
    limit_remaining: z.number().nullable().optional(),
    /** The budget that blocks the key's requests first, if any. */
    effective_budget: z.object({ remaining_usd: z.number() }).nullable().optional(),
  }),
})

/**
 * Whether OpenRouter takes `key`, from its key endpoint, which is free and asks no model. What the
 * key has left is shown when the key has a limit; OpenRouter tells the account's own balance only
 * to a management key.
 */
export async function checkOpenRouterKey(key: string, signal: AbortSignal): Promise<KeyCheck> {
  const res = await fetch(`${OPENROUTER}/key`, { headers: { authorization: `Bearer ${key}` }, signal })
  if (res.status === 401 || res.status === 403) return { status: 'rejected' }
  if (res.status === 402) return { status: 'no_money' }
  if (!res.ok) return { status: 'failed', message: `OpenRouter answered the check with HTTP ${res.status}.` }
  const info = KeyInfo.safeParse(await res.json().catch(() => undefined))
  if (!info.success) return { status: 'failed', message: "OpenRouter's answer is not in the shape Notico expects." }
  const { limit_remaining: left, effective_budget: budget } = info.data.data
  if ((left != null && left <= 0) || (budget && budget.remaining_usd <= 0)) return { status: 'no_money' }
  return left == null ? { status: 'ok' } : { status: 'ok', balance: `US$${left.toFixed(2)} left on this key` }
}

function openRouterModel(model: OwnModel): Model<'openai-completions'> {
  return {
    id: model.id,
    name: model.name,
    api: 'openai-completions',
    // pi tells OpenRouter's request shape (caching, session affinity) by this name.
    provider: 'openrouter',
    baseUrl: OPENROUTER,
    reasoning: false,
    input: ['text'],
    cost: { input: model.price.input, output: model.price.output, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextLength,
    maxTokens: 16_384,
  }
}

/** An entry of OpenRouter's model list, as far as the settings page reads it. */
const ListedModel = z.object({
  id: z.string().min(1),
  name: z.string(),
  context_length: z.number().int().positive(),
  // Dollars per token, as text.
  pricing: z.object({ prompt: z.string(), completion: z.string() }),
  supported_parameters: z.array(z.string()).optional(),
})

/**
 * Left out of the list: batch variants, which don't answer a chat as it goes, and OpenRouter's
 * aliases (`~vendor/…-latest`), which hide which model answers and the vendor pi tells a model's
 * request shape by (an alias of a Claude model would get no prompt caching).
 */
const leftOut = (id: string) => id.startsWith('~') || id.endsWith(':batch')

const perMillion = (perToken: string) => {
  const n = Number(perToken) * 1_000_000
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** A model on OpenRouter's list, and whether it can use tools, which Notico needs. */
export type ListedModel = OwnModel & { tools: boolean }

/**
 * The models on OpenRouter, as OpenRouter lists them now (see `leftOut` for what is left out), each
 * saying whether it can use tools. The list is public, so the key is not sent. An entry that is not
 * in the expected shape is skipped; a list that is not is an error.
 */
export async function openRouterModels(): Promise<ListedModel[]> {
  const res = await fetch(`${OPENROUTER}/models`)
  if (!res.ok) throw new Error(`OpenRouter's model list could not be loaded (HTTP ${res.status}).`)
  const body = z.object({ data: z.array(z.unknown()) }).safeParse(await res.json().catch(() => undefined))
  if (!body.success) throw new Error("OpenRouter's model list is not in the shape Notico expects.")
  return body.data.data.flatMap((entry): ListedModel[] => {
    const listed = ListedModel.safeParse(entry)
    if (!listed.success) return []
    const { id, name, context_length, pricing, supported_parameters } = listed.data
    const input = perMillion(pricing.prompt)
    const output = perMillion(pricing.completion)
    if (leftOut(id) || input === undefined || output === undefined) return []
    const tools = !!supported_parameters?.includes('tools')
    return [{ id, name, contextLength: context_length, price: { input, output }, tools }]
  })
}
