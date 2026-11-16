// Charging a signed-in user's credits after use, the same way for every paid call: a model call, a
// render, a search. The ledger is opened before the call, which goes ahead while the user has
// credits, and the call is charged once it ended:
//
// - a call that failed costs nothing (a model call that errors or whose stream breaks off, a render
//   that fails or shows no text, a search turned away or answered in a way the worker does not
//   understand): what the service bills for it is ours;
// - a call that succeeded costs what it used;
// - a streamed reply the user stopped costs an estimate of what it used so far (routes/chat.ts).
//
// Calls sent at once all start on the same balance, so together they can cost more than what is
// left: what the grants don't cover is forgiven, and each route's rate limit bounds it.
import { FREE_CREDITS, Ledger, type Balance, type SpendDetail } from './credits'
import { HttpError, errorSummary, type Ctx } from './http'
import { recordUsage, type UsageRecord } from './usage'
import * as z from './zod'

/** The product of a call that names none, or a name that is not one. */
const UNKNOWN_PRODUCT = 'unknown'

/**
 * The header in which an extension says who it is: its product and version, `X-Cofun-Client:
 * notico/0.3.0`. Only the product is read; the version is not kept.
 */
export const CLIENT_HEADER = 'x-cofun-client'

/** A product name: lowercase letters, never `unknown`. */
const ProductName = z
  .string()
  .regex(/^[a-z]{1,32}$/)
  .refine((name) => name !== UNKNOWN_PRODUCT)

/**
 * The product a call comes from, as the extension names it in CLIENT_HEADER, or `unknown` when it
 * names none (store builds up to Notico 0.2.0 send no header) or a name that is not one. The
 * client's own word: the product only sorts what was spent, and credits are one balance across
 * products, so a wrong name costs no one anything, and a call is never refused over it.
 */
function productOf(header: string | undefined): string {
  return ProductName.safeParse(header?.split('/')[0]).data ?? UNKNOWN_PRODUCT
}

/**
 * The usage record of a request on `model`, and how to write it once, with how the request ended.
 * Filled with sizes, token counts, and what was charged only: never the request's content.
 */
export function startUsage(c: Ctx, model: string): { usage: UsageRecord; record: (outcome: string) => void } {
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

/** A time as the out-of-credits message gives it: to the minute, in UTC, since the worker does not know the user's time zone. */
function utcMinute(ms: number): string {
  // Rounded up, so the time named is never before the credits arrive.
  const iso = new Date(Math.ceil(ms / 60_000) * 60_000).toISOString()
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`
}

/**
 * The user's ledger, opened before a paid call: it gives the weekly free grant if they have none,
 * and lets the call go ahead while the balance is above zero. Refuses with `out_of_credits` when
 * nothing is left, and with `credits_unavailable` when the credits can't be read, so nothing is
 * spent that can't be charged.
 */
export async function openLedger(c: Ctx, now: number, logError: (line: string) => void): Promise<Ledger> {
  const ledger = new Ledger(c.env.DB, c.get('userId'))
  let balance: Balance
  try {
    balance = await ledger.open(now)
  } catch (err) {
    logError(`credit check failed: ${errorSummary(err)}`)
    throw new HttpError(503, 'credits_unavailable', 'Credits are unavailable, try again in a moment.')
  }
  if (balance.balance <= 0) {
    throw new HttpError(
      402,
      'out_of_credits',
      `You have no credits left. Your next ${FREE_CREDITS} free credits arrive on ${utcMinute(balance.nextGrantAt)}, or you can buy credits.`,
    )
  }
  return ledger
}

/** What charging a call needs besides the call: who pays, the clock, and the log. `what` names the call in the log. */
export interface Charging {
  ledger: Ledger
  usage: UsageRecord
  now: () => number
  logError: (line: string) => void
  what: string
}

/**
 * Charges a call that ended: records it as a spend, with its detail row, and takes `cost` from the
 * user's credits. Every call that reached the service is recorded, failed ones too, at no cost.
 * Gives what was charged: `cost`, or 0 when the record failed, which is logged: the call has
 * ended, so what it gave still goes to the client, uncharged.
 */
export async function charge(
  { ledger, usage, now, logError, what }: Charging,
  cost: number,
  detail: SpendDetail,
  at = now(),
): Promise<number> {
  try {
    await ledger.spend({ product: usage.product, cost, at }, detail)
  } catch (err) {
    logError(`${what} record failed: ${errorSummary(err)}`)
    return 0
  }
  usage.microCredits = cost
  return cost
}

/**
 * Runs a paid call that gives its result at once (a render, a search), and charges it what `work`
 * says it cost. The call is charged even if the client goes away meanwhile: a request dropped right
 * after it was sent must not be a free call. Gives the result with what was charged.
 */
export async function chargeAfterUse<T>(
  c: Ctx,
  charging: Charging,
  work: () => Promise<{ result: T; cost: number; detail: SpendDetail }>,
): Promise<{ result: T; charged: number }> {
  const done = (async () => {
    const { result, cost, detail } = await work()
    return { result, charged: await charge(charging, cost, detail) }
  })()
  c.executionCtx.waitUntil(done.catch(() => {}))
  return await done
}
