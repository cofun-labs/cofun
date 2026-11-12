import * as z from './zod'

/**
 * Credits are money: 1 US dollar = 1000 credits. Every amount in the ledger is an integer number
 * of micro-credits, so the cost of a single model call is exact; amounts are rounded only when shown.
 */
const MICRO_CREDITS = 1_000_000

/** What every user gets free each week, and how long it lasts. */
export const FREE_CREDITS = 200
const FREE_GRANT = FREE_CREDITS * MICRO_CREDITS
const FREE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000

/** The slice of Durable Object storage the ledger uses. What it reads back is checked, so it is `unknown` here. */
export interface LedgerStorage {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
}

/** Credits a user was given: how many, how many are left, and when they stop counting. Times are in ms. */
const Grant = z.object({
  /** Where the credits came from. Only the weekly free grant for now. */
  source: z.literal('free'),
  amount: z.int().min(0),
  left: z.int().min(0),
  grantedAt: z.number(),
  expiresAt: z.number(),
})

/**
 * Credits set aside for a model call that is still running: the most it can cost. A call is charged
 * only when it ends, so without holds any number of calls sent at once would all start on the same
 * balance. A hold is dropped when its call is charged, or after HOLD_MS if that charge never came.
 */
const Hold = z.object({ id: z.int(), amount: z.int().min(0), expiresAt: z.number() })
const HOLD_MS = 15 * 60 * 1000

/**
 * One user's ledger. The balance is not one number: it is what is left of the grants that have not
 * expired, less `debt`, what the user spent beyond them. There is debt only while no grant has
 * anything left, and a new grant pays it back first.
 */
const Ledger = z.object({
  grants: z.array(Grant),
  debt: z.int().min(0),
  holds: z.array(Hold),
  /** The id the next hold gets. */
  nextHold: z.int(),
})
type Ledger = z.output<typeof Ledger>

/** What a user can spend now, in micro-credits (below zero after an overdraft), and when their next free grant can arrive. */
export interface Balance {
  balance: number
  nextGrantAt: number
}

/**
 * Whether a model call may start. It may when the user has credits left that calls already running
 * have not set aside; `hold` then names what was set aside for this one, to give back with its
 * charge. Otherwise `refused` says why: `empty` when there are no credits, `held` when the credits
 * that are left are all set aside for calls still running.
 */
export type Reservation = Balance & ({ hold: number } | { refused: 'empty' | 'held' })

/** One user's credit ledger. Callers pass the time, in ms, so every decision uses the request's own clock. */
export interface CreditLedger {
  /**
   * Asks to start a model call that costs at most `most` micro-credits, after giving the user the
   * weekly free grant if they have none. The balance may end below zero by less than one call's
   * `most`, however many calls run at once.
   */
  reserve(now: number, most: number): Promise<Reservation>
  /**
   * Ends the call `hold` was reserved for: takes `cost` micro-credits from the user, from the grant
   * that expires first, and drops the hold. A call that cost nothing passes 0.
   */
  charge(now: number, cost: number, hold: number): Promise<Balance>
}

/** Finds a user's ledger. In production this is the Durable Object namespace binding. */
export interface CreditsNamespace {
  getByName(name: string): CreditLedger
}

const KEY = 'ledger'

/**
 * The ledger as it stands at `now`: without the grants that have expired, and with a new free grant
 * when the user has none. Whether anything changed is returned, so reads that change nothing write
 * nothing.
 *
 * Free credits are granted here, lazily, when a user shows up: no schedule runs, nothing is written
 * for users who don't come back, and a user who returns after a month gets one grant, not four.
 */
function settle(stored: Ledger | undefined, now: number): { ledger: Ledger; changed: boolean } {
  const grants = (stored?.grants ?? []).filter((grant) => grant.expiresAt > now)
  const holds = (stored?.holds ?? []).filter((hold) => hold.expiresAt > now)
  let debt = stored?.debt ?? 0
  let changed = !stored || grants.length !== stored.grants.length || holds.length !== stored.holds.length
  // A grant with nothing left still marks the user's week: the next one arrives when it expires.
  if (!grants.some((grant) => grant.source === 'free')) {
    const repaid = Math.min(debt, FREE_GRANT)
    debt -= repaid
    grants.push({
      source: 'free',
      amount: FREE_GRANT,
      left: FREE_GRANT - repaid,
      grantedAt: now,
      expiresAt: now + FREE_PERIOD_MS,
    })
    changed = true
  }
  return { ledger: { grants, debt, holds, nextHold: stored?.nextHold ?? 1 }, changed }
}

function balanceOf(ledger: Ledger): Balance {
  const left = ledger.grants.reduce((sum, grant) => sum + grant.left, 0)
  const free = ledger.grants.filter((grant) => grant.source === 'free')
  return { balance: left - ledger.debt, nextGrantAt: Math.max(...free.map((grant) => grant.expiresAt)) }
}

async function load(storage: LedgerStorage, now: number) {
  const stored = await storage.get(KEY)
  // A ledger that does not read back as one is never replaced with a fresh grant: that would hand
  // out credits again. It fails, and the request is refused.
  return settle(stored === undefined ? undefined : Ledger.parse(stored), now)
}

/**
 * The ledger's logic for one user, kept apart from the Durable Object class so tests can run it
 * over in-memory storage. A Durable Object handles one request at a time, so get-then-put is safe.
 */
export async function reserve(storage: LedgerStorage, now: number, most: number): Promise<Reservation> {
  if (!Number.isSafeInteger(most) || most < 0) throw new Error('a hold must be a non-negative integer')
  const { ledger, changed } = await load(storage, now)
  const current = balanceOf(ledger)
  const held = ledger.holds.reduce((sum, hold) => sum + hold.amount, 0)
  if (current.balance - held <= 0) {
    if (changed) await storage.put(KEY, ledger)
    return { ...current, refused: current.balance <= 0 ? 'empty' : 'held' }
  }
  const hold = ledger.nextHold++
  ledger.holds.push({ id: hold, amount: most, expiresAt: now + HOLD_MS })
  await storage.put(KEY, ledger)
  return { ...current, hold }
}

export async function charge(storage: LedgerStorage, now: number, cost: number, hold: number): Promise<Balance> {
  if (!Number.isSafeInteger(cost) || cost < 0) throw new Error('a charge must be a non-negative integer')
  const { ledger } = await load(storage, now)
  ledger.holds = ledger.holds.filter((kept) => kept.id !== hold)
  let rest = cost
  for (const grant of ledger.grants.toSorted((a, b) => a.expiresAt - b.expiresAt)) {
    const spent = Math.min(grant.left, rest)
    grant.left -= spent
    rest -= spent
  }
  // The call was already answered: what the grants don't cover is owed, and comes out of the next grant.
  ledger.debt += rest
  await storage.put(KEY, ledger)
  return balanceOf(ledger)
}
