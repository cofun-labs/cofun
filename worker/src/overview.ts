/**
 * Credits as a whole, for the admin page: what was granted and spent over a period across every
 * account, per day, and the accounts of the period. Read-only, and worked out from the `grants` and
 * `model_calls` rows each time: no totals are stored.
 *
 * D1 runs one query at a time, so a slow query here would hold up charging. Every query is
 * therefore bounded by the period and reads only the period's rows, through the tables' time
 * indexes: the callers bound how long a period can be and how many accounts are listed, and the
 * queries name their index (`INDEXED BY`), so SQLite cannot pick a plan that scans a whole table.
 */
import { balanceOf, GrantSource, type Database } from './credits'
import * as z from './zod'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A period of whole days: from `from` up to, not including, `to`, both in ms. The days are those of
 * a clock `utcOffset` minutes ahead of UTC (behind it when negative), so `from` and `to` are
 * midnights on that clock. The offset is one number for the whole period: where clocks change
 * during the period, the days on the far side of the change start an hour off.
 */
export interface Period {
  from: number
  to: number
  utcOffset: number
}

/** Grants and model calls over some time. Amounts are in micro-credits. */
interface Totals {
  /** Credits granted, by where they came from. A grant counts when it was made. */
  granted: Record<z.output<typeof GrantSource>, number>
  /** What model calls cost. A call, with all it cost, counts when it started. */
  spent: number
  /** Calls made to the model, however they ended. */
  calls: number
  /** The calls that did not end well, whatever the reason: every outcome but `ok`. */
  failedCalls: number
  /** The failed calls the user stopped (the outcome `cancelled`). */
  cancelledCalls: number
  promptTokens: number
  /** The part of the prompt tokens the model read from its cache. */
  cachedTokens: number
  completionTokens: number
}

/** What one product's model calls cost in a period. Amounts are in micro-credits. */
interface ProductSpending {
  /** `notico`, another extension's name, or `unknown` for a caller that is no listed extension. */
  product: string
  spent: number
  calls: number
}

export interface Overview {
  totals: Totals
  /** The period's spending by the product the calls came from, the one that spent the most first. */
  products: ProductSpending[]
  /** Every day of the period, oldest first, the days when nothing happened included. `day` is YYYY-MM-DD. */
  days: ({ day: string } & Totals)[]
}

/** An account in a period: what it was granted and spent in the period, and what it can spend now. */
interface AccountSummary {
  userId: string
  granted: number
  spent: number
  calls: number
  balance: number
}

export interface Accounts {
  /** The accounts that spent the most in the period, first; then by what they were granted. */
  accounts: AccountSummary[]
  /** Whether the period has more accounts than the list shows. */
  more: boolean
}

// In every statement below ?1 is the start of the period and ?2 its end. A row's day is the number
// of whole days since the epoch on the period's clock; ?3 is the clock's offset in ms (cast, so the
// division is a whole number whatever type the binding gives a number).

const GRANTED_PER_DAY = `SELECT (granted_at + CAST(?3 AS INTEGER)) / ${DAY_MS} AS day, source, sum(amount) AS amount
FROM grants INDEXED BY grants_by_time
WHERE granted_at >= ?1 AND granted_at < ?2
GROUP BY day, source`

const CALLS_PER_DAY = `SELECT (started_at + CAST(?3 AS INTEGER)) / ${DAY_MS} AS day, count(*) AS calls,
  sum(outcome <> 'ok') AS failed_calls, sum(outcome = 'cancelled') AS cancelled_calls,
  sum(micro_credits) AS spent,
  sum(prompt_tokens) AS prompt_tokens, sum(cached_tokens) AS cached_tokens,
  sum(completion_tokens) AS completion_tokens
FROM model_calls INDEXED BY model_calls_by_time
WHERE started_at >= ?1 AND started_at < ?2
GROUP BY day`

const SPENT_PER_PRODUCT = `SELECT product, sum(micro_credits) AS spent, count(*) AS calls
FROM model_calls INDEXED BY model_calls_by_time
WHERE started_at >= ?1 AND started_at < ?2
GROUP BY product
ORDER BY spent DESC, calls DESC, product`

/**
 * The accounts with a grant or a model call in the period, the biggest spenders first, at most ?4
 * of them. The balance is read only for those, each through the indexes by user. ?3 is now.
 */
const ACCOUNTS = `WITH
granted AS (
  SELECT user_id, sum(amount) AS granted FROM grants INDEXED BY grants_by_time
  WHERE granted_at >= ?1 AND granted_at < ?2 GROUP BY user_id
),
spent AS (
  SELECT user_id, sum(micro_credits) AS spent, count(*) AS calls FROM model_calls INDEXED BY model_calls_by_time
  WHERE started_at >= ?1 AND started_at < ?2 GROUP BY user_id
),
top AS (
  SELECT user_id, sum(granted) AS granted, sum(spent) AS spent, sum(calls) AS calls
  FROM (
    SELECT user_id, granted, 0 AS spent, 0 AS calls FROM granted
    UNION ALL
    SELECT user_id, 0, spent, calls FROM spent
  )
  GROUP BY user_id
  ORDER BY spent DESC, granted DESC, user_id
  LIMIT ?4
)
SELECT user_id, granted, spent, calls, ${balanceOf('top.user_id', '?3')} AS balance
FROM top
ORDER BY spent DESC, granted DESC, user_id`

const count = z.int().min(0)
const GrantedRow = z.object({ day: z.int(), source: GrantSource, amount: count })
const CallsRow = z.object({
  day: z.int(),
  calls: count,
  failed_calls: count,
  cancelled_calls: count,
  spent: count,
  prompt_tokens: count,
  cached_tokens: count,
  completion_tokens: count,
})
const ProductRow = z.object({ product: z.string(), spent: count, calls: count })
const AccountRow = z
  .object({ user_id: z.string(), granted: count, spent: count, calls: count, balance: z.int() })
  .transform((row): AccountSummary => ({
    userId: row.user_id,
    granted: row.granted,
    spent: row.spent,
    calls: row.calls,
    balance: row.balance,
  }))

const nothing = (): Totals => ({
  granted: { free: 0, manual: 0, purchase: 0 },
  spent: 0,
  calls: 0,
  failedCalls: 0,
  cancelledCalls: 0,
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
})

/** Adds `more` to `totals`. */
function add(totals: Totals, more: Totals): void {
  for (const source of GrantSource.options) totals.granted[source] += more.granted[source]
  totals.spent += more.spent
  totals.calls += more.calls
  totals.failedCalls += more.failedCalls
  totals.cancelledCalls += more.cancelledCalls
  totals.promptTokens += more.promptTokens
  totals.cachedTokens += more.cachedTokens
  totals.completionTokens += more.completionTokens
}

/** What was granted and spent in the period, for each of its days, by product, and in all. Both tables are read at one moment. */
export async function readOverview(db: Database, { from, to, utcOffset }: Period): Promise<Overview> {
  const offsetMs = utcOffset * 60_000
  const [grantedRows, callsRows, productRows] = await db.batch([
    db.prepare(GRANTED_PER_DAY).bind(from, to, offsetMs),
    db.prepare(CALLS_PER_DAY).bind(from, to, offsetMs),
    db.prepare(SPENT_PER_PRODUCT).bind(from, to),
  ])
  // The period's days, by their number on the period's clock: `from` is a midnight on it.
  const first = (from + offsetMs) / DAY_MS
  const days = new Map<number, Totals>()
  for (let day = first; day < first + (to - from) / DAY_MS; day++) days.set(day, nothing())
  const at = (day: number): Totals => {
    const totals = days.get(day)
    if (!totals) throw new Error('a row outside the period')
    return totals
  }
  for (const row of z.array(GrantedRow).parse(grantedRows?.results ?? [])) at(row.day).granted[row.source] += row.amount
  for (const row of z.array(CallsRow).parse(callsRows?.results ?? [])) {
    const totals = at(row.day)
    totals.spent = row.spent
    totals.calls = row.calls
    totals.failedCalls = row.failed_calls
    totals.cancelledCalls = row.cancelled_calls
    totals.promptTokens = row.prompt_tokens
    totals.cachedTokens = row.cached_tokens
    totals.completionTokens = row.completion_tokens
  }
  // The totals are the sum of the days, so the two cannot disagree.
  const totals = nothing()
  for (const day of days.values()) add(totals, day)
  return {
    totals,
    products: z.array(ProductRow).parse(productRows?.results ?? []),
    days: [...days].map(([day, of]) => ({ day: new Date(day * DAY_MS).toISOString().slice(0, 10), ...of })),
  }
}

/** The period's accounts, at most `limit` of them, with what each can spend at the time `now`. */
export async function readAccounts(db: Database, { from, to }: Period, now: number, limit: number): Promise<Accounts> {
  // One more than the limit, to know whether there are more.
  const { results } = await db
    .prepare(ACCOUNTS)
    .bind(from, to, now, limit + 1)
    .all()
  const accounts = z.array(AccountRow).parse(results)
  return { accounts: accounts.slice(0, limit), more: accounts.length > limit }
}
