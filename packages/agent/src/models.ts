// Where the models come from and which one answers: an extension's settings switch providers on,
// each with the user's own key and the models it offers; the composer picks one of those, or Auto,
// the hosted model. Kept in chrome.storage.local per account: on this device only, never synced, and
// not encrypted, like the Clerk client token. The key goes only to its provider (own.ts), never to
// the worker.
import { OwnModel, OwnService, type OwnSetup } from './own'
import { z } from './zod'

/** Each provider as the panel names it. */
export const SERVICE_NAME: Record<OwnService, string> = { openrouter: 'OpenRouter' }

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
   * The model the composer chose, by its provider and id; none is Auto. `name` says which model it
   * was once it is no longer offered.
   */
  chosen: z.object({ service: OwnService, model: z.string().min(1), name: z.string() }).optional(),
})
export type ModelSettings = z.infer<typeof ModelSettings>

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

function read(stored: unknown): ModelSettings | undefined {
  const parsed = ModelSettings.safeParse(stored)
  if (parsed.success) return parsed.data
  console.error('The saved model settings could not be read; using Auto', parsed.error)
  return undefined
}

/** The account's settings on this device; ones that can't be read count as nothing set up. */
export async function loadModelSettings(userId: string): Promise<ModelSettings> {
  const key = storageKey(userId)
  const stored: unknown = (await chrome.storage.local.get(key))[key]
  if (stored === undefined) return HOSTED_ONLY
  return read(stored) ?? HOSTED_ONLY
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
    if (got) onChange(got)
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}

export async function saveModelSettings(userId: string, settings: ModelSettings): Promise<void> {
  await chrome.storage.local.set({ [storageKey(userId)]: settings })
}

/**
 * The own model the composer chose, if it is still offered: its provider on, with a key, and the
 * model switched on there. Otherwise Auto answers.
 */
export function answering({ chosen, openRouter }: ModelSettings): OwnSetup | undefined {
  if (chosen?.service !== 'openrouter' || !openRouter?.on) return undefined
  const model = openRouter.models.find((m) => m.id === chosen.model)
  return model && { service: 'openrouter', key: openRouter.key, model }
}

/**
 * The settings with `service` marked as having turned a question away for `key`, `at` (ms). Only
 * while that key is the one saved: a key saved since, while the question ran, is not marked.
 */
export function keyRejected(settings: ModelSettings, service: OwnService, key: string, at: number): ModelSettings {
  const { openRouter } = settings
  return service === 'openrouter' && openRouter?.key === key
    ? { ...settings, openRouter: { ...openRouter, rejectedAt: at } }
    : settings
}
