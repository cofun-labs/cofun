// Clipping a page, or the text selected on it, to the Notion page the user chose in Settings, from
// the context menu's "Clip page to Notion" and "Clip selection to Notion" items. The service worker
// (background.ts) hands each click to the window's side panel through chrome.storage.session, as
// "Ask Notico" does (selection.ts); the panel reads the page and writes the clip (tools/clip.ts).
// What is read back from storage is parsed: the settings may have synced from another version, and
// a clip holds text from the page.

import { isNotion, pageIdFromUrl, pageLink, showsDatabase } from './notion/hosts'
import { clipSelection } from '@cofun/tools/tab'
import { z } from './zod'

/** The context menu items' ids. */
export const CLIP_PAGE = 'clip-page'
export const CLIP_SELECTION = 'clip-selection'

/**
 * The page clips go to: its link, on the host it was chosen on (a Notion session is per host), and
 * its title when it was chosen, to show in Settings. A Notion page id is unique across workspaces,
 * so the workspace is read from the page itself when a clip is written.
 */
const ClipTarget = z.object({ url: z.string(), title: z.string() })
export type ClipTarget = z.infer<typeof ClipTarget>

/**
 * Both kept in chrome.storage.sync, so they follow the user's Chrome profile to their other devices:
 * the target, and whether the items show, on unless the user turned them off. They show only once a
 * target is chosen.
 */
const TARGET_SETTING = 'clipTarget'
const MENU_SETTING = 'clipMenu'

export interface ClipSettings {
  target?: ClipTarget
  shown: boolean
}

function settingsFrom(stored: Record<string, unknown>): ClipSettings {
  const target = ClipTarget.safeParse(stored[TARGET_SETTING])
  return { target: target.success ? target.data : undefined, shown: stored[MENU_SETTING] !== false }
}

export async function loadClipSettings(): Promise<ClipSettings> {
  return settingsFrom(await chrome.storage.sync.get([TARGET_SETTING, MENU_SETTING]))
}

/** Whether the clip items show in the menu, by the settings. */
export const clipMenuVisible = (settings: ClipSettings) => settings.shown && settings.target !== undefined

/** Calls `onChange` with both settings when either changes, here or on another device. Returns a function that stops watching. */
export function watchClipSettings(onChange: (settings: ClipSettings) => void): () => void {
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'sync' || !(TARGET_SETTING in changes || MENU_SETTING in changes)) return
    loadClipSettings().then(onChange, (err: unknown) => console.error('Could not read the clip settings', err))
  }
  chrome.storage.onChanged.addListener(onChanged)
  return () => chrome.storage.onChanged.removeListener(onChanged)
}

export async function saveClipShown(shown: boolean): Promise<void> {
  await chrome.storage.sync.set({ [MENU_SETTING]: shown })
}

/** For the user: why a tab's page can't be chosen as the target. */
const OPEN_A_TARGET = 'Open the Notion page to clip into in the current tab, then choose it here.'
const NOT_A_DATABASE = "Clips can't go into a database. Open a page, then choose it here."

/**
 * Makes the page the tab at `url` shows the target, titled `title` as the tab names it. Returns why
 * it can't be, for the user, if it can't: not a Notion page, or a database.
 */
export async function chooseClipTarget(url: string | undefined, title: string): Promise<string | undefined> {
  const id = url && isNotion(url) ? pageIdFromUrl(url) : undefined
  if (!url || !id) return OPEN_A_TARGET
  if (showsDatabase(url)) return NOT_A_DATABASE
  const target: ClipTarget = { url: pageLink(url, id), title: title.trim() || 'Untitled' }
  await chrome.storage.sync.set({ [TARGET_SETTING]: target })
  return undefined
}

/** How much of a selection a clip keeps; Chrome's menu may hand over far more. */
const SELECTION_CHARS = 20_000
/** How much of a page's URL a clip keeps: some (a data: URL, say) hold a whole document. */
const URL_CHARS = 2000

/**
 * A click on a clip item, for the side panel: what to clip (a selection's text, or the page in the
 * tab `tabId`, which the click lets the extension read for now), the page's address and title, and
 * when it was clicked.
 */
const ClipRequest = z.object({
  tabId: z.number(),
  url: z.string(),
  title: z.string(),
  /** The selected text, for a selection; none for a page. */
  text: z.string().optional(),
  at: z.number(),
})
export type ClipRequest = z.infer<typeof ClipRequest>

/**
 * How long a click waits for its side panel: Chrome opens the panel at once, but one signed out of
 * Notico takes a clip only once signed in, and a clip the user has forgotten by then is not written.
 */
const CLIP_WAIT_MS = 60_000

const prefix = (windowId: number) => `clip:${windowId}:`

/** The order of the last clip this service worker handed over (see handOverClip). */
let lastSent = 0

/** Leaves a click on a clip item, in a tab of the window `windowId`, for that window's side panel. */
export async function handOverClip(windowId: number, request: Omit<ClipRequest, 'at'>): Promise<void> {
  const clip: ClipRequest = {
    ...request,
    url: request.url.slice(0, URL_CHARS),
    ...(request.text === undefined ? {} : { text: clipSelection(request.text, SELECTION_CHARS) }),
    at: Date.now(),
  }
  // Numbered in the order sent, so one sent while the panel takes the others is neither lost nor taken twice.
  lastSent = Math.max(Date.now(), lastSent + 1)
  await chrome.storage.session.set({ [`${prefix(windowId)}${lastSent}`]: clip })
}

/**
 * Calls `onClip` with each click on a clip item handed to the side panel of window `windowId`, in
 * the order clicked: those from before the panel opened, then each one while it is open. Each is
 * taken, so it is given once; one older than CLIP_WAIT_MS is dropped. Returns a function that stops watching.
 */
export function watchClips(windowId: number, onClip: (clip: ClipRequest) => void): () => void {
  const start = prefix(windowId)
  const taken = new Set<string>()
  const take = (entries: [string, unknown][]) => {
    const fresh = entries
      .filter(([name, value]) => name.startsWith(start) && value !== undefined && !taken.has(name))
      .sort(([a], [b]) => Number(a.slice(start.length)) - Number(b.slice(start.length)))
    for (const [name, value] of fresh) {
      taken.add(name)
      void chrome.storage.session.remove(name).catch((err: unknown) => console.error(err))
      const parsed = ClipRequest.safeParse(value)
      if (!parsed.success) console.error('Could not read a clip sent to the side panel', parsed.error)
      else if (Date.now() - parsed.data.at <= CLIP_WAIT_MS) onClip(parsed.data)
    }
  }
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'session') take(Object.entries(changes).map(([name, change]) => [name, change.newValue]))
  }
  // Watching first, then reading: a clip sent in between is not missed.
  chrome.storage.onChanged.addListener(onChanged)
  chrome.storage.session
    .get(null)
    .then((stored) => take(Object.entries(stored)))
    .catch((err: unknown) => console.error(err))
  return () => chrome.storage.onChanged.removeListener(onChanged)
}
