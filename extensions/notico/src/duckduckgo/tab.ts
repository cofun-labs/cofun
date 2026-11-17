// Opens DuckDuckGo's results page for a search in a tab of the side panel's window, in the
// background, and reads the page it shows, with chrome.scripting in the ISOLATED world: the user's
// own browser loads the page as it loads any other, and nothing is sent to DuckDuckGo but that page
// load. The tab is the user's to see; the caller closes it once read, or leaves it open when
// DuckDuckGo asks the person to confirm they are searching (search.ts).
import { z } from '../zod'

/** How long the page may take to load and be read before the search counts as failed. */
const TIMEOUT_MS = 20_000

/** What the script in the tab returns: where the page is, and its HTML. Parsed, not trusted. */
const Page = z.object({ url: z.string(), html: z.string() })
export type SearchPage = z.infer<typeof Page> & { tabId: number }

/** Why the tab gave no page: it did not load (closed, an error page, too slow). */
class TabError extends Error {}

/**
 * Opens `url` in a background tab of the side panel's window and resolves with the page it shows
 * once loaded, leaving the tab open. Rejects with a TabError when it did not load, closing the tab;
 * a Stop closes it too and rejects with the signal's reason.
 */
export async function openSearchPage(url: string, signal?: AbortSignal): Promise<SearchPage> {
  signal?.throwIfAborted()
  const window = await chrome.windows.getCurrent()
  const tab = await chrome.tabs.create({ url, active: false, windowId: window.id })
  const tabId = tab.id
  if (tabId === undefined) throw new TabError('Chrome opened no tab for the search')
  try {
    await loaded(tabId, new URL(url).origin, signal)
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => ({ url: location.href, html: document.documentElement.outerHTML }),
    })
    const page = Page.safeParse(injection?.result)
    if (!page.success) throw new TabError('the search tab gave nothing Notico could read')
    return { ...page.data, tabId }
  } catch (err) {
    closeSearchTab(tabId)
    if (signal?.aborted) throw signal.reason
    if (err instanceof TabError) throw err
    // Chrome can't run a script on its own error page (DuckDuckGo did not answer) or a tab gone.
    throw new TabError('the search page did not load', { cause: err })
  }
}

/** Closes the search tab, if it is still open. */
export function closeSearchTab(tabId: number): void {
  chrome.tabs.remove(tabId).catch(() => {})
}

/**
 * Resolves once the tab finished loading a page on `origin` (a new tab may first report its blank
 * page as complete); rejects when it was closed, too slow, or stopped.
 */
function loaded(tabId: number, origin: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.tabs.onRemoved.removeListener(onRemoved)
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    const on = (tab: { status?: string; url?: string }) =>
      tab.status === 'complete' && !!tab.url && URL.canParse(tab.url) && new URL(tab.url).origin === origin
    const onUpdated = (id: number, _change: object, tab: chrome.tabs.Tab) => {
      if (id === tabId && on(tab)) done()
    }
    const onRemoved = (id: number) => {
      if (id === tabId) done(new TabError('the search tab was closed'))
    }
    const onAbort = () => done(new TabError('stopped'))
    const timer = setTimeout(() => done(new TabError('the search page took too long to load')), TIMEOUT_MS)
    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.tabs.onRemoved.addListener(onRemoved)
    signal?.addEventListener('abort', onAbort)
    // A Stop while the tab was being opened fired before the listener was added.
    if (signal?.aborted) return done(new TabError('stopped'))
    // It may have loaded before the listener was added.
    chrome.tabs.get(tabId).then(
      (tab) => on(tab) && done(),
      () => done(new TabError('the search tab was closed')),
    )
  })
}
