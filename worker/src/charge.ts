// Charging after use, for every paid call (a model call, a render, a search): it goes ahead while
// the balance is above zero, and once it ended, one that failed costs nothing, one that succeeded
// what it used, and a streamed reply cut short an estimate of it (routes/chat.ts). What the grants
// don't cover is forgiven: each route's rate limit bounds it, and for model calls, which can run for
// minutes, so does how many one user can have going at once (CALL_SLOTS).
import { CALL_SLOTS, FREE_CREDITS, Ledger, MICRO_CREDITS, type Balance, type SpendDetail } from './credits'
import { HttpError, errorSummary, type Ctx } from './http'
import { recordUsage, type UsageRecord } from './usage'
import * as z from './zod'

/** The product of a call that names none, or a name that is not one. */
const UNKNOWN_PRODUCT = 'unknown'

/** The header in which an extension names itself, `notico/0.3.0`. Only the product is read. */
export const CLIENT_HEADER = 'x-cofun-client'

/** A product name: lowercase letters, never `unknown`. */
const ProductName = z
  .string()
  .regex(/^[a-z]{1,32}$/)
  .refine((name) => name !== UNKNOWN_PRODUCT)

/**
 * The product a call comes from, by CLIENT_HEADER, or `unknown` (Notico up to 0.2.0 sends none).
 * The client's own word: it only sorts what was spent, so a call is never refused over it.
 */
function productOf(header: string | undefined): string {
  return ProductName.safeParse(header?.split('/')[0]).data ?? UNKNOWN_PRODUCT
}

/** The headers naming the chat and the question a request is for: random ids, recorded with what it spent. */
export const CHAT_HEADER = 'x-cofun-chat-id'
export const TURN_HEADER = 'x-cofun-turn-id'

/** Which chat and question a request is for: null where it names none. */
export interface Turn {
  chatId: string | null
  turnId: string | null
}

const Id = z.uuid()

/**
 * The chat and question a request names. A header left out is null: builds before #466 send
 * neither (this can go once every store build sends both). One that is not a UUID is refused.
 */
function turnOf(c: Ctx): Turn {
  const read = (name: string) => {
    const value = c.req.header(name)
    if (value === undefined) return null
    const id = Id.safeParse(value)
    if (!id.success) throw new HttpError(400, 'bad_request', `${name} must be a UUID`)
    return id.data
  }
  return { chatId: read(CHAT_HEADER), turnId: read(TURN_HEADER) }
}

/**
 * The usage record of a request (sizes and counts only, never content), `record` to write it once,
 * and `turn` to read the request's chat and question into it: called where a refusal is recorded.
 */
export function startUsage(
  c: Ctx,
  model: string,
): { usage: UsageRecord; record: (outcome: string) => void; turn: () => Turn } {
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

/** A time as the out-of-credits message gives it: to the minute, in UTC, since the worker does not know the user's time zone. */
function utcMinute(ms: number): string {
  // Rounded up, so the time named is never before the credits arrive.
  const iso = new Date(Math.ceil(ms / 60_000) * 60_000).toISOString()
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`
}

/** Opens the ledger, or refuses with `credits_unavailable` when it can't be read. */
async function opened<T>(open: () => Promise<T>, logError: (line: string) => void): Promise<T> {
  try {
    return await open()
  } catch (err) {
    logError(`credit check failed: ${errorSummary(err)}`)
    throw new HttpError(503, 'credits_unavailable', 'Credits are unavailable, try again in a moment.')
  }
}

/**
 * Refuses with `out_of_credits` at a zero balance or one below `needs` (micro-credits, what the call
 * is estimated to cost before it is made).
 */
function refuseShortBalance({ balance, nextGrantAt }: Balance, needs: number): void {
  if (balance <= 0) {
    throw new HttpError(
      402,
      'out_of_credits',
      `You have no credits left. Your next ${FREE_CREDITS} free credits arrive on ${utcMinute(nextGrantAt)}, or you can buy credits.`,
    )
  }
  if (balance < needs) {
    // Rounded apart, so a balance just short never reads as enough.
    const needed = Math.ceil(needs / MICRO_CREDITS)
    const left = Math.floor(balance / MICRO_CREDITS)
    throw new HttpError(
      402,
      'out_of_credits',
      `This request needs about ${needed} credits and you have ${left} left. Start a new chat or shorten it, buy credits, or wait for your next ${FREE_CREDITS} free credits on ${utcMinute(nextGrantAt)}.`,
    )
  }
}

/**
 * The user's ledger, opened before a paid call that ends within the request (a render, a search),
 * which gives the weekly free grant if due. Refuses as `refuseShortBalance` says, and with
 * `credits_unavailable` when the ledger can't be read.
 */
export async function openLedger(c: Ctx, now: number, logError: (line: string) => void): Promise<Ledger> {
  const ledger = new Ledger(c.env.DB, c.get('userId'))
  refuseShortBalance(await opened(() => ledger.open(now), logError), 0)
  return ledger
}

/**
 * The user's ledger, opened before a model call, with the slot the call takes (see `openCall` in
 * credits.ts) until `until` at the latest. Refuses as `openLedger` does, and with `rate_limited`
 * when every slot is taken: the code a 429 for too many calls has always had, so every extension
 * version on the store stops the question and shows the message.
 */
export async function openCall(
  c: Ctx,
  now: number,
  logError: (line: string) => void,
  needs: number,
  until: number,
): Promise<{ ledger: Ledger; slot: number }> {
  const ledger = new Ledger(c.env.DB, c.get('userId'))
  const opening = await opened(() => ledger.openCall(now, needs, until), logError)
  if (opening.slot !== null) return { ledger, slot: opening.slot }
  refuseShortBalance(opening, needs)
  if (opening.taken >= CALL_SLOTS) {
    throw new HttpError(
      429,
      'rate_limited',
      `${CALL_SLOTS} answers are already being written. Wait for one to finish, then ask again.`,
    )
  }
  // The balance and the slots allowed the call, read in the batch that took none: not possible.
  throw new Error('no slot taken, for no reason the ledger gave')
}

/** Who pays for a call, and for which question; `what` names the call in the log. */
export interface Charging {
  ledger: Ledger
  usage: UsageRecord
  turn: Turn
  now: () => number
  logError: (line: string) => void
  what: string
}

/**
 * Records a call that ended as a spend of `cost`, failed ones too. Gives what was charged: 0 when
 * the record failed, which is logged, and what the call gave still goes out.
 */
export async function charge(
  { ledger, usage, turn, now, logError, what }: Charging,
  cost: number,
  detail: SpendDetail,
  at = now(),
): Promise<number> {
  try {
    await ledger.spend({ product: usage.product, ...turn, cost, at }, detail)
  } catch (err) {
    logError(`${what} record failed: ${errorSummary(err)}`)
    return 0
  }
  usage.microCredits = cost
  return cost
}

/**
 * Runs a call that gives its result at once (a render, a search) and charges what `work` says,
 * even if the client goes away meanwhile.
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
