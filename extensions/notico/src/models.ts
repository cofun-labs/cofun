// Where the models come from and which one answers (UC-NOTICO-AGENT-002). Settings switches providers
// on, each with the user's own key and the models it offers; the composer picks one of those, or Auto,
// the hosted model. Kept in chrome.storage.local per account: on this device only, never synced, and
// not encrypted, like the Clerk client token.
import { z } from './zod'

/** A model the user asks with their own key (on OpenRouter or DeepSeek), as the panel offers it. */
export const OwnModel = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** Tokens the model takes in one request. */
  contextLength: z.number().int().positive(),
  /** US dollars per million tokens. */
  price: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }),
})
export type OwnModel = z.infer<typeof OwnModel>

/** The providers a user's own key works with. */
export const Service = z.enum(['openrouter', 'deepseek'])
export type Service = z.infer<typeof Service>

/** Each provider as the panel names it. */
export const SERVICE_NAME: Record<Service, string> = { openrouter: 'OpenRouter', deepseek: 'DeepSeek' }

/** What is the same for every provider with a key. */
const Provider = {
  /** Whether its models are offered. Switching a provider off keeps its key. */
  on: z.boolean(),
  /** A key that passed the check. Only such a key is saved. */
  key: z.string().min(1),
  /**
   * When the provider turned a question away for this key (ms since the epoch). Cleared by a check
   * that passes, or by a new key.
   */
  rejectedAt: z.number().optional(),
}

const ModelSettings = z.object({
  /** OpenRouter's switched-on models, as its list described them when they were switched on. */
  openRouter: z.object({ ...Provider, models: z.array(OwnModel) }).optional(),
  /**
   * DeepSeek's switched-on models by their ids in DeepSeek's catalog (`DEEPSEEK_MODELS` in
   * agent/deepseek.ts), which has what each costs and how it is asked: a saved copy would go stale.
   */
  deepSeek: z.object({ ...Provider, models: z.array(z.string().min(1)) }).optional(),
  /**
   * The model the composer chose, by its provider and id; none is Auto. `name` says which model it
   * was once it is no longer offered.
   */
  chosen: z.object({ service: Service, model: z.string().min(1), name: z.string() }).optional(),
})
export type ModelSettings = z.infer<typeof ModelSettings>

/**
 * The settings before providers had switches: one own model per service and which one answered.
 * Read once and turned into the settings above, which are saved in their place.
 */
const OldSettings = z.object({
  use: z.enum(['hosted', 'openrouter', 'deepseek']),
  openRouter: z.object({ key: z.string().min(1), model: OwnModel }).optional(),
  deepSeek: z.object({ key: z.string().min(1), model: z.string().min(1) }).optional(),
})

function fromOld({ use, openRouter, deepSeek }: z.infer<typeof OldSettings>): ModelSettings {
  return {
    ...(openRouter && { openRouter: { on: true, key: openRouter.key, models: [openRouter.model] } }),
    ...(deepSeek && { deepSeek: { on: true, key: deepSeek.key, models: [deepSeek.model] } }),
    ...(use === 'openrouter' &&
      openRouter && { chosen: { service: 'openrouter', model: openRouter.model.id, name: openRouter.model.name } }),
    ...(use === 'deepseek' &&
      deepSeek && { chosen: { service: 'deepseek', model: deepSeek.model, name: deepSeek.model } }),
  }
}

/** Nothing set up: Auto answers. */
export const HOSTED_ONLY: ModelSettings = {}

/**
 * Recommended first on the settings page, with what each is good for: the newest version of each
 * line, named exactly, so it changes only when this list does. Each is looked up in OpenRouter's
 * live list for its name and price; one OpenRouter no longer offers shows as unavailable. The first
 * one OpenRouter offers starts switched on when a key passes the check.
 */
export const RECOMMENDED: { id: string; note: string }[] = [
  { id: 'anthropic/claude-sonnet-5.5', note: 'Strong with tools' },
  { id: 'openai/gpt-6.1-sol', note: 'Strong all-round' },
  { id: 'anthropic/claude-haiku-5.5', note: 'Fast' },
  { id: 'openai/gpt-6-luna', note: 'Fast and inexpensive' },
  { id: 'deepseek/deepseek-v4.1-flash', note: 'Least expensive' },
]

const storageKey = (userId: string) => `model:${userId}`

type Read = { settings: ModelSettings; old: boolean } | undefined

function read(stored: unknown): Read {
  const parsed = ModelSettings.safeParse(stored)
  // Settings in the new shape never have `use`, which the old ones always have.
  if (parsed.success && !(stored instanceof Object && 'use' in stored)) return { settings: parsed.data, old: false }
  const old = OldSettings.safeParse(stored)
  if (old.success) return { settings: fromOld(old.data), old: true }
  console.error('The saved model settings could not be read; using Auto', parsed.error)
  return undefined
}

/**
 * The account's settings on this device. Ones in the old shape are saved in the new one; ones that
 * can't be read count as nothing set up.
 */
export async function loadModelSettings(userId: string): Promise<ModelSettings> {
  const key = storageKey(userId)
  const stored: unknown = (await chrome.storage.local.get(key))[key]
  if (stored === undefined) return HOSTED_ONLY
  const got = read(stored)
  if (!got) return HOSTED_ONLY
  if (got.old) await saveModelSettings(userId, got.settings)
  return got.settings
}

/**
 * Calls `onChange` with the account's settings whenever any side panel saves them: Chrome opens one
 * panel per window, and a key removed in one must not stay in use, or be saved back, in another.
 * Returns what stops watching.
 */
export function watchModelSettings(userId: string, onChange: (settings: ModelSettings) => void): () => void {
  const key = storageKey(userId)
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local' || !(key in changes)) return
    const { newValue } = changes[key]
    if (newValue === undefined) return onChange(HOSTED_ONLY)
    const got = read(newValue)
    if (got) onChange(got.settings)
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}

export async function saveModelSettings(userId: string, settings: ModelSettings): Promise<void> {
  await chrome.storage.local.set({ [storageKey(userId)]: settings })
}

/** The user's own model that answers: the service, their key for it, and the model there. */
export type OwnSetup =
  | { service: 'openrouter'; key: string; model: OwnModel }
  | { service: 'deepseek'; key: string; model: string }

/**
 * The own model the composer chose, if it is still offered: its provider on, with a key, and the
 * model switched on there. Otherwise Auto answers.
 */
export function answering({ chosen, openRouter, deepSeek }: ModelSettings): OwnSetup | undefined {
  if (chosen?.service === 'openrouter' && openRouter?.on) {
    const model = openRouter.models.find((m) => m.id === chosen.model)
    return model && { service: 'openrouter', key: openRouter.key, model }
  }
  if (chosen?.service === 'deepseek' && deepSeek?.on && deepSeek.models.includes(chosen.model))
    return { service: 'deepseek', key: deepSeek.key, model: chosen.model }
  return undefined
}

/**
 * The settings with `service` marked as having turned a question away for `key`, `at` (ms). Only
 * while that key is the one saved: a key saved since, while the question ran, is not marked.
 */
export function keyRejected(settings: ModelSettings, service: Service, key: string, at: number): ModelSettings {
  const { openRouter, deepSeek } = settings
  if (service === 'openrouter')
    return openRouter?.key === key ? { ...settings, openRouter: { ...openRouter, rejectedAt: at } } : settings
  return deepSeek?.key === key ? { ...settings, deepSeek: { ...deepSeek, rejectedAt: at } } : settings
}
