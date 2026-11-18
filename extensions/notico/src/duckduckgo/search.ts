// The site layer for DuckDuckGo, the free web search a user can choose in Settings: the only module
// that knows its endpoint and the shape of its result page. DuckDuckGo has no API: the search opens
// its HTML results page in a background tab of the user's own browser, as the user would, with the
// host permission they granted, and reads the results out of it (tab.ts). Nothing pretends to be
// anything: when DuckDuckGo asks to confirm a person is searching, the search stops and its tab
// stays open for the person; Notico never answers the check. The HTML can change at any time: a
// page this module can't read is a search that failed, never guessed at.
import { z } from '../zod'
import { closeSearchTab, openSearchPage } from './tab'

/** The one origin searched, and the host permission it needs. */
const DUCKDUCKGO = 'https://html.duckduckgo.com'
const PATTERN = `${DUCKDUCKGO}/*`

/** Characters of a result's title, description, and address kept: as the worker keeps (worker/src/search.ts). */
const TITLE_CHARS = 300
const DESCRIPTION_CHARS = 1000
const URL_CHARS = 2000
/**
 * Why DuckDuckGo gave no results: it asked a person to confirm (`challenge`), its tab showed a page
 * that is not one of results (`unreadable`: a tab has no HTTP status, so a page turning searches away
 * for coming too often is one of these), or the page did not load (`unreachable`).
 */
export class DuckDuckGoError extends Error {
  constructor(
    readonly code: 'challenge' | 'unreachable' | 'unreadable',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/** A result as DuckDuckGo lists it, checked: a web address, its title, and what the page holds. */
const Result = z.object({
  url: z
    .string()
    .max(URL_CHARS)
    .refine((url) => /^https?:\/\//i.test(url)),
  title: z.string().min(1),
  description: z.string(),
})
export type DuckDuckGoResult = z.infer<typeof Result>

/** Whether the user granted Notico access to DuckDuckGo. */
export function mayUseDuckDuckGo(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [PATTERN] })
}

/**
 * Asks Chrome to let Notico reach DuckDuckGo, which shows the user Chrome's own prompt. Chrome takes
 * the request only during a user's click or key press: call it in its handler, before anything is
 * awaited. Resolves true once Chrome granted it.
 */
export function allowDuckDuckGo(): Promise<boolean> {
  return chrome.permissions.request({ origins: [PATTERN] })
}

/**
 * Searches DuckDuckGo for `query`, for at most `limit` results, never retried: opens its results
 * page in a background tab (tab.ts), reads it, and closes the tab. Throws a DuckDuckGoError when it
 * gave none; on its challenge the tab stays open, so the person can answer it there. A Stop
 * closes the tab and throws the signal's reason.
 */
export async function searchDuckDuckGo(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<DuckDuckGoResult[]> {
  let page
  try {
    page = await openSearchPage(`${DUCKDUCKGO}/html/?${new URLSearchParams({ q: query })}`, signal)
  } catch (err) {
    if (signal?.aborted) throw err
    throw new DuckDuckGoError('unreachable', 'DuckDuckGo could not be reached', { cause: err })
  }
  let results
  try {
    results = resultsOf(page.url, page.html, limit)
  } catch (err) {
    // Its challenge is for a person to answer: the tab stays for them. Anything else is done with.
    if (!(err instanceof DuckDuckGoError && err.code === 'challenge')) closeSearchTab(page.tabId)
    throw err
  }
  closeSearchTab(page.tabId)
  return results
}

/** The results the page lists, or why it lists none. Closes nothing: the caller does. */
function resultsOf(url: string, html: string, limit: number): DuckDuckGoResult[] {
  // A page elsewhere (DuckDuckGo moved the search, or the tab was taken somewhere) is not one of results.
  if (new URL(url).origin !== DUCKDUCKGO)
    throw new DuckDuckGoError('unreadable', 'DuckDuckGo gave a page Notico could not read')
  // An inert document: nothing in it loads or runs.
  const page = new DOMParser().parseFromString(html, 'text/html')
  // Its challenge ("select all squares containing a duck") comes with a form of its own.
  if (page.querySelector('#challenge-form, .anomaly-modal__modal'))
    throw new DuckDuckGoError('challenge', 'DuckDuckGo asked to confirm that a person is searching')
  // The list is there, with or without results; without it, the page is not one of results.
  const list = page.querySelector('#links')
  if (!list) throw new DuckDuckGoError('unreadable', 'DuckDuckGo gave a page Notico could not read')
  const results: DuckDuckGoResult[] = []
  for (const item of list.querySelectorAll('.result')) {
    if (results.length === limit) break
    // Ads link to the advertiser through DuckDuckGo's own ad redirect.
    if (item.matches('.result--ad')) continue
    const link = item.querySelector('a.result__a')
    const parsed = Result.safeParse({
      url: addressOf(link?.getAttribute('href') ?? ''),
      title: clip(text(link), TITLE_CHARS),
      description: clip(text(item.querySelector('.result__snippet')), DESCRIPTION_CHARS),
    })
    // One result that can't be read leaves out only itself.
    if (parsed.success) results.push(parsed.data)
  }
  return results
}

/** A result's real address: DuckDuckGo links to it through its redirect, `//duckduckgo.com/l/?uddg=<address>`. */
function addressOf(href: string): string | undefined {
  try {
    const url = new URL(href, DUCKDUCKGO)
    if (url.hostname === 'duckduckgo.com' && url.pathname === '/l/') return url.searchParams.get('uddg') ?? undefined
    return url.href
  } catch {
    return undefined
  }
}

/** Text cut to `max` characters, ending with `…` when cut, as the worker clips (worker/src/search.ts). */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** An element's text, its runs of white space as one space. */
const text = (element: Element | null | undefined) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
