// Which search the agent's web searches go to: the worker's, which costs credits, or DuckDuckGo from
// the user's own browser, free, once the user switched it on in Settings (UC-NOTICO-PANEL-004). The
// switch is kept in chrome.storage.local, for this device, and counts only while Chrome still grants
// the access to DuckDuckGo it needs. Read as each search starts, so switching it applies at once.
import { WebError } from './agent'
import { DuckDuckGoError, mayUseDuckDuckGo, searchDuckDuckGo } from './duckduckgo/search'
import type { WebSearchResult } from './agent'

const SETTING = 'duckDuckGoSearch'

/** Whether the user switched DuckDuckGo on; true only when they did and Chrome grants the access. */
export async function loadDuckDuckGoSearch(): Promise<boolean> {
  const stored: unknown = (await chrome.storage.local.get(SETTING))[SETTING]
  return stored === true && (await mayUseDuckDuckGo())
}

export async function saveDuckDuckGoSearch(on: boolean): Promise<void> {
  await chrome.storage.local.set({ [SETTING]: on })
}

/** What the user is told when DuckDuckGo turns a search away: the question stops. */
const TURNED_AWAY =
  'Try again later, or switch off "Search with DuckDuckGo" in Settings to search with credits instead.'

/**
 * The search to use instead of the worker's, or undefined for the worker's. Its failures are
 * WebErrors as the worker's are (see ToolContext.searchWeb): one turned away stops the question; any
 * other goes to the model, costs nothing, and is never retried.
 */
export async function freeSearch(): Promise<
  ((query: string, limit: number, signal?: AbortSignal) => Promise<WebSearchResult[]>) | undefined
> {
  if (!(await loadDuckDuckGoSearch())) return undefined
  return async (query, limit, signal) => {
    try {
      return await searchDuckDuckGo(query, limit, signal)
    } catch (err) {
      if (!(err instanceof DuckDuckGoError)) throw err
      const stops =
        err.code === 'challenge'
          ? `DuckDuckGo asked to confirm that a person is searching, so Notico could not search the web. ${TURNED_AWAY}`
          : err.code === 'busy'
            ? `DuckDuckGo turned Notico's searches away. ${TURNED_AWAY}`
            : undefined
      // A search turned away says the same on its card as why the question stopped.
      throw new WebError(stops ? 'search_busy' : 'search_failed', stops ?? err.message, {
        stopsQuestion: stops,
        cause: err,
      })
    }
  }
}
