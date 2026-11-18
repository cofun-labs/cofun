// How the side panel words a tool's call. What the tools share to show text from pages (DATA_LINE,
// asData, the escapes) is @cofun/tools's.
import type { Action, Verb } from '../tool'

// How the side panel describes a call (see `Tool.describe`).
export const verb = (base: string, ing: string, past: string): Verb => ({ base, ing, past })
export const READ = verb('read', 'reading', 'read')
export const SEARCH = verb('search', 'searching', 'searched')

/** The action on a thing by its name when known, else on what the fallback words say. */
export function on(verb: Verb, name: string | undefined, fallback: string, what?: string): Action {
  return name ? { verb, what, name } : { verb, what: what ? `${what} ${fallback}` : fallback }
}
