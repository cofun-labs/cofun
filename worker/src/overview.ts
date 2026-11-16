/**
 * Credits as a whole, for the admin page: what was granted and spent over a period across every
 * account, per day, and the accounts of the period. Read-only, and worked out from the `grants`,
 * `spends`, `spend_grants`, `model_calls`, `web_renders`, and `web_searches` rows each time: no
 * totals are stored.
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

/** Grants, spends, model calls, renders, and searches over some time. Amounts are in micro-credits. */
interface Totals {
  /** Credits granted, by where they came from. A grant counts when it was made. */
  granted: Record<z.output<typeof GrantSource>, number>
  /** What was spent, on anything. A spend, with all it cost, counts when it was charged. */
  spent: number
  /**
   * The part of `spent` no grant covered, so it was forgiven: what a spend cost beyond what was left
   * when it was charged, as when requests sent at once together cost more than the balance.
   */
  forgiven: number
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
  /** Pages rendered in Browser Run, however they ended. */
  renders: number
  /** The renders that gave no page: every outcome but `ok` (`no_text`, `render_failed`). */
  failedRenders: number
  /** The browser time the renders used, in ms: what Browser Run bills. */
  renderMs: number
  /** What the renders cost, a part of `spent`. */
  renderSpent: number
  /** Web searches sent to the provider, however they ended. */
  searches: number
  /** The searches that gave no results: every outcome but `ok`. */
  failedSearches: number
  /** What the searches cost, a part of `spent`. */
  searchSpent: number
}

/** What one product spent in a period, the model calls it made, the pages it had rendered, and the searches it made. Amounts are in micro-credits. */
interface ProductSpending {
  /** `notico`, another extension's name, or `unknown` for a caller that is no listed extension. */
  product: string
  spent: number
  calls: number
  renders: number
  /** What the renders cost, a part of `spent`. */
  renderSpent: number
  searches: number
  /** What the searches cost, a part of `spent`. */
  searchSpent: number
}

export interface Overview {
  totals: Totals
  /** The period's spending by the product it came from, the one that spent the most first. */
  products: ProductSpending[]
  /** Every day of the period, oldest first, the days when nothing happened included. `day` is YYYY-MM-DD. */
  days: ({ day: string } & Totals)[]
}

/** An account in a period: what it was granted and spent in the period, and what it can spend now. */
interface AccountSummary {
  userId: string
  granted: number
  spent: number
  /** The part of `spent` no grant covered, so it was forgiven. */
  forgiven: number
  calls: number
  renders: number
  /** What the account's renders cost, a part of `spent`. */
  renderSpent: number
  searches: number
  /** What the account's searches cost, a part of `spent`. */
  searchSpent: number
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

/** What the renders among a group of spends `s`, joined to their `web_renders` rows `r`, cost (SQL). */
const renderSpent = 'coalesce(sum(CASE WHEN r.id IS NOT NULL THEN s.micro_credits END), 0)'
/** What the searches among a group of spends `s`, joined to their `web_searches` rows `w`, cost (SQL). */
const searchSpent = 'coalesce(sum(CASE WHEN w.id IS NOT NULL THEN s.micro_credits END), 0)'
/**
 * What no grant covered of a group of spends `s` (SQL): each spend's cost less what it took from
 * the grants, read through `spend_grants`' index of its unique (spend_id, grant_id).
 */
const forgiven =
  'coalesce(sum(s.micro_credits - coalesce((SELECT sum(sg.micro_credits) FROM spend_grants sg WHERE sg.spend_id = s.id), 0)), 0)'

const GRANTED_PER_DAY = `SELECT (granted_at + CAST(?3 AS INTEGER)) / ${DAY_MS} AS day, source, sum(amount) AS amount
FROM grants INDEXED BY grants_by_time
WHERE granted_at >= ?1 AND granted_at < ?2
GROUP BY day, source`

/**
 * What was spent per day, and the model calls, the renders, and the searches among the spends, each
 * joined through its spend (a spend has one detail row, of its kind): each counts on the day it was
 * charged, as what it cost does.
 */
const SPENT_PER_DAY = `SELECT (s.created_at + CAST(?3 AS INTEGER)) / ${DAY_MS} AS day, sum(s.micro_credits) AS spent,
  ${forgiven} AS forgiven, count(m.id) AS calls,
  coalesce(sum(m.outcome <> 'ok'), 0) AS failed_calls, coalesce(sum(m.outcome = 'cancelled'), 0) AS cancelled_calls,
  coalesce(sum(m.prompt_tokens), 0) AS prompt_tokens, coalesce(sum(m.cached_tokens), 0) AS cached_tokens,
  coalesce(sum(m.completion_tokens), 0) AS completion_tokens,
  count(r.id) AS renders, coalesce(sum(r.outcome <> 'ok'), 0) AS failed_renders,
  coalesce(sum(r.browser_ms), 0) AS render_ms, ${renderSpent} AS render_spent,
  count(w.id) AS searches, coalesce(sum(w.outcome <> 'ok'), 0) AS failed_searches, ${searchSpent} AS search_spent
FROM spends s INDEXED BY spends_by_time
LEFT JOIN model_calls m ON m.spend_id = s.id
LEFT JOIN web_renders r ON r.spend_id = s.id
LEFT JOIN web_searches w ON w.spend_id = s.id
WHERE s.created_at >= ?1 AND s.created_at < ?2
GROUP BY day`

const SPENT_PER_PRODUCT = `SELECT s.product, sum(s.micro_credits) AS spent, count(m.id) AS calls,
  count(r.id) AS renders, ${renderSpent} AS render_spent, count(w.id) AS searches, ${searchSpent} AS search_spent
FROM spends s INDEXED BY spends_by_time
LEFT JOIN model_calls m ON m.spend_id = s.id
LEFT JOIN web_renders r ON r.spend_id = s.id
LEFT JOIN web_searches w ON w.spend_id = s.id
WHERE s.created_at >= ?1 AND s.created_at < ?2
GROUP BY s.product
ORDER BY spent DESC, calls DESC, s.product`

/**
 * The accounts with a grant or a spend in the period, the biggest spenders first, at most ?4
 * of them. The balance is read only for those, each through the indexes by user. ?3 is now.
 */
const ACCOUNTS = `WITH
granted AS (
  SELECT user_id, sum(amount) AS granted FROM grants INDEXED BY grants_by_time
  WHERE granted_at >= ?1 AND granted_at < ?2 GROUP BY user_id
),
spent AS (
  SELECT s.user_id, sum(s.micro_credits) AS spent, ${forgiven} AS forgiven, count(m.id) AS calls, count(r.id) AS renders,
    ${renderSpent} AS render_spent, count(w.id) AS searches, ${searchSpent} AS search_spent
  FROM spends s INDEXED BY spends_by_time
  LEFT JOIN model_calls m ON m.spend_id = s.id
  LEFT JOIN web_renders r ON r.spend_id = s.id
  LEFT JOIN web_searches w ON w.spend_id = s.id
  WHERE s.created_at >= ?1 AND s.created_at < ?2 GROUP BY s.user_id
),
top AS (
  SELECT user_id, sum(granted) AS granted, sum(spent) AS spent, sum(forgiven) AS forgiven, sum(calls) AS calls,
    sum(renders) AS renders,
    sum(render_spent) AS render_spent, sum(searches) AS searches, sum(search_spent) AS search_spent
  FROM (
    SELECT user_id, granted, 0 AS spent, 0 AS forgiven, 0 AS calls, 0 AS renders, 0 AS render_spent, 0 AS searches,
      0 AS search_spent FROM granted
    UNION ALL
    SELECT user_id, 0, spent, forgiven, calls, renders, render_spent, searches, search_spent FROM spent
  )
  GROUP BY user_id
  ORDER BY spent DESC, granted DESC, user_id
  LIMIT ?4
)
SELECT user_id, granted, spent, forgiven, calls, renders, render_spent, searches, search_spent, ${balanceOf('top.user_id', '?3')} AS balance
FROM top
ORDER BY spent DESC, granted DESC, user_id`

const count = z.int().min(0)
const GrantedRow = z.object({ day: z.int(), source: GrantSource, amount: count })
const SpentRow = z.object({
  day: z.int(),
  calls: count,
  failed_calls: count,
  cancelled_calls: count,
  spent: count,
  forgiven: count,
  prompt_tokens: count,
  cached_tokens: count,
  completion_tokens: count,
  renders: count,
  failed_renders: count,
  render_ms: count,
  render_spent: count,
  searches: count,
  failed_searches: count,
  search_spent: count,
})
const ProductRow = z
  .object({
    product: z.string(),
    spent: count,
    calls: count,
    renders: count,
    render_spent: count,
    searches: count,
    search_spent: count,
  })
  .transform((row): ProductSpending => ({
    product: row.product,
    spent: row.spent,
    calls: row.calls,
    renders: row.renders,
    renderSpent: row.render_spent,
    searches: row.searches,
    searchSpent: row.search_spent,
  }))
const AccountRow = z
  .object({
    user_id: z.string(),
    granted: count,
    spent: count,
    forgiven: count,
    calls: count,
    renders: count,
    render_spent: count,
    searches: count,
    search_spent: count,
    balance: z.int(),
  })
  .transform((row): AccountSummary => ({
    userId: row.user_id,
    granted: row.granted,
    spent: row.spent,
    forgiven: row.forgiven,
    calls: row.calls,
    renders: row.renders,
    renderSpent: row.render_spent,
    searches: row.searches,
    searchSpent: row.search_spent,
    balance: row.balance,
  }))

const nothing = (): Totals => ({
  granted: { free: 0, manual: 0, purchase: 0 },
  spent: 0,
  forgiven: 0,
  calls: 0,
  failedCalls: 0,
  cancelledCalls: 0,
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  renders: 0,
  failedRenders: 0,
  renderMs: 0,
  renderSpent: 0,
  searches: 0,
  failedSearches: 0,
  searchSpent: 0,
})

/** Adds `more` to `totals`. */
function add(totals: Totals, more: Totals): void {
  for (const source of GrantSource.options) totals.granted[source] += more.granted[source]
  totals.spent += more.spent
  totals.forgiven += more.forgiven
  totals.calls += more.calls
  totals.failedCalls += more.failedCalls
  totals.cancelledCalls += more.cancelledCalls
  totals.promptTokens += more.promptTokens
  totals.cachedTokens += more.cachedTokens
  totals.completionTokens += more.completionTokens
  totals.renders += more.renders
  totals.failedRenders += more.failedRenders
  totals.renderMs += more.renderMs
  totals.renderSpent += more.renderSpent
  totals.searches += more.searches
  totals.failedSearches += more.failedSearches
  totals.searchSpent += more.searchSpent
}

/** What was granted and spent in the period, for each of its days, by product, and in all. Every table is read at one moment. */
export async function readOverview(db: Database, { from, to, utcOffset }: Period): Promise<Overview> {
  const offsetMs = utcOffset * 60_000
  const [grantedRows, callsRows, productRows] = await db.batch([
    db.prepare(GRANTED_PER_DAY).bind(from, to, offsetMs),
    db.prepare(SPENT_PER_DAY).bind(from, to, offsetMs),
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
  for (const row of z.array(SpentRow).parse(callsRows?.results ?? [])) {
    const totals = at(row.day)
    totals.spent = row.spent
    totals.forgiven = row.forgiven
    totals.calls = row.calls
    totals.failedCalls = row.failed_calls
    totals.cancelledCalls = row.cancelled_calls
    totals.promptTokens = row.prompt_tokens
    totals.cachedTokens = row.cached_tokens
    totals.completionTokens = row.completion_tokens
    totals.renders = row.renders
    totals.failedRenders = row.failed_renders
    totals.renderMs = row.render_ms
    totals.renderSpent = row.render_spent
    totals.searches = row.searches
    totals.failedSearches = row.failed_searches
    totals.searchSpent = row.search_spent
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
