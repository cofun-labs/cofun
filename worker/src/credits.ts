import type { SearchOutcome } from './search'
import type { RenderOutcome } from './web'
import * as z from './zod'

/**
 * Credits are money: 1 US dollar = 1000 credits. Every amount is an integer number of
 * micro-credits, so the cost of a single model call is exact; amounts are rounded only when shown.
 */
export const MICRO_CREDITS = 1_000_000

/** What every user gets free each week, and how long it lasts. */
export const FREE_CREDITS = 200
const FREE_GRANT = FREE_CREDITS * MICRO_CREDITS
export const FREE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** A value bound to a statement. */
type Value = string | number | null

/** The slice of a D1 prepared statement the ledger uses. Rows read back are checked, so they are `unknown` here. */
export interface Statement {
  bind(...values: Value[]): Statement
  all(): Promise<{ results: unknown[] }>
}

/**
 * The slice of the D1 binding the ledger uses. `batch` runs its statements as one transaction, one
 * batch at a time: what a batch reads, it reads as it is when the batch runs, with no other write in
 * between. Every change to the ledger is one batch, so requests that arrive together cannot both act
 * on the same state they read.
 */
export interface Database {
  prepare(query: string): Statement
  batch(statements: Statement[]): Promise<{ results: unknown[] }[]>
}

/**
 * Credits a user was given: how many, how many are left, and when they stop counting. Times are in
 * ms. A grant is never removed: once it has expired it counts for nothing, and stays as the record
 * of what the user was given, with `left` what went unspent.
 */
interface Grant {
  /** Where the credits came from: the weekly free grant, an admin who granted them by hand, or a purchase. */
  source: z.output<typeof GrantSource>
  amount: number
  left: number
  grantedAt: number
  /** When the grant stops counting: when it expires, or when its purchase was taken back if that came first. */
  expiresAt: number
  /** For a grant made by hand: the Clerk user id of the admin who made it. */
  by?: string
  /** For a purchase: the Stripe payment it came from. */
  payment?: string
  /** For a purchase that was taken back: why. It ended at `expiresAt`, and `left` is what was taken back. */
  revoked?: z.output<typeof Revoked>
}

/** Where a grant's credits came from, as `grants.source` holds it. */
export const GrantSource = z.enum(['free', 'manual', 'purchase'])

/** Why a purchase was taken back, as `grant_revocations.reason` holds it. */
export const Revoked = z.enum(['refund', 'dispute'])

/** A row of `grants` as the ledger reads it. */
const GrantRow = z
  .object({
    source: GrantSource,
    amount: z.int().min(0),
    left: z.int().min(0),
    granted_at: z.int(),
    expires_at: z.int(),
    granted_by: z.string().nullable(),
    payment: z.string().nullable(),
    revoked: Revoked.nullable(),
  })
  .transform((row): Grant => ({
    source: row.source,
    amount: row.amount,
    left: row.left,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    ...(row.granted_by === null ? {} : { by: row.granted_by }),
    ...(row.payment === null ? {} : { payment: row.payment }),
    ...(row.revoked === null ? {} : { revoked: row.revoked }),
  }))

const BalanceRow = z.object({ balance: z.int(), free_until: z.int().nullable() })
const SlotsRow = z.object({ taken: z.int().min(0) })
const SlotRow = z.object({ id: z.int() })
const UsageRow = z
  .object({ day: z.int(), micro_credits: z.int().min(0) })
  .transform((row) => ({ day: row.day, microCredits: row.micro_credits }))
const CountRow = z.object({ n: z.int().min(0) })

/** The one row a statement returns, checked against `schema`. */
function only<S extends z.ZodType>(schema: S, result: { results: unknown[] } | undefined): z.output<S> {
  const rows = result?.results ?? []
  if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`)
  return schema.parse(rows[0])
}

/** What a user can spend now, in micro-credits (never below zero), and when their next free grant can arrive. */
export interface Balance {
  balance: number
  nextGrantAt: number
}

/**
 * How many model calls one user can have going at once. Calls that start together all see the same
 * balance, and what they cost beyond it is forgiven, so this bounds that: at most this many calls
 * run on a balance that is about to run out.
 */
export const CALL_SLOTS = 3

/**
 * What `openCall` gives: the balance, as `open` does, how many slots were taken before this call,
 * and the slot this call took, or null when it was let in to none (see `openCall`).
 */
export interface CallOpening extends Balance {
  taken: number
  slot: number | null
}

/** Which days to total a user's spending over: the last `days` days, today included, of a clock `offsetMs` ahead of UTC. */
export interface UsagePeriod {
  days: number
  offsetMs: number
}

/** What a user spent on one day. `day` counts days since 1970-01-01 on the period's clock. */
interface DayUsage {
  day: number
  microCredits: number
}

/**
 * The moments a period spans. The one definition of a user's own day: a moment belongs to the day
 * `floor((moment + offsetMs) / a day)`, here and in READ_USAGE.
 */
function spanOf(now: number, { days, offsetMs }: UsagePeriod) {
  const last = Math.floor((now + offsetMs) / DAY_MS)
  const first = last - (days - 1)
  return { from: first * DAY_MS - offsetMs, to: (last + 1) * DAY_MS - offsetMs }
}

/**
 * How many grants a user's history holds at most, newest first: a bound on the read, far above what
 * an account gets (one free grant a week is 52 a year), so in practice the whole history.
 */
const HISTORY_LIMIT = 200

/**
 * A user's credits as they see them. Amounts are in micro-credits. Unlike an `Account`, it looks
 * ahead: for a user with no free grant that still counts, it says what their next call starts with.
 */
export interface Standing {
  /** What the user's next call starts with: exactly the balance `open` gives at the same moment. */
  balance: number
  /**
   * The weekly free grant. One that still counts ends at `until`, and the next one can arrive from
   * then on. With none, the next call brings one: `toCome` is what it adds to spend, and it is
   * already part of `balance`. Nothing is written until that call.
   */
  free: { started: true; until: number } | { started: false; toCome: number }
  /** The grants that still count, in the order they are spent. */
  grants: Grant[]
  /** What the user spent per day, newest first; days that cost nothing are left out. */
  usage: DayUsage[]
}

/** A user's account at one moment. Amounts are in micro-credits. */
export interface Account {
  /** What the user can spend: what is left of the grants that have not expired. */
  balance: number
  /** Every grant the user was given, oldest first, the expired ones included. */
  grants: Grant[]
}

/** Credits bought: how many micro-credits, until when, and the Stripe payment they were bought with. */
export interface Purchase {
  amount: number
  expiresAt: number
  payment: string
}

/** Credits granted by hand: how many micro-credits, until when, and the Clerk user id of the admin granting them. */
export interface ManualGrant {
  amount: number
  expiresAt: number
  by: string
}

/**
 * A spend of credits, to record with what it cost: the product it came from (see `productOf` in
 * charge.ts), the chat and question it was for (see `turnOf` in charge.ts; null when the request named
 * none), its cost in micro-credits (0 when it cost nothing), and when it was charged.
 */
export interface Spend {
  product: string
  chatId: string | null
  turnId: string | null
  cost: number
  at: number
}

/**
 * A model call that ended: when it started (it ended when its spend was charged), how it ended, and
 * its tokens (`estimated` when the call was cut short before the model reported them).
 */
interface ModelCall {
  kind: 'model_call'
  model: string
  startedAt: number
  stream: boolean
  outcome: string
  finishReason: string
  promptTokens: number
  cachedTokens: number
  completionTokens: number
  estimated: boolean
  /** The slot the call took (see `openCall`): written with it, which frees the slot. */
  slotId: number | null
}

/**
 * A page rendered in Browser Run, however it ended, and the browser time Browser Run reported for it,
 * which is what it bills: 0 when it reported none. (Rows written before #494 hold the time the
 * render took when Browser Run reported none, as migration 0006 says.) A render that gave a page is
 * charged by that time; one that did not costs the user nothing.
 */
interface WebRender {
  kind: 'web_render'
  outcome: RenderOutcome
  browserMs: number
}

/** A web search sent to the provider, however it ended, and how many results went back. Never the query. */
interface WebSearch {
  kind: 'web_search'
  outcome: SearchOutcome
  results: number
}

/** What is particular to a spend, by its kind: the row of the kind's own table. */
export type SpendDetail = ModelCall | WebRender | WebSearch

// How the tables hold a ledger (worker/migrations/0005_spends.sql): a grant is written once, and
// every spend is a row of `spends`, with what it took from each grant in `spend_grants`. What is
// left of a grant and a balance are worked out from those rows each time: nothing is stored twice.
// A user never owes anything: a spend takes what it costs from what is left, and no more, so the
// balance never goes below zero. In every statement below, ?1 is the user id and ?2 the time.

/** What was spent from the grant `grant` (SQL: a column of an outer query), read from `spend_grants_by_grant` alone. */
const spentFrom = (grant: string) =>
  `coalesce((SELECT sum(micro_credits) FROM spend_grants WHERE grant_id = ${grant}), 0)`

/**
 * Whether the grant `g` of the user `user` counts at the time `now`, as SQL: it has not expired,
 * and its purchase was not taken back by then. The one definition of a grant that counts.
 */
const counts = (user: string, now: string) => `g.user_id = ${user} AND g.expires_at > ${now}
  AND NOT EXISTS (SELECT 1 FROM grant_revocations WHERE grant_id = g.id AND created_at <= ${now})`

/**
 * What a user can spend at the time `now`, as SQL: what is left of the grants that still count.
 * The one definition of a balance in SQL, for one user (below) and for a list of them
 * (overview.ts). `user` and `now` are SQL: parameters, or columns of an outer query.
 */
export const balanceOf = (user: string, now: string) =>
  `(SELECT coalesce(sum(g.amount - ${spentFrom('g.id')}), 0) FROM grants g WHERE ${counts(user, now)})`

/**
 * A grant as the ledger reads it, with what its own tables add: what is left of it, the admin who
 * made it by hand, the payment it was bought with, and why it was taken back. A purchase taken back
 * ends when it was taken back, if that came before it expired; what was left of it then is what was
 * taken back, and nothing is spent from it after.
 */
const READ_GRANT = `SELECT g.source, g.amount, g.amount - ${spentFrom('g.id')} AS left, g.granted_at,
  CASE WHEN r.created_at < g.expires_at THEN r.created_at ELSE g.expires_at END AS expires_at,
  m.granted_by, p.payment, r.reason AS revoked
FROM grants g
LEFT JOIN manual_grants m ON m.grant_id = g.id
LEFT JOIN purchases p ON p.grant_id = g.id
LEFT JOIN grant_revocations r ON r.grant_id = g.id`

/**
 * The weekly free grant, given lazily when a user shows up and has no free grant that still counts:
 * no schedule runs, nothing is written for users who don't come back, and a user who returns after
 * a month gets one grant, not four. A free grant with nothing left still marks the user's week.
 * Only free grants are looked at: credits granted by hand never stand in for the free week. It is
 * one statement, so two requests arriving together cannot both grant the week. ?3 is the amount, ?4
 * how long it lasts.
 */
const GIVE_FREE_GRANT = `INSERT INTO grants (user_id, source, amount, granted_at, expires_at)
SELECT ?1, 'free', ?3, ?2, ?2 + ?4
WHERE NOT EXISTS (SELECT 1 FROM grants WHERE user_id = ?1 AND source = 'free' AND expires_at > ?2)`

/** A grant by hand. ?3 is the amount, ?4 when it expires. */
const GIVE_MANUAL_GRANT = `INSERT INTO grants (user_id, source, amount, granted_at, expires_at)
VALUES (?1, 'manual', ?3, ?2, ?4)`

/**
 * Who made the grant just written, in the same batch: the newest grant, ?1 the admin's user id.
 * Batches run one at a time, so no other grant is written in between.
 */
const RECORD_MANUAL_GRANT = `INSERT INTO manual_grants (grant_id, granted_by)
VALUES ((SELECT max(id) FROM grants), ?1)`

/**
 * Credits bought. ?3 is the amount, ?4 when it expires, ?5 the payment. A payment grants once: a
 * payment that has a purchase already writes nothing, so a payment Stripe reports twice, or two
 * reports handled at once, add one grant.
 */
const GIVE_PURCHASE = `INSERT INTO grants (user_id, source, amount, granted_at, expires_at)
SELECT ?1, 'purchase', ?3, ?2, ?4
WHERE NOT EXISTS (SELECT 1 FROM purchases WHERE payment = ?5)`

/** The payment ?1 of the grant GIVE_PURCHASE just wrote, the newest one; nothing when it wrote none. */
const RECORD_PURCHASE = `INSERT INTO purchases (grant_id, payment)
SELECT (SELECT max(id) FROM grants), ?1
WHERE NOT EXISTS (SELECT 1 FROM purchases WHERE payment = ?1)`

/**
 * Takes back the purchase made with the payment ?1, for the reason ?3, at the time ?2: from then on
 * its grant counts for nothing. A purchase taken back once is not taken back again, so a second
 * report changes nothing and the first reason stays.
 */
const TAKE_BACK = `INSERT INTO grant_revocations (grant_id, reason, created_at)
SELECT grant_id, ?3, ?2 FROM purchases WHERE payment = ?1
ON CONFLICT (grant_id) DO NOTHING`

/** How many grants the payment ?1 made: one, or none when it was not granted (yet). */
const COUNT_PAYMENT = `SELECT count(*) AS n FROM purchases WHERE payment = ?1`

/**
 * What the user's next call starts with, and until when their free week runs (null when no free
 * grant still counts). With a free grant that counts, the balance is what is left of the grants
 * that still count. With none, it is that plus the free grant ?3 the next call brings. `open` reads
 * this right after giving the grant and `look` reads it without, so what a user is shown and what
 * their next call gets are one definition.
 */
const READ_BALANCE = `SELECT stored + CASE WHEN free_until IS NULL THEN ?3 ELSE 0 END AS balance, free_until
FROM (SELECT
  ${balanceOf('?1', '?2')} AS stored,
  (SELECT max(expires_at) FROM grants WHERE user_id = ?1 AND source = 'free' AND expires_at > ?2) AS free_until)`

/**
 * How many of the user's slots are taken at the time ?2: those that have not expired and whose call
 * was not charged yet. The one definition of a slot that is taken.
 */
const takenSlots = `(SELECT count(*) FROM call_slots s WHERE s.user_id = ?1 AND s.expires_at > ?2
  AND NOT EXISTS (SELECT 1 FROM model_calls m WHERE m.slot_id = s.id))`

const READ_TAKEN_SLOTS = `SELECT ${takenSlots} AS taken`

/**
 * Takes a slot for a model call starting at ?2, until ?3 at the latest, if the call may start: the
 * balance is above zero and at least ?4 (what the call is estimated to cost before it is made; amounts
 * are whole micro-credits, so `max(?4, 1)` says both), and fewer than ?5 slots are taken. Gives the
 * slot's id, or no row when it took none. One statement, in the batch that reads the balance, so calls
 * that start together cannot all take the last slot. The same rule as `refuseShortBalance` in
 * charge.ts, which says why a call was refused: the two change together.
 */
const TAKE_SLOT = `INSERT INTO call_slots (user_id, started_at, expires_at)
SELECT ?1, ?2, ?3
WHERE ${balanceOf('?1', '?2')} >= max(?4, 1) AND ${takenSlots} < ?5
RETURNING id`

/** The grants that still count, in the order they are spent. */
const READ_CURRENT_GRANTS = `${READ_GRANT}
WHERE ${counts('?1', '?2')} ORDER BY g.expires_at, g.id`

/**
 * What the user spent per day from ?2 up to ?3, newest first. A spend belongs to the day it was
 * charged on, on a clock ?4 ms ahead of UTC. Totalled from the spends themselves each time (the
 * `spends_by_user` index bounds it to the period): no totals are stored. The cast keeps the day a
 * whole number however the database binds ?4.
 */
const READ_USAGE = `SELECT CAST((created_at + ?4) / ${DAY_MS} AS INTEGER) AS day, sum(micro_credits) AS micro_credits
FROM spends WHERE user_id = ?1 AND created_at >= ?2 AND created_at < ?3
GROUP BY day HAVING sum(micro_credits) > 0 ORDER BY day DESC`

/**
 * The user's grants, newest first, up to HISTORY_LIMIT of them. The `grants_by_user_granted` index
 * gives them in this order, so the read stops at the limit.
 */
const READ_HISTORY = `${READ_GRANT}
WHERE g.user_id = ?1 ORDER BY g.granted_at DESC, g.id DESC LIMIT ${HISTORY_LIMIT}`

const READ_GRANTS = `${READ_GRANT}
WHERE g.user_id = ?1 ORDER BY g.granted_at, g.id`

/**
 * The record of a spend, with its full cost. ?3 is the product, ?4 the kind, ?5 the cost, ?6 and ?7
 * the chat and the question it was for.
 */
const RECORD_SPEND = `INSERT INTO spends (user_id, created_at, product, kind, micro_credits, chat_id, turn_id)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`

/**
 * The model call of the spend just written, in the same batch: the newest spend. Batches run one at
 * a time, so no other spend is written in between. ?1 is the model, ?2 when the call started, ?3
 * whether it streamed, ?4 its outcome, ?5 its finish reason, ?6 to ?8 the prompt, cached, and
 * completion tokens, ?9 whether they are estimated, ?10 the slot it took.
 */
const RECORD_MODEL_CALL = `INSERT INTO model_calls (spend_id, model, started_at, stream, outcome, finish_reason,
  prompt_tokens, cached_tokens, completion_tokens, estimated, slot_id)
VALUES ((SELECT max(id) FROM spends), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`

/** The render of the spend just written, in the same batch, as RECORD_MODEL_CALL. ?1 is its outcome, ?2 its browser time. */
const RECORD_WEB_RENDER = `INSERT INTO web_renders (spend_id, outcome, browser_ms)
VALUES ((SELECT max(id) FROM spends), ?1, ?2)`

/** The search of the spend just written, in the same batch, as RECORD_MODEL_CALL. ?1 is its outcome, ?2 how many results it gave. */
const RECORD_WEB_SEARCH = `INSERT INTO web_searches (spend_id, outcome, results)
VALUES ((SELECT max(id) FROM spends), ?1, ?2)`

/** Whether every value is a non-negative whole number, as a spend's amounts, times, and counts must be. */
const wholeNumbers = (...values: number[]) => values.every((n) => Number.isSafeInteger(n) && n >= 0)

/**
 * Takes the cost ?3 of the spend just written (the newest) from the grants that still count, from
 * the one that expires first: each gives what the grants before it did not cover, up to what it has
 * left, as a row of `spend_grants`. What they all have left does not cover is forgiven: nothing goes
 * below zero. What is left is read in the same batch, so spends that end together each take their
 * own cost and none is lost.
 */
const SPEND = `INSERT INTO spend_grants (spend_id, grant_id, micro_credits)
SELECT (SELECT max(id) FROM spends), id, min(left, ?3 - before)
FROM (
  SELECT id, left,
    coalesce(sum(left) OVER (ORDER BY expires_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
  FROM (SELECT g.id, g.expires_at, g.amount - ${spentFrom('g.id')} AS left FROM grants g WHERE ${counts('?1', '?2')})
  WHERE left > 0
)
WHERE before < ?3`

/** One user's credits, over the database. Callers pass the time, in ms, so every decision uses the request's own clock. */
export class Ledger {
  constructor(
    private readonly db: Database,
    private readonly userId: string,
  ) {}

  /**
   * What the user can spend before a paid call that is charged as soon as it ends (a render, a
   * search), after giving them the weekly free grant if they have none. A call may go ahead while the
   * balance is above zero; calls that start together all see the same balance, and what they cost
   * beyond it is forgiven. A model call opens with `openCall`, which also takes a slot.
   */
  async open(now: number): Promise<Balance> {
    const [, balance] = await this.db.batch([
      this.statement(GIVE_FREE_GRANT, now, FREE_GRANT, FREE_PERIOD_MS),
      this.statement(READ_BALANCE, now, FREE_GRANT),
    ])
    const row = only(BalanceRow, balance)
    // The batch has just made sure there is a free grant.
    if (row.free_until === null) throw new Error('no free grant after granting one')
    return { balance: row.balance, nextGrantAt: row.free_until }
  }

  /**
   * What the user can spend before a model call, as `open` gives it, and a slot for the call
   * (CALL_SLOTS), taken when the call may start: the balance is above zero and at least `needs`, and
   * a slot is free. The slot counts as taken until the call's spend names it, or until `until` if
   * none ever does. When `slot` is null, nothing was taken, and the balance and `taken` say why.
   */
  async openCall(now: number, needs: number, until: number): Promise<CallOpening> {
    if (!wholeNumbers(needs, now) || until <= now) throw new Error('a slot needs a time to expire after it starts')
    const [, balance, taken, slot] = await this.db.batch([
      this.statement(GIVE_FREE_GRANT, now, FREE_GRANT, FREE_PERIOD_MS),
      this.statement(READ_BALANCE, now, FREE_GRANT),
      this.statement(READ_TAKEN_SLOTS, now),
      this.statement(TAKE_SLOT, now, until, needs, CALL_SLOTS),
    ])
    const row = only(BalanceRow, balance)
    if (row.free_until === null) throw new Error('no free grant after granting one')
    const slots = z.array(SlotRow).parse(slot?.results ?? [])
    return {
      balance: row.balance,
      nextGrantAt: row.free_until,
      taken: only(SlotsRow, taken).taken,
      slot: slots[0]?.id ?? null,
    }
  }

  /**
   * The user's credits as they see them: what their next call starts with, the grants that still
   * count, and what they spent per day over `period`. Looking changes nothing: it never gives the
   * weekly free grant, so it does not start the user's week.
   */
  async look(now: number, period: UsagePeriod): Promise<Standing> {
    const { from, to } = spanOf(now, period)
    const [balanceRow, grantRows, usageRows] = await this.db.batch([
      this.statement(READ_BALANCE, now, FREE_GRANT),
      this.statement(READ_CURRENT_GRANTS, now),
      this.statement(READ_USAGE, from, to, period.offsetMs),
    ])
    const { balance, free_until: until } = only(BalanceRow, balanceRow)
    const grants = z.array(GrantRow).parse(grantRows?.results ?? [])
    const left = grants.reduce((sum, grant) => sum + grant.left, 0)
    return {
      balance,
      // Without a free grant, what the balance holds beyond the grants is what the next one adds.
      free: until === null ? { started: false, toCome: balance - left } : { started: true, until },
      grants,
      usage: z.array(UsageRow).parse(usageRows?.results ?? []),
    }
  }

  /**
   * Every grant the user was given, newest first, the expired ones included, up to HISTORY_LIMIT of
   * them. Reading changes nothing.
   */
  async history(): Promise<Grant[]> {
    const { results } = await this.statement(READ_HISTORY).all()
    return z.array(GrantRow).parse(results)
  }

  /**
   * Records a spend and what is particular to it, and takes what it cost from the user, from the
   * grant that expires first, in one batch: all of it is written, or none. What the grants don't
   * cover is forgiven. The one way credits are spent.
   */
  async spend({ product, chatId, turnId, cost, at }: Spend, detail: SpendDetail): Promise<void> {
    if (!wholeNumbers(cost, at)) throw new Error('a spend needs non-negative integers')
    const statements = [
      this.statement(RECORD_SPEND, at, product, detail.kind, cost, chatId, turnId),
      this.detail(detail, at),
    ]
    await this.db.batch(cost === 0 ? statements : [...statements, this.statement(SPEND, at, cost)])
  }

  /** The row of a spend's own kind, for the spend charged at the time `at`. */
  private detail(detail: SpendDetail, at: number): Statement {
    switch (detail.kind) {
      case 'model_call': {
        const { promptTokens, cachedTokens, completionTokens, startedAt } = detail
        if (!wholeNumbers(promptTokens, cachedTokens, completionTokens, startedAt))
          throw new Error('a spend needs non-negative integers')
        if (startedAt > at) throw new Error('a model call must start before it is charged')
        return this.db
          .prepare(RECORD_MODEL_CALL)
          .bind(
            detail.model,
            startedAt,
            detail.stream ? 1 : 0,
            detail.outcome,
            detail.finishReason,
            promptTokens,
            cachedTokens,
            completionTokens,
            detail.estimated ? 1 : 0,
            detail.slotId,
          )
      }
      case 'web_render':
        if (!wholeNumbers(detail.browserMs)) throw new Error('a spend needs non-negative integers')
        return this.db.prepare(RECORD_WEB_RENDER).bind(detail.outcome, detail.browserMs)
      case 'web_search':
        if (!wholeNumbers(detail.results)) throw new Error('a spend needs non-negative integers')
        return this.db.prepare(RECORD_WEB_SEARCH).bind(detail.outcome, detail.results)
    }
  }

  /**
   * The account as it stands. Reading changes nothing: in particular it does not give the user
   * their weekly free grant, which waits for the user's own next call.
   */
  async read(now: number): Promise<Account> {
    return this.account(now, await this.db.batch(this.reads()))
  }

  /**
   * Grants credits by hand, beside the weekly free grant. It does not give the user their weekly
   * free grant: that still starts with their own next call, so a grant by hand never uses up part
   * of a user's free week.
   */
  async grant(now: number, { amount, expiresAt, by }: ManualGrant): Promise<Account> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('a grant must be a positive integer')
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('a grant must expire after it is made')
    const [, , ...reads] = await this.db.batch([
      this.statement(GIVE_MANUAL_GRANT, now, amount, expiresAt),
      this.db.prepare(RECORD_MANUAL_GRANT).bind(by),
      ...this.reads(),
    ])
    return this.account(now, reads)
  }

  /**
   * Adds credits bought with a payment, beside the other grants. A payment that was granted already
   * adds nothing, and is not an error: Stripe reports a payment more than once. Says which it was.
   */
  async purchase(now: number, { amount, expiresAt, payment }: Purchase): Promise<'granted' | 'granted already'> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('a grant must be a positive integer')
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('a grant must expire after it is made')
    const [before] = await this.db.batch([
      this.db.prepare(COUNT_PAYMENT).bind(payment),
      this.statement(GIVE_PURCHASE, now, amount, expiresAt, payment),
      this.db.prepare(RECORD_PURCHASE).bind(payment),
    ])
    return only(CountRow, before).n === 0 ? 'granted' : 'granted already'
  }

  private reads(): Statement[] {
    return [this.statement(READ_GRANTS)]
  }

  private account(now: number, [grantRows]: { results: unknown[] }[]): Account {
    const grants = z.array(GrantRow).parse(grantRows?.results ?? [])
    const balance = grants.reduce((sum, grant) => sum + (grant.expiresAt > now ? grant.left : 0), 0)
    return { balance, grants }
  }

  /** A statement for this user: ?1 is the user id, and the values after it ?2, ?3, …. */
  private statement(query: string, ...values: Value[]): Statement {
    return this.db.prepare(query).bind(this.userId, ...values)
  }
}

/** How many of the payment ?1's purchases have not been taken back. */
const COUNT_KEPT = `SELECT count(*) AS n FROM purchases p
WHERE p.payment = ?1 AND NOT EXISTS (SELECT 1 FROM grant_revocations WHERE grant_id = p.grant_id)`

/**
 * Takes back what is left of the purchase made with `payment`, after a refund or a dispute: see
 * TAKE_BACK. What was spent stays spent, and the user's other grants are untouched. Says what it
 * found: a purchase it took back now, one taken back already (nothing changes), or no grant (nothing
 * changes either: nothing is recorded, so a grant the payment makes later stays).
 */
export async function takeBack(
  db: Database,
  now: number,
  payment: string,
  why: z.output<typeof Revoked>,
): Promise<'taken back' | 'taken back already' | 'no grant'> {
  const [kept, , count] = await db.batch([
    db.prepare(COUNT_KEPT).bind(payment),
    db.prepare(TAKE_BACK).bind(payment, now, why),
    db.prepare(COUNT_PAYMENT).bind(payment),
  ])
  if (only(CountRow, count).n === 0) return 'no grant'
  return only(CountRow, kept).n > 0 ? 'taken back' : 'taken back already'
}
