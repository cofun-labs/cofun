// The admin routes (/v1/admin/*): an account's credits, grants by hand, and what was granted and
// spent across accounts. Every one needs a session whose token says its user is an admin.
import { Hono } from 'hono'
import * as z from '../zod'
import { readAccounts, readOverview, type Period } from '../overview'
import { Ledger, MICRO_CREDITS, type Account } from '../credits'
import {
  CalendarDate,
  DAY_MS,
  HttpError,
  MAX_ID_CHARS,
  WholeNumber,
  errorSummary,
  parse,
  part,
  type App,
  type Ctx,
  type Deps,
} from '../http'

/**
 * What a session token must say for its user to be an admin. `role` is a custom claim: the Clerk
 * instance's session token is customized to carry `"role": "{{user.public_metadata.role}}"`, and
 * an admin is a user whose public metadata in Clerk has `"role": "admin"`. Only Clerk's dashboard
 * and Backend API can write public metadata, so users cannot give themselves the role. `azp` is
 * the origin the token was issued to: admin requests come only from the admin page, which this
 * worker serves, so a token issued to the extension or to any other origin is not an admin's.
 */
const AdminClaims = z.object({ role: z.literal('admin'), azp: z.string() })

/** The most credits one grant by hand can give, and the longest it can last: a typo must not grant a fortune, or credits that never expire. */
const MAX_GRANT_CREDITS = 50_000
const MAX_GRANT_DAYS = 366

/** A Clerk user id, as far as its shape goes: the worker cannot ask Clerk whether the user exists. */
const UserId = part(z.string().regex(/^user_[A-Za-z0-9]{1,64}$/), 'the user id must look like user_… (a Clerk user id)')

const GrantBody = part(z.looseObject({}), 'body must be a JSON object').pipe(
  z.object({
    credits: part(
      z.int().min(1).max(MAX_GRANT_CREDITS),
      `credits must be a whole number from 1 to ${MAX_GRANT_CREDITS}`,
    ),
    days: part(z.int().min(1).max(MAX_GRANT_DAYS), `days must be a whole number from 1 to ${MAX_GRANT_DAYS}`),
  }),
)

/** The longest period the overview covers, and the most accounts one list shows: one request never reads more of the tables than this. */
const MAX_PERIOD_DAYS = 92
const MAX_ACCOUNTS = 200
const DEFAULT_ACCOUNTS = 50
/** No clock is further from UTC than 14 hours. */
const MAX_UTC_OFFSET = 14 * 60

/**
 * The period an admin asks for, as query parameters: its first and last day, both counted in full,
 * and how many minutes the admin's clock is ahead of UTC (0 when not given: UTC days). The worker
 * does not know the admin's time zone, so the page sends its own offset.
 */
const PeriodQuery = z
  .object({
    from: part(CalendarDate, 'from must be a date like 2026-11-12'),
    to: part(CalendarDate, 'to must be a date like 2026-11-12'),
    utcOffset: part(
      WholeNumber.pipe(z.int().min(-MAX_UTC_OFFSET).max(MAX_UTC_OFFSET)),
      `utcOffset must be a whole number of minutes from -${MAX_UTC_OFFSET} to ${MAX_UTC_OFFSET}`,
    ).optional(),
  })
  .transform(({ from, to, utcOffset = 0 }, ctx): Period => {
    const days = (to - from) / DAY_MS + 1
    if (days < 1) ctx.addIssue({ code: 'custom', message: 'to must not be before from' })
    else if (days > MAX_PERIOD_DAYS) {
      ctx.addIssue({ code: 'custom', message: `the period must be at most ${MAX_PERIOD_DAYS} days` })
    }
    // Midnight on the admin's clock is that much before (or after) midnight UTC.
    const offsetMs = utcOffset * 60_000
    return { from: from - offsetMs, to: to + DAY_MS - offsetMs, utcOffset }
  })

const AccountsLimit = part(
  WholeNumber.pipe(z.int().min(1).max(MAX_ACCOUNTS)),
  `limit must be a whole number from 1 to ${MAX_ACCOUNTS}`,
).optional()

/** The admin routes, mounted at /v1/admin, behind a check of the admin role. */
export function adminRoutes({ now, logError, logAdmin }: Deps): App {
  const routes: App = new Hono()

  // First, before any route of this sub-app: every one needs a session whose token says its user
  // is an admin.
  routes.use('*', async (c, next) => {
    // One refusal for every reason, and for every path, existing or not: someone who is not an
    // admin learns nothing about what is here.
    const claims = AdminClaims.safeParse(c.get('claims'))
    if (!claims.success || claims.data.azp !== new URL(c.req.url).origin) {
      throw new HttpError(403, 'forbidden', 'This account is not an admin.')
    }
    await next()
  })

  /** An account as the admin page shows it. Amounts stay in micro-credits; the page rounds them. */
  const accountJson = (userId: string, account: Account) => ({ userId, ...account })

  /** Runs one call on a user's ledger, or refuses the request with `message` when the call fails. */
  async function onLedger(c: Ctx, userId: string, message: string, call: (ledger: Ledger) => Promise<Account>) {
    try {
      return await call(new Ledger(c.env.DB, userId))
    } catch (err) {
      logError(`admin ledger call failed: ${errorSummary(err)}`)
      throw new HttpError(503, 'credits_unavailable', message)
    }
  }

  routes.get('/accounts/:userId', async (c) => {
    const userId = parse(UserId, c.req.param('userId'))
    const unavailable = 'Credits are unavailable, try again in a moment.'
    const account = await onLedger(c, userId, unavailable, (ledger) => ledger.read(now().getTime()))
    return c.json(accountJson(userId, account))
  })

  /** Runs a read across accounts, or refuses the request when it fails. */
  async function onOverview<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read()
    } catch (err) {
      logError(`admin overview failed: ${errorSummary(err)}`)
      throw new HttpError(503, 'credits_unavailable', 'Credits are unavailable, try again in a moment.')
    }
  }

  // What was granted and spent in a period across every account, in all and per day.
  routes.get('/overview', async (c) => {
    const period = parse(PeriodQuery, c.req.query())
    const overview = await onOverview(() => readOverview(c.env.DB, period))
    return c.json({ period, ...overview })
  })

  // The accounts with a grant or a model call in a period, the biggest spenders first.
  routes.get('/accounts', async (c) => {
    const period = parse(PeriodQuery, c.req.query())
    const limit = parse(AccountsLimit, c.req.query('limit')) ?? DEFAULT_ACCOUNTS
    // The balances are as of this moment, like an account's own lookup.
    const at = now().getTime()
    const accounts = await onOverview(() => readAccounts(c.env.DB, period, at, limit))
    return c.json({ period, at, ...accounts })
  })

  routes.post('/accounts/:userId/grants', async (c) => {
    const userId = parse(UserId, c.req.param('userId'))
    const { credits, days } = parse(GrantBody, await c.req.json().catch(() => undefined))
    const at = now().getTime()
    const grant = { amount: credits * MICRO_CREDITS, expiresAt: at + days * DAY_MS, by: c.get('userId') }
    // A call that fails may still have written the grant, and granting again would give it twice:
    // the admin is told to look before trying again, not to try again.
    const unknown = 'The grant may or may not have been made. Look the account up before granting again.'
    const account = await onLedger(c, userId, unknown, (ledger) => ledger.grant(at, grant))
    // The record of who granted what to whom. Ids, numbers, and a time only: both ids are bounded
    // (the target by its shape, the admin's by the cut here), and nothing else of the request is logged.
    const admin = grant.by.slice(0, MAX_ID_CHARS)
    logAdmin(
      `manual grant: admin=${admin} user=${userId} credits=${credits} expires=${new Date(grant.expiresAt).toISOString()}`,
    )
    return c.json(accountJson(userId, account))
  })

  return routes
}
