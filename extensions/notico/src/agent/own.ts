// The user's own model, on the provider they chose, and the settings page's check of their key.
import type { OwnSetup, Service } from '../models'
import { checkDeepSeekKey, deepSeekProvider } from './deepseek'
import { checkOpenRouterKey, openRouterProvider } from './openrouter'
import type { ModelProvider } from './provider'

/** The provider for the user's own model on the service they chose. */
export const ownProvider = (setup: OwnSetup): ModelProvider =>
  setup.service === 'openrouter' ? openRouterProvider(setup) : deepSeekProvider(setup)

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
 * Asks the provider whether `key` works, through its own account endpoint (OpenRouter's key,
 * DeepSeek's balance): a free request that asks no model anything. Gives up after CHECK_TIMEOUT_MS.
 */
export async function checkKey(service: Service, key: string): Promise<KeyCheck> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // Not left to the fetch alone: a provider that never answers must still end the check on time.
  const timedOut = new Promise<KeyCheck>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ status: 'timed_out' })
    }, CHECK_TIMEOUT_MS)
  })
  const check = (service === 'openrouter' ? checkOpenRouterKey : checkDeepSeekKey)(key, controller.signal).catch(
    (): KeyCheck => (controller.signal.aborted ? { status: 'timed_out' } : { status: 'unreachable' }),
  )
  try {
    return await Promise.race([check, timedOut])
  } finally {
    clearTimeout(timer)
  }
}
