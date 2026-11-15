// Text the user selected on a page and sent to the side panel with the context menu's "Ask Notico"
// item. The service worker (background.ts) reads it in the tab and leaves it in chrome.storage.session,
// one entry per window; that window's side panel takes it from there into the next question. No
// message listener carries it: storage.session is open only to the extension's own pages, and what
// is read back is parsed, since the text comes from the page.

import { z } from './zod'

/** The context menu item's id. */
export const MENU_ITEM = 'ask-notico'

/** How much of a selection goes with a question; the rest is cut, and the model is told. */
const SELECTION_CHARS = 20_000

/** How much of a page's URL is kept: some (a data: URL, say) hold a whole document. */
const URL_CHARS = 2000

/**
 * A selection sent to the side panel: its text, cut to SELECTION_CHARS, how long it was in all, and
 * the page it was selected on (the tab's top page, also for a selection in one of its frames).
 */
const Selection = z.object({ text: z.string(), chars: z.number(), url: z.string(), title: z.string() })
export type Selection = z.infer<typeof Selection>

const key = (windowId: number) => `selection:${windowId}`

/**
 * Whether the menu item shows, as the settings page's switch says: on unless the user turned it off.
 * Kept in chrome.storage.sync, so it follows the user's Chrome profile to their other devices, as the
 * extension itself does; with Chrome sync off it stays on this device.
 */
const MENU_SETTING = 'contextMenu'

export async function loadMenuShown(): Promise<boolean> {
  const stored: unknown = (await chrome.storage.sync.get(MENU_SETTING))[MENU_SETTING]
  return stored !== false
}

export async function saveMenuShown(shown: boolean): Promise<void> {
  await chrome.storage.sync.set({ [MENU_SETTING]: shown })
}

/** Calls `onChange` when the setting changes, here or on another device. Returns a function that stops watching. */
export function watchMenuShown(onChange: (shown: boolean) => void): () => void {
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'sync' && MENU_SETTING in changes) onChange(changes[MENU_SETTING].newValue !== false)
  }
  chrome.storage.onChanged.addListener(onChanged)
  return () => chrome.storage.onChanged.removeListener(onChanged)
}

/** Leaves `text`, selected on the page at `url`, for the side panel of the window `windowId`. */
export async function handOver(windowId: number, text: string, url: string, title: string): Promise<void> {
  const selection: Selection = {
    text: text.slice(0, SELECTION_CHARS),
    chars: text.length,
    url: url.slice(0, URL_CHARS),
    title,
  }
  await chrome.storage.session.set({ [key(windowId)]: selection })
}

/**
 * Calls `onSelection` with each selection sent to the side panel of window `windowId`: one sent
 * before the panel opened, and each one sent while it is open. Each is taken, so it is given once.
 * Returns a function that stops watching.
 */
export function watchSelection(windowId: number, onSelection: (selection: Selection) => void): () => void {
  const name = key(windowId)
  const take = (value: unknown) => {
    if (value === undefined) return
    void chrome.storage.session.remove(name).catch((err: unknown) => console.error(err))
    const parsed = Selection.safeParse(value)
    if (parsed.success) onSelection(parsed.data)
    else console.error('Could not read the selection sent to the side panel', parsed.error)
  }
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'session' && name in changes) take(changes[name].newValue)
  }
  // Watching first, then reading: a selection sent in between is not missed.
  chrome.storage.onChanged.addListener(onChanged)
  chrome.storage.session
    .get(name)
    .then((stored) => take(stored[name]))
    .catch((err: unknown) => console.error(err))
  return () => chrome.storage.onChanged.removeListener(onChanged)
}

/**
 * The page's URL with a text fragment that makes Chrome scroll to the selection and mark it: its first
 * and last words. Undefined for a page that is not on http or https, which the panel doesn't link to.
 */
export function linkTo(selection: Selection): string | undefined {
  let url: URL
  try {
    url = new URL(selection.url)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  const words = selection.text.trim().split(/\s+/)
  // A text fragment's own signs (`-`, `,`, `&`) are encoded too, so the words are taken as words.
  const part = (list: string[]) => encodeURIComponent(list.join(' ')).replaceAll('-', '%2D')
  const text = words.length <= 8 ? part(words) : `${part(words.slice(0, 4))},${part(words.slice(-4))}`
  // A page's own fragment stays, and the directive goes after it; one the URL already had (from an
  // earlier selection's link, say) is dropped, since a second one would make Chrome find neither.
  const own = url.hash.replace(/:~:.*$/, '')
  url.hash = own === '#' ? '' : own
  return `${url.href}${url.hash ? '' : '#'}:~:text=${text}`
}
