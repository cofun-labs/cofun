// OpenRouter, with the user's own key: the provider, and the models it lists.
import type { Model } from '@earendil-works/pi-ai'
import type { OwnModel } from '../models'
import { z } from '../zod'
import { ownHistory, parseError, type Failure, type ModelProvider } from './provider'

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
  if (message && /^401\b/.test(message)) return { text: 'OpenRouter rejected your key. Check it on the settings page.' }
  return parseError(message)
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

/**
 * The models on OpenRouter that can use tools, as OpenRouter lists them now (see `leftOut` for what
 * is left out). The list is public, so the key is not sent. An entry that is not in the expected
 * shape is skipped; a list that is not is an error.
 */
export async function openRouterModels(): Promise<OwnModel[]> {
  const res = await fetch(`${OPENROUTER}/models`)
  if (!res.ok) throw new Error(`OpenRouter's model list could not be loaded (HTTP ${res.status}).`)
  const body = z.object({ data: z.array(z.unknown()) }).safeParse(await res.json().catch(() => undefined))
  if (!body.success) throw new Error("OpenRouter's model list is not in the shape Notico expects.")
  return body.data.data.flatMap((entry): OwnModel[] => {
    const listed = ListedModel.safeParse(entry)
    if (!listed.success) return []
    const { id, name, context_length, pricing, supported_parameters } = listed.data
    const input = perMillion(pricing.prompt)
    const output = perMillion(pricing.completion)
    if (!supported_parameters?.includes('tools') || leftOut(id) || input === undefined || output === undefined)
      return []
    return [{ id, name, contextLength: context_length, price: { input, output } }]
  })
}
