// Web pages read for a signed-in user (/v1/web): fetched plainly, for free, or rendered in Browser
// Run, charged to the user's credits by the browser time it used. Neither keeps or logs the address
// or the page: the usage record holds the outcome and sizes only.
import { Hono } from 'hono'
import * as z from '../zod'
import { FREE_CREDITS, Ledger } from '../credits'
import { browserCost } from '../pricing'
import { recordUsage, type UsageRecord } from '../usage'
import { HttpError, errorSummary, parse, type App, type Ctx, type Deps } from '../http'
import { PageError, checkAddress, fetchPage, renderPage, type WebPage } from '../web'
import { CLIENT_HEADER, productOf, utcMinute } from './chat'

/** The most characters of a page's text the worker returns; the extension asks for no more. */
const MAX_CHARS = 20_000

/** What the extension asks to read: the address, and how much of its text to return at most. */
const ReadBody = z.object({
  url: z.string().min(1).max(2048),
  max_chars: z.number().int().min(1).max(MAX_CHARS),
})

/** The answer: the page as read. `micro_credits`: what reading it cost, 0 for a plain fetch. */
function answer(page: WebPage, microCredits: number) {
  const { url, title, text, chars, scripted } = page
  return { url, title, text, chars, scripted, cost: { micro_credits: microCredits } }
}

/** The routes for web pages, mounted at /v1/web after the default rate limit. */
export function webRoutes({ now, logError }: Deps): App {
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
      return c.json(answer(page, 0))
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
      // Charged after use, like a model call: a render goes ahead while the user has credits.
      const ledger = new Ledger(c.env.DB, c.get('userId'))
      let balance
      try {
        balance = await ledger.open(now().getTime())
      } catch (err) {
        logError(`credit check failed: ${errorSummary(err)}`)
        throw new HttpError(503, 'credits_unavailable', 'Credits are unavailable, try again in a moment.')
      }
      if (balance.balance <= 0)
        throw new HttpError(
          402,
          'out_of_credits',
          `You have no credits left. Your next ${FREE_CREDITS} free credits arrive on ${utcMinute(balance.nextGrantAt)}, or you can buy credits.`,
        )
      const startedAt = now().getTime()
      // A render that fails costs the user nothing, whatever browser time it used.
      const page = await renderPage(c.env.BROWSER, url, body.max_chars, () => now().getTime() - startedAt)
      const cost = browserCost(page.browserMs)
      // Recorded with the user's model calls, as a call of its own, so the balance and the usage per
      // day count it. Run to its end even if the client goes away; a record that fails is logged and
      // the page still goes out, uncharged, as a model call's would.
      const charge = ledger
        .endCall({
          product: usage.product,
          model: 'web/render',
          startedAt,
          endedAt: Math.max(startedAt, now().getTime()),
          stream: false,
          outcome: 'ok',
          finishReason: '',
          promptTokens: 0,
          cachedTokens: 0,
          completionTokens: 0,
          estimated: false,
          cost,
        })
        .then(
          () => true,
          (err: unknown) => {
            logError(`render record failed: ${errorSummary(err)}`)
            return false
          },
        )
      c.executionCtx.waitUntil(charge)
      const charged = (await charge) ? cost : 0
      usage.inputChars = page.text.length
      usage.microCredits = charged
      record('ok')
      return c.json(answer(page, charged))
    } catch (err) {
      record(err instanceof HttpError || err instanceof PageError ? err.code : 'internal')
      throw err instanceof PageError ? refused(err) : err
    }
  })

  return routes
}
