import * as z from './zod'

/**
 * Credits are money: 1 US dollar = 1000 credits. Every amount is an integer number of
 * micro-credits, so the cost of a single model call is exact; amounts are rounded only when shown.
 */
export const MICRO_CREDITS = 1_000_000

/** What every user gets free each week, and how long it lasts. */
export const FREE_CREDITS = 200
const FREE_GRANT = FREE_CREDITS * MICRO_CREDITS
const FREE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000

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
  /** Where the credits came from: the weekly free grant, or an admin who granted them by hand. */
  source: 'free' | 'manual'
  amount: number
  left: number
  grantedAt: number
  expiresAt: number
  /** For a grant made by hand: the Clerk user id of the admin who made it. */
  by?: string
}

/** Where a grant's credits came from, as `grants.source` holds it. */
export const GrantSource = z.enum(['free', 'manual'])

/** A row of `grants` as the ledger reads it. */
const GrantRow = z
  .object({
    source: GrantSource,
    amount: z.int().min(0),
    left: z.int().min(0),
    granted_at: z.int(),
    expires_at: z.int(),
    granted_by: z.string().nullable(),
  })
  .transform((row): Grant => ({
    source: row.source,
    amount: row.amount,
    left: row.left,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    ...(row.granted_by === null ? {} : { by: row.granted_by }),
  }))

const DebtRow = z.object({ debt: z.int().min(0) })
const BalanceRow = z.object({ balance: z.int(), next_grant_at: z.int().nullable() })

/** The one row a statement returns, checked against `schema`. */
function only<S extends z.ZodType>(schema: S, result: { results: unknown[] } | undefined): z.output<S> {
  const rows = result?.results ?? []
  if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`)
  return schema.parse(rows[0])
}

/** What a user can spend now, in micro-credits (below zero after an overdraft), and when their next free grant can arrive. */
export interface Balance {
  balance: number
  nextGrantAt: number
}

/** A user's account at one moment. Amounts are in micro-credits. */
export interface Account {
  /** What the user can spend: what is left of the grants that have not expired, less the debt. */
  balance: number
  /** What the user spent beyond their grants. The next grant pays it back first. */
  debt: number
  /** Every grant the user was given, oldest first, the expired ones included. */
  grants: Grant[]
}

/** Credits granted by hand: how many micro-credits, until when, and the Clerk user id of the admin granting them. */
export interface ManualGrant {
  amount: number
  expiresAt: number
  by: string
}

/**
 * A model call that ended, to record with what it cost: when it started and ended, how it ended,
 * its tokens (`estimated` when the call was cut short before the model reported them), and its cost
 * in micro-credits, 0 when it cost nothing.
 */
export interface ModelCall {
  model: string
  startedAt: number
  endedAt: number
  stream: boolean
  outcome: string
  finishReason: string
  promptTokens: number
  cachedTokens: number
  completionTokens: number
  estimated: boolean
  cost: number
}

// How the tables hold a ledger (worker/migrations/): `grants` has one row per grant with what is
// left of it, and `model_calls` one row per model call with what it cost. What a user owes is not a
// number of its own: it is what calls cost beyond the grants (`model_calls.owed`) less what grants
// paid back (`grants.repaid`). In every statement below, ?1 is the user id and ?2 the time.

/** What a user owes, as SQL. `user` is the SQL that names the user: a parameter, or a column of an outer query. */
const debtOf = (user: string) =>
  `((SELECT coalesce(sum(owed), 0) FROM model_calls WHERE user_id = ${user} AND owed > 0)
  - (SELECT coalesce(sum(repaid), 0) FROM grants WHERE user_id = ${user}))`

/**
 * What a user can spend at the time `now`, as SQL: what is left of the grants that still count,
 * less the debt. The one definition of a balance in SQL, for one user (below) and for a list of
 * them (overview.ts). `user` and `now` are SQL: parameters, or columns of an outer query.
 */
export const balanceOf = (user: string, now: string) =>
  `((SELECT coalesce(sum(left), 0) FROM grants WHERE user_id = ${user} AND expires_at > ${now}) - ${debtOf(user)})`

/** What the user ?1 owes. */
const DEBT = debtOf('?1')

/**
 * The weekly free grant, given lazily when a user shows up and has no free grant that still counts:
 * no schedule runs, nothing is written for users who don't come back, and a user who returns after
 * a month gets one grant, not four. A free grant with nothing left still marks the user's week.
 * Only free grants are looked at: credits granted by hand never stand in for the free week. It is
 * one statement, so two requests arriving together cannot both grant the week. Like any grant, it
 * pays back debt first. ?3 is the amount, ?4 how long it lasts.
 */
const GIVE_FREE_GRANT = `INSERT INTO grants (user_id, source, amount, repaid, left, granted_at, expires_at)
SELECT ?1, 'free', ?3, min(?3, debt), ?3 - min(?3, debt), ?2, ?2 + ?4
FROM (SELECT ${DEBT} AS debt)
WHERE NOT EXISTS (SELECT 1 FROM grants WHERE user_id = ?1 AND source = 'free' AND expires_at > ?2)`

/** A grant by hand. ?3 is the amount, ?4 when it expires, ?5 the admin's user id. */
const GIVE_MANUAL_GRANT = `INSERT INTO grants (user_id, source, amount, repaid, left, granted_at, expires_at, granted_by)
SELECT ?1, 'manual', ?3, min(?3, debt), ?3 - min(?3, debt), ?2, ?4, ?5
FROM (SELECT ${DEBT} AS debt)`

/** What the user can spend (the grants that still count, less the debt), and when their free week ends. */
const READ_BALANCE = `SELECT
  ${balanceOf('?1', '?2')} AS balance,
  (SELECT max(expires_at) FROM grants WHERE user_id = ?1 AND source = 'free') AS next_grant_at`

const READ_GRANTS = `SELECT source, amount, left, granted_at, expires_at, granted_by
FROM grants WHERE user_id = ?1 ORDER BY granted_at, id`

const READ_DEBT = `SELECT ${DEBT} AS debt`

/**
 * The record of a model call, with the part of its cost the grants that still count do not cover:
 * what the user owes. It runs before SPEND, in the same batch, so both see the same grants. ?2 is
 * when the call ended, ?3 the model, ?4 when it started, ?5 whether it streamed, ?6 its outcome, ?7
 * its finish reason, ?8 to ?10 the prompt, cached, and completion tokens, ?11 whether they are
 * estimated, ?12 the cost.
 */
const RECORD_CALL = `INSERT INTO model_calls (user_id, ended_at, model, started_at, stream, outcome, finish_reason,
  prompt_tokens, cached_tokens, completion_tokens, estimated, micro_credits, owed)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, max(0, ?12 - coalesce(sum(left), 0))
FROM grants WHERE user_id = ?1 AND expires_at > ?2`

/**
 * Takes the cost ?3 from the grants that still count, from the one that expires first: each takes
 * what the grants before it did not cover, up to what it has left. A relative update, so calls that
 * end together each take their own cost and none is lost.
 */
const SPEND = `UPDATE grants SET left = grants.left - spend.take
FROM (
  SELECT id, min(left, ?3 - before) AS take
  FROM (
    SELECT id, left,
      coalesce(sum(left) OVER (ORDER BY expires_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
    FROM grants WHERE user_id = ?1 AND expires_at > ?2 AND left > 0
  )
  WHERE before < ?3
) AS spend
WHERE grants.id = spend.id`

/** One user's credits, over the database. Callers pass the time, in ms, so every decision uses the request's own clock. */
export class Ledger {
  constructor(
    private readonly db: Database,
    private readonly userId: string,
  ) {}

  /**
   * What the user can spend before a model call, after giving them the weekly free grant if they
   * have none. A call may go ahead while the balance is above zero; calls that start together all
   * see the same balance.
   */
  async open(now: number): Promise<Balance> {
    const [, balance] = await this.db.batch([
      this.statement(GIVE_FREE_GRANT, now, FREE_GRANT, FREE_PERIOD_MS),
      this.statement(READ_BALANCE, now),
    ])
    const row = only(BalanceRow, balance)
    // The batch has just made sure there is a free grant.
    if (row.next_grant_at === null) throw new Error('no free grant after granting one')
    return { balance: row.balance, nextGrantAt: row.next_grant_at }
  }

  /**
   * Records a model call that ended, and takes what it cost from the user, from the grant that
   * expires first, in one batch: both are written, or neither. What the grants don't cover is
   * owed, and comes out of the next grant. The time is when the call ended.
   */
  async endCall(call: ModelCall): Promise<void> {
    const { promptTokens, cachedTokens, completionTokens, cost, startedAt, endedAt } = call
    for (const n of [promptTokens, cachedTokens, completionTokens, cost, startedAt, endedAt]) {
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('a model call needs non-negative integers')
    }
    const record = this.statement(
      RECORD_CALL,
      endedAt,
      call.model,
      startedAt,
      call.stream ? 1 : 0,
      call.outcome,
      call.finishReason,
      promptTokens,
      cachedTokens,
      completionTokens,
      call.estimated ? 1 : 0,
      cost,
    )
    await this.db.batch(cost === 0 ? [record] : [record, this.statement(SPEND, endedAt, cost)])
  }

  /**
   * The account as it stands. Reading changes nothing: in particular it does not give the user
   * their weekly free grant, which waits for the user's own next call.
   */
  async read(now: number): Promise<Account> {
    return this.account(now, await this.db.batch(this.reads()))
  }

  /**
   * Grants credits by hand, beside the weekly free grant. Like any grant it pays back debt first.
   * It does not give the user their weekly free grant either: that still starts with their own
   * next call, so a grant by hand never uses up part of a user's free week.
   */
  async grant(now: number, { amount, expiresAt, by }: ManualGrant): Promise<Account> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('a grant must be a positive integer')
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('a grant must expire after it is made')
    const [, ...reads] = await this.db.batch([
      this.statement(GIVE_MANUAL_GRANT, now, amount, expiresAt, by),
      ...this.reads(),
    ])
    return this.account(now, reads)
  }

  private reads(): Statement[] {
    return [this.statement(READ_GRANTS), this.statement(READ_DEBT)]
  }

  private account(now: number, [grantRows, debtRow]: { results: unknown[] }[]): Account {
    const grants = z.array(GrantRow).parse(grantRows?.results ?? [])
    const { debt } = only(DebtRow, debtRow)
    const left = grants.reduce((sum, grant) => sum + (grant.expiresAt > now ? grant.left : 0), 0)
    return { balance: left - debt, debt, grants }
  }

  /** A statement for this user: ?1 is the user id, and the values after it ?2, ?3, …. */
  private statement(query: string, ...values: Value[]): Statement {
    return this.db.prepare(query).bind(this.userId, ...values)
  }
}
