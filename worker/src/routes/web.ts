// Web pages read for a signed-in user (/v1/web): fetched plainly, or rendered in Browser Run, and
// web searches. All are free; a render costs the operator browser time and a search the provider's
// price, so each has a cap of its own, far below the one on reads, until they are charged in credits
// (#464). None keeps or logs the address, the query, the page, or the results: the usage record
// holds the outcome and sizes only.
import { Hono } from 'hono'
import * as z from '../zod'
import { recordUsage, type UsageRecord } from '../usage'
import { HttpError, parse, type App, type Ctx, type Deps } from '../http'
import { MAX_QUERY_CHARS, MAX_RESULTS, SearchError, searchWeb } from '../search'
import { PageError, checkAddress, fetchPage, renderPage, type WebPage } from '../web'
import { CLIENT_HEADER, productOf } from './chat'

/** The most characters of a page's text the worker returns; the extension asks for no more. */
const MAX_CHARS = 20_000

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
export function webRoutes({ logError }: Pick<Deps, 'logError'>): App {
  const routes: App = new Hono()

  /** Counts the request against the user's WEB_LIMIT: reading pages reaches other sites, so it has a cap of its own. */
  async function limit(c: Ctx) {
    const { success } = await c.env.WEB_LIMIT.limit({ key: c.get('userId') })
    if (!success)
      throw new HttpError(429, 'rate_limited', 'Too many pages read at once. Wait a minute, then try again.')
  }

  /** A usage record for a read: the outcome, the characters returned, and what it cost. Never the address. */
  function usageOf(c: Ctx, model: string): { usage: UsageRecord; record: (outcome: string) => void } {
    const started = Date.now()
    const usage: UsageRecord = {
      userId: c.get('userId'),
      product: productOf(c.req.header(CLIENT_HEADER)),
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
    const { usage, record } = usageOf(c, 'web/fetch')
    try {
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
    const { usage, record } = usageOf(c, 'web/render')
    try {
      const body = parse(ReadBody, await c.req.json().catch(() => undefined))
      const url = checkAddress(body.url)
      if (!c.env.BROWSER) throw new HttpError(503, 'not_configured', 'rendering pages is not set up')
      await limit(c)
      const { success } = await c.env.RENDER_LIMIT.limit({ key: c.get('userId') })
      if (!success)
        throw new HttpError(429, 'rate_limited', 'Too many pages rendered at once. Wait a minute, then try again.')
      const page = await renderPage(c.env.BROWSER, url, body.max_chars)
      usage.inputChars = page.text.length
      record('ok')
      return c.json(answer(page))
    } catch (err) {
      record(err instanceof HttpError || err instanceof PageError ? err.code : 'internal')
      throw err instanceof PageError ? refused(err) : err
    }
  })

  routes.post('/search', async (c) => {
    const { usage, record } = usageOf(c, 'web/search')
    try {
      const body = parse(SearchBody, await c.req.json().catch(() => undefined))
      const gateway = c.env.AI_GATEWAY_ID
      if (!gateway) throw new HttpError(503, 'not_configured', 'web search is not set up')
      const { success } = await c.env.SEARCH_LIMIT.limit({ key: c.get('userId') })
      if (!success)
        throw new HttpError(429, 'rate_limited', 'Too many web searches at once. Wait a minute, then try again.')
      const results = await searchWeb(c.env.AI, gateway, body.query, body.limit)
      usage.inputChars = results.reduce((n, r) => n + r.title.length + r.description.length, 0)
      record('ok')
      return c.json({ results })
    } catch (err) {
      record(err instanceof HttpError || err instanceof SearchError ? err.code : 'internal')
      if (!(err instanceof SearchError)) throw err
      logError(`web search failed: ${err.logged}`)
      throw new HttpError(err.code === 'search_failed' ? 502 : 503, err.code, err.message)
    }
  })

  return routes
}
