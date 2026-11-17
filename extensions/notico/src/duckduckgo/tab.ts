// Opens DuckDuckGo's results page for a search in a tab of the side panel's window, in the
// background, and reads the page it shows, with chrome.scripting in the ISOLATED world: the user's
// own browser loads the page as it loads any other, and nothing is sent to DuckDuckGo but that page
// load. The tab is the user's to see; the caller closes it once read, or leaves it open when
// DuckDuckGo asks the person to confirm they are searching (search.ts).
import { z } from '../zod'

/** How long the page may take to load and be read, together, before the search counts as failed. */
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
  // One deadline for loading the page and reading it.
  const deadline = AbortSignal.timeout(TIMEOUT_MS)
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline
  try {
    const at = await loaded(tabId, stop)
    // Taken elsewhere (DuckDuckGo moved the search, or turns it away by a redirect): not read, since
    // Notico may not run scripts there; the caller finds no results page.
    if (at.origin !== new URL(url).origin) return { url: at.href, html: '', tabId }
    const [injection] = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: () => ({ url: location.href, html: document.documentElement.outerHTML }),
      }),
      stopped(stop),
    ])
    const page = Page.safeParse(injection?.result)
    if (!page.success) throw new TabError('the search tab gave nothing Notico could read')
    return { ...page.data, tabId }
  } catch (err) {
    closeSearchTab(tabId)
    if (signal?.aborted) throw signal.reason
    if (deadline.aborted) throw new TabError('the search page took too long to load', { cause: err })
    if (err instanceof TabError) throw err
    // Chrome can't run a script on its own error page (DuckDuckGo did not answer) or a tab gone.
    throw new TabError('the search page did not load', { cause: err })
  }
}

/** Closes the search tab, if it is still open. */
export function closeSearchTab(tabId: number): void {
  chrome.tabs.remove(tabId).catch(() => {})
}

/** Rejects once `signal` aborts: a Stop, or the deadline. */
function stopped(signal: AbortSignal): Promise<never> {
  const rejected = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new TabError('stopped'))
    signal.addEventListener('abort', () => reject(new TabError('stopped')), { once: true })
  })
  // The deadline fires after a read that won the race too: nobody waits on it then.
  rejected.catch(() => {})
  return rejected
}

/**
 * Resolves with where the tab is once it finished loading a web page, wherever it was taken (a new
 * tab may first report its blank page as complete); rejects when it was closed, or `signal` aborts
 * (a Stop, or the deadline).
 */
function loaded(tabId: number, signal: AbortSignal): Promise<URL> {
  return new Promise((resolve, reject) => {
    let page: URL | undefined
    const done = (err?: Error) => {
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.tabs.onRemoved.removeListener(onRemoved)
      signal.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve(page!)
    }
    const on = (tab: { status?: string; url?: string }) => {
      if (tab.status !== 'complete' || !tab.url || !URL.canParse(tab.url)) return false
      const at = new URL(tab.url)
      if (at.protocol !== 'https:' && at.protocol !== 'http:') return false
      page = at
      return true
    }
    const onUpdated = (id: number, _change: object, tab: chrome.tabs.Tab) => {
      if (id === tabId && on(tab)) done()
    }
    const onRemoved = (id: number) => {
      if (id === tabId) done(new TabError('the search tab was closed'))
    }
    const onAbort = () => done(new TabError('stopped'))
    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.tabs.onRemoved.addListener(onRemoved)
    signal.addEventListener('abort', onAbort)
    // A Stop while the tab was being opened fired before the listener was added.
    if (signal.aborted) return done(new TabError('stopped'))
    // It may have loaded before the listener was added.
    chrome.tabs.get(tabId).then(
      (tab) => on(tab) && done(),
      () => done(new TabError('the search tab was closed')),
    )
  })
}
