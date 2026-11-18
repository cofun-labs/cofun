// Which search the agent's web searches go to: the worker's, which costs credits, or DuckDuckGo from
// the user's own browser, free, once the user switched it on in Settings (UC-NOTICO-PANEL-004). The
// switch is kept in chrome.storage.local per account, on this device only, like the mode (mode.ts):
// one account's choice to send its queries to DuckDuckGo never carries over to another signed in on
// the same profile. It counts only while Chrome still grants the access to DuckDuckGo it needs, which
// is the profile's. Read as each search starts, so switching it applies at once.
import { ToolError } from '@cofun/agent'
import { DuckDuckGoError, mayUseDuckDuckGo, searchDuckDuckGo } from './duckduckgo/search'
import type { WebSearchResult } from '@cofun/agent'

const storageKey = (userId: string) => `duckDuckGoSearch:${userId}`

/** Whether the account switched DuckDuckGo on; true only when it did and Chrome grants the access. */
export async function loadDuckDuckGoSearch(userId: string): Promise<boolean> {
  const key = storageKey(userId)
  const stored: unknown = (await chrome.storage.local.get(key))[key]
  return stored === true && (await mayUseDuckDuckGo())
}

export async function saveDuckDuckGoSearch(userId: string, on: boolean): Promise<void> {
  await chrome.storage.local.set({ [storageKey(userId)]: on })
}

/**
 * What the user is told when DuckDuckGo's tab shows a page that is not one of results: it may be
 * turning searches away (a tab gives no HTTP status to tell), or it changed its page. Either way
 * another search would likely meet the same, so the question stops.
 */
const NOT_RESULTS =
  'DuckDuckGo showed a page that is not search results: it may be turning searches away, or its page ' +
  'changed. Try again later, or switch off "Search with DuckDuckGo" in Settings to search with credits instead.'

/**
 * What the user is told when DuckDuckGo asks to confirm a person is searching: the question stops,
 * and the search's tab stays open for them to answer it, which lets the next searches through.
 */
const CHALLENGED =
  'DuckDuckGo asked to confirm that a person is searching, so Notico could not search the web. Its tab is ' +
  'open: answer its check there, then ask again, or switch off "Search with DuckDuckGo" in Settings to search ' +
  'with credits instead.'

/**
 * The search to use instead of the worker's, or undefined for the worker's. Its failures are
 * ToolErrors as the worker's are (see ToolContext.searchWeb): DuckDuckGo's check, or any page of its
 * that is not results, stops the question; a page that did not load goes to the model, costs nothing,
 * and is never retried.
 */
export async function freeSearch(
  userId: string,
): Promise<((query: string, limit: number, signal?: AbortSignal) => Promise<WebSearchResult[]>) | undefined> {
  if (!(await loadDuckDuckGoSearch(userId))) return undefined
  return async (query, limit, signal) => {
    try {
      return await searchDuckDuckGo(query, limit, signal)
    } catch (err) {
      if (!(err instanceof DuckDuckGoError)) throw err
      const stops = err.code === 'challenge' ? CHALLENGED : err.code === 'unreadable' ? NOT_RESULTS : undefined
      // A search turned away says the same on its card as why the question stopped.
      throw new ToolError(stops ? 'search_busy' : 'search_failed', stops ?? err.message, {
        stopsQuestion: stops,
        cause: err,
      })
    }
  }
}
