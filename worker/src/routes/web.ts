// Web pages read for a signed-in user (/v1/web), plainly or rendered in Browser Run, and web
// searches. A plain read is free; a render and a search are charged as charge.ts says, each with a
// cap of its own. Nothing keeps or logs the address, the query, the page, or the results.
import { Hono } from 'hono'
import * as z from '../zod'
import { HttpError, parse, type App, type Ctx, type Deps } from '../http'
import { MAX_QUERY_CHARS, MAX_RESULTS, SearchError, searchWeb, type SearchResult } from '../search'
import { PageError, checkAddress, fetchPage, renderPage, type WebPage } from '../web'
import { SEARCH_COST, renderCostOf } from '../pricing'
import { chargeAfterUse, openLedger, startUsage } from '../charge'

/**
 * The most characters of a page's text the worker returns: what the extension keeps of a long page
 * (KEPT_CHARS in @cofun/tools, packages/tools/src/tools/results.ts). A plain read is bounded by MAX_BYTES in web.ts too.
 * Versions of the extension that clip a page themselves ask for 20,000, and get that.
 */
const MAX_CHARS = 2_000_000

/** What the extension asks to read: the address, and how much of its text to return at most. */
const ReadBody = z.object({
  url: z.string().min(1).max(2048),
  max_chars: z.number().int().min(1).max(MAX_CHARS),
})

/** What the extension asks to search for: the query, and how many results it wants at most. */
const SearchBody = z.object({
  query: z.string().trim().min(1).max(MAX_QUERY_CHARS),
  limit: z.number().int().min(1).max(MAX_RESULTS),
})

/** What a render or a search was charged, in every answer of one: 0 when it failed or its record did. */
const costOf = (charged: number) => ({ cost: { micro_credits: charged } })

/** The status of a failed render or search: 503 for one turned away (it stops the question), else 422 or 502. */
const statusOf = (code: string) =>
  code === 'render_busy' || code === 'search_busy' || code === 'search_unavailable'
    ? 503
    : code === 'search_failed'
      ? 502
      : 422

/** The answer: the page as read. */
function answer(page: WebPage) {
  const { url, title, text, chars, scripted } = page
  return { url, title, text, chars, scripted }
}

/** The routes for web pages and searches, mounted at /v1/web after the default rate limit. */
export function webRoutes({ now, logError }: Pick<Deps, 'now' | 'logError'>): App {
  const routes: App = new Hono()

  /** Counts the request against the user's WEB_LIMIT: reading pages reaches other sites, so it has a cap of its own. */
  async function limit(c: Ctx) {
    const { success } = await c.env.WEB_LIMIT.limit({ key: c.get('userId') })
    if (!success)
      throw new HttpError(429, 'rate_limited', 'Too many pages read at once. Wait a minute, then try again.')
  }

  /** A page that could not be read: 422 with the reason's code, which the extension explains to the model. */
  const refused = (err: PageError) => new HttpError(422, err.code, err.message)

  routes.post('/read', async (c) => {
    const { usage, record, turn } = startUsage(c, 'web/fetch')
    try {
      // A plain read spends nothing, so only its usage record has them.
      turn()
      const body = parse(ReadBody, await c.req.json().catch(() => undefined))
      await limit(c)
      const page = await fetchPage(
        c.env.WEB ?? { fetch: (request) => fetch(request) },
        checkAddress(body.url),
        body.max_chars,
      )
      usage.inputChars = page.text.length
      record('ok')
      return c.json(answer(page))
    } catch (err) {
      record(err instanceof HttpError || err instanceof PageError ? err.code : 'internal')
      throw err instanceof PageError ? refused(err) : err
    }
  })

  routes.post('/render', async (c) => {
    const { usage, record, turn } = startUsage(c, 'web/render')
    try {
      const ids = turn()
      const body = parse(ReadBody, await c.req.json().catch(() => undefined))
      const url = checkAddress(body.url)
      const browser = c.env.BROWSER
      if (!browser) throw new HttpError(503, 'not_configured', 'rendering pages is not set up')
      await limit(c)
      // Checked before the credits, so a refused request reads nothing.
      const { success } = await c.env.RENDER_LIMIT.limit({ key: c.get('userId') })
      if (!success)
        throw new HttpError(429, 'rate_limited', 'Too many pages rendered at once. Wait a minute, then try again.')
      const ledger = await openLedger(c, now().getTime(), logError)
      const charging = { ledger, usage, turn: ids, now: () => now().getTime(), logError, what: 'web render' }
      const { result, charged } = await chargeAfterUse<WebPage | PageError>(c, charging, async () => {
        const render = await renderPage(browser, url, body.max_chars)
        const { outcome, browserMs } = render
        const cost = outcome === 'ok' ? renderCostOf(browserMs) : 0
        return {
          result: outcome === 'ok' ? render.page : render.error,
          cost,
          detail: { kind: 'web_render', outcome, browserMs },
        }
      })
      if (result instanceof PageError) {
        record(result.code)
        return c.json(
          { error: { code: result.code, message: result.message }, ...costOf(charged) },
          statusOf(result.code),
        )
      }
      usage.inputChars = result.text.length
      record('ok')
      return c.json({ ...answer(result), ...costOf(charged) })
    } catch (err) {
      record(err instanceof HttpError || err instanceof PageError ? err.code : 'internal')
      throw err instanceof PageError ? refused(err) : err
    }
  })

  routes.post('/search', async (c) => {
    const { usage, record, turn } = startUsage(c, 'web/search')
    try {
      const ids = turn()
      const body = parse(SearchBody, await c.req.json().catch(() => undefined))
      const gateway = c.env.AI_GATEWAY_ID
      if (!gateway) throw new HttpError(503, 'not_configured', 'web search is not set up')
      // Checked before the credits, so a refused request reads nothing.
      const { success } = await c.env.SEARCH_LIMIT.limit({ key: c.get('userId') })
      if (!success)
        throw new HttpError(429, 'rate_limited', 'Too many web searches at once. Wait a minute, then try again.')
      const ledger = await openLedger(c, now().getTime(), logError)
      const charging = { ledger, usage, turn: ids, now: () => now().getTime(), logError, what: 'web search' }
      const { result, charged } = await chargeAfterUse<SearchResult[] | SearchError>(c, charging, async () => {
        let results: SearchResult[]
        try {
          results = await searchWeb(c.env.AI, gateway, body.query, body.limit)
        } catch (err) {
          if (!(err instanceof SearchError)) throw err
          return { result: err, cost: 0, detail: { kind: 'web_search', outcome: err.code, results: 0 } }
        }
        return {
          result: results,
          cost: SEARCH_COST,
          detail: { kind: 'web_search', outcome: 'ok', results: results.length },
        }
      })
      if (result instanceof SearchError) {
        record(result.code)
        logError(`web search failed: ${result.logged}`)
        return c.json(
          { error: { code: result.code, message: result.message }, ...costOf(charged) },
          statusOf(result.code),
        )
      }
      usage.inputChars = result.reduce((n, r) => n + r.title.length + r.description.length, 0)
      record('ok')
      return c.json({ results: result, ...costOf(charged) })
    } catch (err) {
      record(err instanceof HttpError ? err.code : 'internal')
      throw err
    }
  })

  return routes
}
