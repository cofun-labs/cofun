// Whether the agent may change the user's Notion workspace (UC-AGENT-003): Edit, the default, or
// Read only. Kept in chrome.storage.local per account, on this device only, like the model settings
// (models.ts).
import { z } from './zod'

const Mode = z.enum(['edit', 'read_only'])
export type Mode = z.infer<typeof Mode>

const storageKey = (userId: string) => `mode:${userId}`

/** The account's mode on this device. One that can't be read counts as Edit, the default. */
export async function loadMode(userId: string): Promise<Mode> {
  const key = storageKey(userId)
  const stored: unknown = (await chrome.storage.local.get(key))[key]
  return parse(stored)
}

/**
 * Calls `onChange` with the account's mode whenever any side panel saves it: Chrome opens one panel
 * per window, and each shows the mode its next question is asked in. Returns what stops watching.
 */
export function watchMode(userId: string, onChange: (mode: Mode) => void): () => void {
  const key = storageKey(userId)
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && key in changes) onChange(parse(changes[key].newValue))
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}

export async function saveMode(userId: string, mode: Mode): Promise<void> {
  await chrome.storage.local.set({ [storageKey(userId)]: mode })
}

function parse(stored: unknown): Mode {
  if (stored === undefined) return 'edit'
  const parsed = Mode.safeParse(stored)
  if (parsed.success) return parsed.data
  console.error('The saved mode could not be read; using Edit', parsed.error)
  return 'edit'
}
