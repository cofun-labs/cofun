// Text the user selected on a page and sent to an extension's side panel with the context menu's
// "Ask <product>" item. The service worker (setupSelectionMenu) reads it in the tab and leaves it in
// chrome.storage.session, one key per selection, by window; that window's side panel takes them from
// there into the next question, where each selection sent adds to the ones before. No message listener
// carries it: storage.session is open only to the extension's own pages, and what is read back is
// parsed, since the text comes from the page. Imported as @cofun/tools/selection, which loads no agent.
import { clipSelection, selectedText } from './tab'
import { z } from './zod'

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

/** Where the selections sent to a window's side panel are kept, each under this and its number. */
const prefix = (windowId: number) => `selection:${windowId}:`

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

/** The order of the last selection this service worker handed over (see handOver). */
let lastSent = 0

/**
 * Leaves `text`, selected on the page at `url`, for the side panel of the window `windowId`. Each
 * selection gets a key of its own, numbered in the order sent, so one sent while the panel takes
 * the others is neither lost nor taken twice.
 */
async function handOver(windowId: number, text: string, url: string, title: string): Promise<void> {
  const selection: Selection = {
    text: clipSelection(text, SELECTION_CHARS),
    chars: text.length,
    url: url.slice(0, URL_CHARS),
    title,
  }
  // The time, so the order holds across starts of the service worker; one more for a second in the same millisecond.
  lastSent = Math.max(Date.now(), lastSent + 1)
  await chrome.storage.session.set({ [`${prefix(windowId)}${lastSent}`]: selection })
}

/**
 * Sets up the service worker's "Ask <product>" context menu item, on text selected in any page:
 * picking it opens the side panel and hands it the selection. The click gives the extension the tab
 * for a moment (activeTab), which is how the selection is read there with its line breaks; where it
 * can't be (a frame from another site, say), Chrome's own copy of it, on one line, is used.
 */
export function setupSelectionMenu({
  product,
}: {
  /** The extension's name, as the menu shows it: `Notico`. */
  product: string
}): void {
  const menuItem = `ask-${product.toLowerCase()}`
  // Menu items stay from one start of the service worker to the next; they are made again when the
  // extension is installed or updated, shown unless the user turned them off in Settings. Only on web
  // pages and local files: on the extension's own pages (the side panel) there is no tab to read.
  chrome.runtime.onInstalled.addListener(() => {
    void loadMenuShown()
      .catch((err: unknown) => {
        console.error('Could not read the menu setting', err)
        return true
      })
      .then((visible) =>
        chrome.contextMenus.removeAll(() =>
          chrome.contextMenus.create({
            id: menuItem,
            title: `Ask ${product} about “%s”`,
            contexts: ['selection'],
            documentUrlPatterns: ['https://*/*', 'http://*/*', 'file:///*'],
            visible,
          }),
        ),
      )
  })

  // The Settings switch, changed on this device or synced from another one. It is read again as the
  // browser starts, for a change that synced while Chrome was closed.
  const showMenu = (visible: boolean) =>
    chrome.contextMenus.update(menuItem, { visible }).catch((err: unknown) => console.error(err))
  watchMenuShown(showMenu)
  chrome.runtime.onStartup.addListener(() => void loadMenuShown().then(showMenu, (err: unknown) => console.error(err)))

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== menuItem || tab?.id === undefined) return
    // Before anything is awaited: Chrome opens the panel only while the click is being handled.
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => console.error(err))
    const { id, windowId } = tab
    void (async () => {
      const text = (await selectedText(id, info.frameId ?? 0)) || info.selectionText || ''
      if (!text.trim()) return
      await handOver(windowId, text, info.pageUrl || tab.url || '', tab.title ?? '')
    })().catch((err: unknown) => console.error('Could not attach the selected text', err))
  })
}

/**
 * Calls `onSelections` with the selections sent to the side panel of window `windowId`, in the order
 * they were sent: those sent before the panel opened, and each one sent while it is open. Each is
 * taken, so it is given once. Returns a function that stops watching.
 */
export function watchSelections(windowId: number, onSelections: (selections: Selection[]) => void): () => void {
  const start = prefix(windowId)
  // Keys already given: one written between watching and reading shows in both.
  const taken = new Set<string>()
  const take = (entries: [string, unknown][]) => {
    const fresh = entries
      .filter(([name, value]) => name.startsWith(start) && value !== undefined && !taken.has(name))
      .sort(([a], [b]) => Number(a.slice(start.length)) - Number(b.slice(start.length)))
    if (!fresh.length) return
    const selections: Selection[] = []
    for (const [name, value] of fresh) {
      taken.add(name)
      void chrome.storage.session.remove(name).catch((err: unknown) => console.error(err))
      const parsed = Selection.safeParse(value)
      if (parsed.success) selections.push(parsed.data)
      else console.error('Could not read a selection sent to the side panel', parsed.error)
    }
    if (selections.length) onSelections(selections)
  }
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'session') take(Object.entries(changes).map(([name, change]) => [name, change.newValue]))
  }
  // Watching first, then reading: a selection sent in between is not missed.
  chrome.storage.onChanged.addListener(onChanged)
  chrome.storage.session
    .get(null)
    .then((stored) => take(Object.entries(stored)))
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
