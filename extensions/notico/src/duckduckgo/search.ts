// The site layer for DuckDuckGo, the free web search a user can choose in Settings: the only module
// that knows its endpoint and the shape of its result page. The extension asks DuckDuckGo's HTML
// page (it has no API) from the user's own browser, with the host permission the user granted, and
// reads the results out of it. No tab is opened. DuckDuckGo states no limit for this page; it
// answers a client it takes for a bot with a challenge page instead of results, which turns the
// search away (see DuckDuckGoError). The HTML can change at any time: a page this module can't read
// is a search that failed, never guessed at.
import { z } from '../zod'

/** The one origin searched, and the host permission it needs. */
const DUCKDUCKGO = 'https://html.duckduckgo.com'
const PATTERN = `${DUCKDUCKGO}/*`

/** Characters of a result's title, description, and address kept: as the worker keeps (worker/src/search.ts). */
const TITLE_CHARS = 300
const DESCRIPTION_CHARS = 1000
const URL_CHARS = 2000
/** How long a search may take before it counts as failed. */
const TIMEOUT_MS = 15_000

/** Why DuckDuckGo gave no results: it turned the search away (`challenge`, `busy`), or the search failed. */
export class DuckDuckGoError extends Error {
  constructor(
    readonly code: 'challenge' | 'busy' | 'unreachable' | 'unreadable',
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
 * Searches DuckDuckGo for `query`, for at most `limit` results, never retried. Throws a
 * DuckDuckGoError when it gave none; a Stop throws what `fetch` threw.
 */
export async function searchDuckDuckGo(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<DuckDuckGoResult[]> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  let html: string
  let status: number
  try {
    // No cookies: the search is the same whoever's browser sends it, and DuckDuckGo needs none.
    const res = await fetch(`${DUCKDUCKGO}/html/?${new URLSearchParams({ q: query })}`, {
      credentials: 'omit',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    status = res.status
    html = await res.text()
  } catch (err) {
    if (signal?.aborted) throw err
    throw new DuckDuckGoError('unreachable', 'DuckDuckGo could not be reached', { cause: err })
  }
  return resultsOf(status, html, limit)
}

/** The results of DuckDuckGo's answer, or why it gave none. */
function resultsOf(status: number, html: string, limit: number): DuckDuckGoResult[] {
  const page = new DOMParser().parseFromString(html, 'text/html')
  // Its challenge ("select all squares containing a duck") comes as a 202, with a form of its own.
  if (status === 202 || page.querySelector('#challenge-form, .anomaly-modal__modal'))
    throw new DuckDuckGoError('challenge', 'DuckDuckGo asked to confirm that a person is searching')
  if (status === 429 || status === 503)
    throw new DuckDuckGoError('busy', `DuckDuckGo turned the search away (HTTP ${status})`)
  if (status !== 200) throw new DuckDuckGoError('unreadable', `DuckDuckGo answered HTTP ${status}`)
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
      title: text(link).slice(0, TITLE_CHARS),
      description: text(item.querySelector('.result__snippet')).slice(0, DESCRIPTION_CHARS),
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

/** An element's text, its runs of white space as one space. */
const text = (element: Element | null | undefined) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
