// The user's own model, on the provider they chose, and the settings page's check of their key.
// Which model the user chose is the extension's setting; the agent is given it as each question
// starts (AgentConfig.model).
import { checkOpenRouterKey, openRouterProvider } from './openrouter'
import type { ModelProvider } from './provider'
import { z } from './zod'

/** A model the user asks with their own key (on OpenRouter), as the panel offers it. */
export const OwnModel = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** Tokens the model takes in one request. */
  contextLength: z.number().int().positive(),
  /** US dollars per million tokens. */
  price: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }),
})
export type OwnModel = z.infer<typeof OwnModel>

/** The services a user's own key works with. */
export const OwnService = z.enum(['openrouter'])
export type OwnService = z.infer<typeof OwnService>

/** The user's own model that answers: the service, their key for it, and the model there. */
export type OwnSetup = { service: 'openrouter'; key: string; model: OwnModel }

/** True when A and B are the same set of values. */
type Same<A, B> = [A, B] extends [B, A] ? true : false
// The same services as OwnSetup, both ways: one missing from OwnService would make every session it
// answered unreadable (see AnsweredBy in types.ts).
true satisfies Same<OwnService, OwnSetup['service']>

/** The provider for the user's own model on the service they chose. */
export const ownProvider = (setup: OwnSetup): ModelProvider => openRouterProvider(setup)

/** How long a key check waits for the provider before it gives up. */
const CHECK_TIMEOUT_MS = 15_000

/**
 * How a check of a key went. `balance`: what the account (or the key) has left, as the provider
 * reports it, when it does. `failed`: the provider answered in a way the check can't read.
 */
export type KeyCheck =
  | { status: 'ok'; balance?: string }
  | { status: 'rejected' | 'no_money' | 'timed_out' | 'unreachable' }
  | { status: 'failed'; message: string }

/**
 * Asks the provider whether `key` works, through its own account endpoint (OpenRouter's key
 * endpoint): a free request that asks no model anything. Gives up after CHECK_TIMEOUT_MS.
 * `product` is the extension's name, for what the user is told.
 */
export async function checkKey(key: string, product: string): Promise<KeyCheck> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // Not left to the fetch alone: a provider that never answers must still end the check on time.
  const timedOut = new Promise<KeyCheck>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ status: 'timed_out' })
    }, CHECK_TIMEOUT_MS)
  })
  const check = checkOpenRouterKey(key, product, controller.signal).catch((): KeyCheck =>
    controller.signal.aborted ? { status: 'timed_out' } : { status: 'unreachable' },
  )
  try {
    return await Promise.race([check, timedOut])
  } finally {
    clearTimeout(timer)
  }
}
