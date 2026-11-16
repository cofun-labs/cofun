// Searches the web for a signed-in user, with Cloudflare's Web Search API in AI Gateway
// (https://developers.cloudflare.com/web-search/), through the AI binding. The provider is fixed
// here: Ceramic, which keeps no data of the requests it serves (zero data retention), so a query,
// which may hold text from the user's Notion, is not kept by whoever answers it. The worker keeps
// and logs neither the query nor the results. Nor does the gateway, only because its log collection
// is off for the whole gateway (docs/development.md, "Worker"): unlike a model call, a search can't
// turn it off by itself: the binding documents no such option, and the REST API stores the query
// even with `collectLog: false` in its gateway options.
import * as z from './zod'

/** The search provider. One, fixed: the privacy page names it. */
const PROVIDER = 'ceramic'

/** The longest query the API takes. */
export const MAX_QUERY_CHARS = 1024
/** The most results the API gives for one search. */
export const MAX_RESULTS = 10
/** Characters of a result's title and description kept: Ceramic describes a page in up to 8,000. */
const TITLE_CHARS = 300
const DESCRIPTION_CHARS = 1000
/** The longest result address kept: what the extension shows its model of one, uncut. */
const URL_CHARS = 2000

/** What the AI binding takes for a search (`env.AI.websearch`). */
export interface SearchOptions {
  gatewayId: string
  query: string
  provider: string
  limit: number
}

/** One result: a page's address, its title, and what the provider says it holds, clipped. */
export interface SearchResult {
  url: string
  title: string
  description: string
}

/** How a search ended: `ok`, or why it gave no results. */
export type SearchOutcome = 'ok' | SearchError['code']

/**
 * Why a search did not give results, as a code the extension tells the user about. The codes are a
 * contract with the extension (`src/agent/worker.ts`): `search_unavailable` and `search_busy` stop the
 * question, and `search_failed` goes to the model as a tool error.
 */
export class SearchError extends Error {
  constructor(
    readonly code: 'search_unavailable' | 'search_busy' | 'search_failed',
    message: string,
    /** What the logs keep of the cause: a status and the API's own code, never the query. */
    readonly logged: string,
    /**
     * Whether the provider billed the search: it answered, but not with what the worker understands.
     * A search the gateway turned away, or one that brought no response, was not billed, as far as
     * the worker can tell: neither the gateway nor Ceramic documents which failures are billed.
     */
    readonly billed = false,
  ) {
    super(message)
  }
}

/** The answer of a search, as the docs give it; fields beyond these are not read. */
const Answer = z.object({
  items: z.array(z.object({ url: z.string(), title: z.string(), description: z.string() })),
})

/** A refusal from AI Gateway: `{ ok: false, error: { code, … } }`. Only a code that is an identifier is read. */
const Refusal = z.object({ error: z.object({ code: z.string().regex(/^[a-z_]{1,64}$/) }) })

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * Searches the web for `query`, for at most `limit` results, through the gateway `gatewayId`.
 * Throws a SearchError when the search gave none: the gateway refused it, or answered what the
 * worker does not understand. Nothing is retried: a search the provider ran was billed. A search
 * that gave results, none included, was billed.
 */
export async function searchWeb(
  ai: { websearch(options: SearchOptions): Promise<Response> },
  gatewayId: string,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  let res: Response
  try {
    res = await ai.websearch({ gatewayId, query, provider: PROVIDER, limit })
  } catch (err) {
    // Only the error's name: its message may quote the request, query included.
    const name = err instanceof Error ? String(err.name).slice(0, 60) : typeof err
    throw new SearchError('search_failed', 'the search failed', `threw ${name}`)
  }
  const body: unknown = await res.json().catch(() => undefined)
  if (!res.ok) {
    const code = Refusal.safeParse(body).data?.error.code ?? 'unknown'
    const logged = `${res.status} ${code}`
    // The account's AI Gateway credits ran out: the operator's to fix, not the user's.
    if (res.status === 402) throw new SearchError('search_unavailable', 'web search is not available right now', logged)
    if (res.status === 429) throw new SearchError('search_busy', 'the search provider is busy', logged)
    throw new SearchError('search_failed', 'the search failed', logged)
  }
  const answer = Answer.safeParse(body)
  if (!answer.success)
    throw new SearchError(
      'search_failed',
      'the search gave an answer the worker does not understand',
      'bad answer',
      true,
    )
  // A result with a longer address is left out, rather than handed on cut short or failing the rest.
  const kept = answer.data.items.filter((item) => item.url.length <= URL_CHARS)
  return kept.slice(0, limit).map((item) => ({
    url: item.url,
    title: clip(item.title.trim(), TITLE_CHARS),
    description: clip(item.description.trim(), DESCRIPTION_CHARS),
  }))
}
