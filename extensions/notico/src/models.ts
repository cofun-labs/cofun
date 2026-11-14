// Which model answers the user's questions (UC-NOTICO-AGENT-002): the hosted one, or one on OpenRouter or
// DeepSeek with the user's own key. The choice and the keys are kept in chrome.storage.local per
// account: on this device only, never synced, and not encrypted, like the Clerk client token.
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

/**
 * What the user set up. Each service keeps its own key and model, whichever one is in use, so
 * switching between them is one step; removing a key removes that service's setup.
 */
const ModelSettings = z.object({
  use: z.enum(['hosted', 'openrouter', 'deepseek']),
  openRouter: z.object({ key: z.string().min(1), model: OwnModel }).optional(),
  /**
   * The model by its id in DeepSeek's catalog (`DEEPSEEK_MODELS` in agent/deepseek.ts), which has what it
   * costs and how it is asked: a saved copy would go stale as the catalog changes.
   */
  deepSeek: z.object({ key: z.string().min(1), model: z.string().min(1) }).optional(),
})
export type ModelSettings = z.infer<typeof ModelSettings>

/** Nothing set up: the hosted model answers. */
export const HOSTED_ONLY: ModelSettings = { use: 'hosted' }

/**
 * Recommended first on the settings page, with what each is good for: the newest version of each
 * line, named exactly, so it changes only when this list does. Each is looked up in OpenRouter's
 * live list for its name and price; one OpenRouter no longer offers shows as unavailable.
 */
export const RECOMMENDED: { id: string; note: string }[] = [
  { id: 'anthropic/claude-sonnet-5.5', note: 'Strong with tools' },
  { id: 'openai/gpt-6.1-sol', note: 'Strong all-round' },
  { id: 'anthropic/claude-haiku-5.5', note: 'Fast' },
  { id: 'openai/gpt-6-luna', note: 'Fast and inexpensive' },
  { id: 'deepseek/deepseek-v4.1-flash', note: 'Least expensive' },
]

const storageKey = (userId: string) => `model:${userId}`

/** The account's settings on this device. Ones that can't be read count as nothing set up. */
export async function loadModelSettings(userId: string): Promise<ModelSettings> {
  const key = storageKey(userId)
  const stored: unknown = (await chrome.storage.local.get(key))[key]
  if (stored === undefined) return HOSTED_ONLY
  const parsed = ModelSettings.safeParse(stored)
  if (parsed.success) return parsed.data
  console.error('The saved model settings could not be read; using the hosted model', parsed.error)
  return HOSTED_ONLY
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
    const parsed = ModelSettings.safeParse(newValue)
    if (newValue === undefined) onChange(HOSTED_ONLY)
    else if (parsed.success) onChange(parsed.data)
    else console.error('The saved model settings could not be read; using the hosted model', parsed.error)
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}

export async function saveModelSettings(userId: string, settings: ModelSettings): Promise<void> {
  await chrome.storage.local.set({ [storageKey(userId)]: settings })
}

/** The user's own model in use: the service, their key for it, and the model they chose there. */
export type OwnSetup =
  | { service: 'openrouter'; key: string; model: OwnModel }
  | { service: 'deepseek'; key: string; model: string }

/** The own model the settings say to use, if they say one that is set up; otherwise the hosted one answers. */
export function ownSetup(settings: ModelSettings): OwnSetup | undefined {
  if (settings.use === 'openrouter' && settings.openRouter) return { service: 'openrouter', ...settings.openRouter }
  if (settings.use === 'deepseek' && settings.deepSeek) return { service: 'deepseek', ...settings.deepSeek }
  return undefined
}
