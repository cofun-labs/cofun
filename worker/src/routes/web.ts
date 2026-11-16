// Web pages read for a signed-in user (/v1/web): fetched plainly, or rendered in Browser Run, and
// web searches. A plain read is free. A render is charged in credits, the browser time it used at
// Browser Run's price, and a search the provider's price for it; each has a cap of its own. None
// keeps or logs the address, the query, the page, or the results: the usage record holds the outcome
// and sizes only, a render's record in the ledger its outcome and browser time, and a search's its
// outcome and how many results it gave.
import { Hono } from 'hono'
import * as z from '../zod'
import { recordUsage, type UsageRecord } from '../usage'
import { HttpError, errorSummary, parse, type App, type Ctx, type Deps } from '../http'
import { MAX_QUERY_CHARS, MAX_RESULTS, SearchError, searchWeb, type SearchResult } from '../search'
import { PageError, checkAddress, fetchPage, renderPage, type WebPage } from '../web'
import { SEARCH_COST, renderCostOf } from '../pricing'
import { CLIENT_HEADER, openLedger, productOf, turnOf, type Turn } from './chat'

/**
 * The most characters of a page's text the worker returns: what the extension keeps of a long page
 * (KEPT_CHARS in its src/tools/results.ts). A plain read is bounded by MAX_BYTES in web.ts too.
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

  /**
   * A usage record for a read: the outcome, the characters returned, and what it cost. Never the
   * address. `turn` reads the chat and question the request names, into the record too; it throws
   * on a header that is not a UUID, so it is read where a refusal is recorded.
   */
  function usageOf(c: Ctx, model: string): { usage: UsageRecord; record: (outcome: string) => void; turn: () => Turn } {
    const started = Date.now()
    const usage: UsageRecord = {
      userId: c.get('userId'),
      product: productOf(c.req.header(CLIENT_HEADER)),
      chatId: '',
      turnId: '',
      model,
      stream: false,
      outcome: '',
      messages: 0,
      inputChars: 0,
      promptTokens: 0,
      cachedTokens: 0,
      completionTokens: 0,
      microCredits: 0,
      finishReason: '',
      durationMs: 0,
    }
    return {
      usage,
      turn: () => {
        const turn = turnOf(c)
        usage.chatId = turn.chatId ?? ''
        usage.turnId = turn.turnId ?? ''
        return turn
      },
      record: (outcome) => {
        usage.outcome = outcome
        usage.durationMs = Date.now() - started
        recordUsage(c.env.USAGE, usage)
      },
    }
  }

  /** A page that could not be read: 422 with the reason's code, which the extension explains to the model. */
  const refused = (err: PageError) => new HttpError(422, err.code, err.message)

  routes.post('/read', async (c) => {
    const { usage, record, turn } = usageOf(c, 'web/fetch')
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
    const { usage, record, turn } = usageOf(c, 'web/render')
    try {
      const ids = turn()
      const body = parse(ReadBody, await c.req.json().catch(() => undefined))
      const url = checkAddress(body.url)
      const browser = c.env.BROWSER
      if (!browser) throw new HttpError(503, 'not_configured', 'rendering pages is not set up')
      await limit(c)
      // Renders sent at once all start on the same balance (see below), so how many one user can
      // start a minute is capped. Checked before the credits, so a refused request reads nothing.
      const { success } = await c.env.RENDER_LIMIT.limit({ key: c.get('userId') })
      if (!success)
        throw new HttpError(429, 'rate_limited', 'Too many pages rendered at once. Wait a minute, then try again.')
      // Charged after use, as a model call is: a render goes ahead while the user has credits, and
      // costs the browser time it used. Renders sent at once can together cost more than what is
      // left: what the grants don't cover is forgiven, and RENDER_LIMIT and the render's timeout
      // bound it.
      const ledger = await openLedger(c, now().getTime(), logError)
      const product = usage.product
      const work = (async () => {
        const render = await renderPage(browser, url, body.max_chars, () => now().getTime())
        const { outcome, browserMs } = render
        const result = render.outcome === 'ok' ? render.page : render.error
        // What Browser Run bills, however the render ended: a page with no text and one that failed
        // used the browser too. When no response came back, what it billed is not known, and the
        // user is not charged a guess.
        const cost = render.answered ? renderCostOf(browserMs) : 0
        try {
          await ledger.spend({ product, ...ids, cost, at: now().getTime() }, { kind: 'web_render', outcome, browserMs })
          usage.microCredits = cost
          return { result, charged: { cost: { micro_credits: cost } } }
        } catch (err) {
          // The page is out already: it still goes to the client, uncharged, and the answer says no
          // cost, so the client does not count one the ledger never took.
          logError(`web render record failed: ${errorSummary(err)}`)
          return { result, charged: {} }
        }
      })()
      // The render is charged even if the client goes away meanwhile: a request dropped right after
      // it was sent must not be a free render.
      c.executionCtx.waitUntil(work.catch(() => {}))
      const { result, charged } = await work
      // What it cost goes with the answer, a page or why there is none, since either was charged.
      if (result instanceof PageError) {
        record(result.code)
        return c.json({ error: { code: result.code, message: result.message }, ...charged }, 422)
      }
      usage.inputChars = result.text.length
      record('ok')
      return c.json({ ...answer(result), ...charged })
    } catch (err) {
      record(err instanceof HttpError || err instanceof PageError ? err.code : 'internal')
      throw err instanceof PageError ? refused(err) : err
    }
  })

  routes.post('/search', async (c) => {
    const { usage, record, turn } = usageOf(c, 'web/search')
    try {
      const ids = turn()
      const body = parse(SearchBody, await c.req.json().catch(() => undefined))
      const gateway = c.env.AI_GATEWAY_ID
      if (!gateway) throw new HttpError(503, 'not_configured', 'web search is not set up')
      // Searches sent at once all start on the same balance (see below), so how many one user can
      // make a minute is capped. Checked before the credits, so a refused request reads nothing.
      const { success } = await c.env.SEARCH_LIMIT.limit({ key: c.get('userId') })
      if (!success)
        throw new HttpError(429, 'rate_limited', 'Too many web searches at once. Wait a minute, then try again.')
      // Charged after use, as a render is: a search goes ahead while the user has credits. Searches
      // sent at once can together cost more than what is left: what the grants don't cover is
      // forgiven, and SEARCH_LIMIT bounds it.
      const ledger = await openLedger(c, now().getTime(), logError)
      const product = usage.product
      const work = (async () => {
        let results: SearchResult[] = []
        let error: SearchError | undefined
        try {
          results = await searchWeb(c.env.AI, gateway, body.query, body.limit)
        } catch (err) {
          if (!(err instanceof SearchError)) throw err
          error = err
        }
        // What the provider bills: a search that gave results (none included), or an answer the
        // worker does not understand. One the gateway turned away, or with no response, costs nothing.
        const cost = error && !error.billed ? 0 : SEARCH_COST
        const outcome = error?.code ?? 'ok'
        try {
          await ledger.spend(
            { product, ...ids, cost, at: now().getTime() },
            { kind: 'web_search', outcome, results: results.length },
          )
          usage.microCredits = cost
          return { results, error, charged: { cost: { micro_credits: cost } } }
        } catch (err) {
          // The results are out already: they still go to the client, uncharged, and the answer
          // says no cost, so the client does not count one the ledger never took.
          logError(`web search record failed: ${errorSummary(err)}`)
          return { results, error, charged: {} }
        }
      })()
      // The search is charged even if the client goes away meanwhile.
      c.executionCtx.waitUntil(work.catch(() => {}))
      const { results, error, charged } = await work
      // What it cost goes with the answer, results or why there are none.
      if (error) {
        record(error.code)
        logError(`web search failed: ${error.logged}`)
        const status = error.code === 'search_failed' ? 502 : 503
        return c.json({ error: { code: error.code, message: error.message }, ...charged }, status)
      }
      usage.inputChars = results.reduce((n, r) => n + r.title.length + r.description.length, 0)
      record('ok')
      return c.json({ results, ...charged })
    } catch (err) {
      record(err instanceof HttpError ? err.code : 'internal')
      throw err
    }
  })

  return routes
}
