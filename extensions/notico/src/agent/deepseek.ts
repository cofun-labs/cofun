// DeepSeek, with the user's own key: the provider, and its models from pi's catalog.
import type { Model } from '@earendil-works/pi-ai'
import { DEEPSEEK_MODELS as DEEPSEEK_CATALOG } from '@earendil-works/pi-ai/providers/deepseek.models'
import type { OwnModel } from '../models'
import { z } from '../zod'
import type { KeyCheck } from './own'
import { HOSTED_HISTORY, KEY_REJECTED, ownHistory, parseError, type Failure, type ModelProvider } from './provider'

/** DeepSeek's API, which answers requests from the extension's pages. */
const DEEPSEEK = 'https://api.deepseek.com'

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
  if (message && /^40[13]\b/.test(message))
    return { text: 'DeepSeek turned your key away. Check it in Settings.', code: KEY_REJECTED }
  if (message && /^402\b/.test(message))
    return { text: 'Your DeepSeek balance has run out. Top it up on DeepSeek, or pick another model.' }
  // A rate limit ends the question like any failure, and nothing is sent again (see askWithRetry in agent.ts).
  if (message && /^429\b/.test(message))
    return { text: 'DeepSeek is getting too many requests from your account. Wait a minute, then ask again.' }
  return parseError(message)
}

/** What DeepSeek's balance endpoint answers, as far as the check reads it. */
const Balance = z.object({
  /** Whether the balance is enough for API calls. */
  is_available: z.boolean(),
  balance_infos: z.array(z.object({ currency: z.string(), total_balance: z.string() })).optional(),
})

const CURRENCY: Record<string, string> = { CNY: '¥', USD: 'US$' }

/** Whether DeepSeek takes `key`, from its balance endpoint, which is free and asks no model. */
export async function checkDeepSeekKey(key: string, signal: AbortSignal): Promise<KeyCheck> {
  const res = await fetch(`${DEEPSEEK}/user/balance`, { headers: { authorization: `Bearer ${key}` }, signal })
  if (res.status === 401 || res.status === 403) return { status: 'rejected' }
  if (res.status === 402) return { status: 'no_money' }
  if (!res.ok) return { status: 'failed', message: `DeepSeek answered the check with HTTP ${res.status}.` }
  const balance = Balance.safeParse(await res.json().catch(() => undefined))
  if (!balance.success) return { status: 'failed', message: "DeepSeek's answer is not in the shape Notico expects." }
  if (!balance.data.is_available) return { status: 'no_money' }
  const first = balance.data.balance_infos?.[0]
  if (!first) return { status: 'ok' }
  const symbol = CURRENCY[first.currency] ?? `${first.currency} `
  return { status: 'ok', balance: `${symbol}${first.total_balance} balance` }
}
