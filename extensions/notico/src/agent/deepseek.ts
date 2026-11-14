// DeepSeek, with the user's own key: the provider, and its models from pi's catalog.
import type { Model } from '@earendil-works/pi-ai'
import { DEEPSEEK_MODELS as DEEPSEEK_CATALOG } from '@earendil-works/pi-ai/providers/deepseek.models'
import type { OwnModel } from '../models'
import { HOSTED_HISTORY, ownHistory, parseError, type Failure, type ModelProvider } from './provider'

/**
 * DeepSeek's models, from pi's catalog: how each is asked (DeepSeek's thinking format, its own
 * fields on assistant messages), its context, and its prices, kept current as pi updates. DeepSeek's
 * own model list has none of that, so it is never read.
 */
const deepSeekCatalog: Model<'openai-completions'>[] = Object.values(DEEPSEEK_CATALOG)

/** DeepSeek's models, as the panel offers them. */
export const DEEPSEEK_MODELS: OwnModel[] = deepSeekCatalog.map((m) => ({
  id: m.id,
  name: m.name,
  contextLength: m.contextWindow,
  price: { input: m.cost.input, output: m.cost.output },
}))

/**
 * DeepSeek's own API with the user's own key, which goes to DeepSeek alone. Its models answer
 * without thinking first: pi turns thinking off when no reasoning level is asked for.
 */
export function deepSeekProvider({ key, model: id }: { key: string; model: string }): ModelProvider {
  const model = deepSeekCatalog.find((m) => m.id === id)
  return {
    name: 'DeepSeek',
    async loadModel() {
      if (!model) throw new Error(`DeepSeek's model ${id} is no longer offered. Choose another on the settings page.`)
      return model
    },
    apiKey: async () => key,
    history: model ? ownHistory(model.contextWindow) : HOSTED_HISTORY,
    identity: { attribution: null },
    parseError: deepSeekError,
    modelChanged: () => false,
  }
}

/** DeepSeek's error, with what the user can do about the ones it gives for their account. */
function deepSeekError(message: string | undefined): Failure {
  if (message && /^401\b/.test(message)) return { text: 'DeepSeek rejected your key. Check it on the settings page.' }
  if (message && /^402\b/.test(message))
    return { text: 'Your DeepSeek balance has run out. Top it up on DeepSeek, or choose another model.' }
  // A rate limit ends the question like any failure, and nothing is sent again (see askWithRetry in agent.ts).
  if (message && /^429\b/.test(message))
    return { text: 'DeepSeek is getting too many requests from your account. Wait a minute, then ask again.' }
  return parseError(message)
}
