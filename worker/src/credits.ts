import * as z from './zod'

/**
 * Credits are money: 1 US dollar = 1000 credits. Every amount in the ledger is an integer number
 * of micro-credits, so the cost of a single model call is exact; amounts are rounded only when shown.
 */
export const MICRO_CREDITS = 1_000_000

/** What every user gets free each week, and how long it lasts. */
export const FREE_CREDITS = 200
const FREE_GRANT = FREE_CREDITS * MICRO_CREDITS
const FREE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000

/** The slice of Durable Object storage the ledger uses. What it reads back is checked, so it is `unknown` here. */
export interface LedgerStorage {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
}

/**
 * Credits a user was given: how many, how many are left, and when they stop counting. Times are in
 * ms. A grant is never removed: once it has expired it counts for nothing, and stays as the record
 * of what the user was given, with `left` what went unspent.
 */
const Grant = z.object({
  /** Where the credits came from: the weekly free grant, or an admin who granted them by hand. */
  source: z.enum(['free', 'manual']),
  amount: z.int().min(0),
  left: z.int().min(0),
  grantedAt: z.number(),
  expiresAt: z.number(),
  /** For a grant made by hand: the Clerk user id of the admin who made it. */
  by: z.string().optional(),
})
type Grant = z.output<typeof Grant>

/**
 * Credits set aside for a model call that is still running: the most it can cost. A call is charged
 * only when it ends, so without holds any number of calls sent at once would all start on the same
 * balance. A hold is dropped when its call is charged, or after HOLD_MS if that charge never came.
 */
const Hold = z.object({ id: z.int(), amount: z.int().min(0), expiresAt: z.number() })
const HOLD_MS = 15 * 60 * 1000

/**
 * One user's ledger. The balance is not one number: it is what is left of the grants that have not
 * expired, less `debt`, what the user spent beyond them. There is debt only while no grant that
 * still counts has anything left, and a new grant pays it back first.
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

/** A user's account as the ledger holds it at one moment. Amounts are in micro-credits. */
export interface Account {
  /** What the user can spend: what is left of the grants that have not expired, less the debt. */
  balance: number
  /** What the user spent beyond their grants. The next grant pays it back first. */
  debt: number
  /** What is set aside for model calls still running. */
  held: number
  /** Every grant the user was given, oldest first, the expired ones included. */
  grants: Grant[]
}

/** Credits granted by hand: how many micro-credits, until when, and the Clerk user id of the admin granting them. */
export interface ManualGrant {
  amount: number
  expiresAt: number
  by: string
}

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
  /**
   * The account as it stands. Reading changes nothing: in particular it does not give the user
   * their weekly free grant, which waits for the user's own next call.
   */
  read(now: number): Promise<Account>
  /**
   * Grants credits by hand, beside the weekly free grant. Like any grant it pays back debt first.
   * It does not give the user their weekly free grant either: that still starts with their own
   * next call, so a grant by hand never uses up part of a user's free week.
   */
  grant(now: number, grant: ManualGrant): Promise<Account>
}

/** Finds a user's ledger. In production this is the Durable Object namespace binding. */
export interface CreditsNamespace {
  getByName(name: string): CreditLedger
}

const KEY = 'ledger'

/** A grant still counts until the moment it expires. */
const counts = (grant: Grant, now: number) => grant.expiresAt > now

/** The ledger as stored, or an empty one for a user it has not seen, without the holds that have expired. */
async function stored(storage: LedgerStorage, now: number): Promise<{ ledger: Ledger; changed: boolean }> {
  const value = await storage.get(KEY)
  // A ledger that does not read back as one is never replaced with a fresh grant: that would hand
  // out credits again. It fails, and the request is refused.
  const ledger = value === undefined ? undefined : Ledger.parse(value)
  const holds = (ledger?.holds ?? []).filter((hold) => hold.expiresAt > now)
  return {
    ledger: { grants: ledger?.grants ?? [], debt: ledger?.debt ?? 0, holds, nextHold: ledger?.nextHold ?? 1 },
    changed: !ledger || holds.length !== ledger.holds.length,
  }
}

/** Adds a grant, paying back the debt out of it first. */
function addGrant(ledger: Ledger, grant: Omit<Grant, 'left'>): void {
  const repaid = Math.min(ledger.debt, grant.amount)
  ledger.debt -= repaid
  ledger.grants.push({ ...grant, left: grant.amount - repaid })
}

/**
 * The ledger as it stands at `now` for a user who is making a call: with a new free grant when the
 * user has none that still counts. Whether anything changed is returned, so reads that change
 * nothing write nothing.
 *
 * Free credits are granted here, lazily, when a user shows up: no schedule runs, nothing is written
 * for users who don't come back, and a user who returns after a month gets one grant, not four.
 * Only free grants are looked at: credits granted by hand never stand in for the free week.
 */
async function load(storage: LedgerStorage, now: number): Promise<{ ledger: Ledger; changed: boolean }> {
  const { ledger, changed } = await stored(storage, now)
  // A free grant with nothing left still marks the user's week: the next one arrives when it expires.
  if (ledger.grants.some((grant) => grant.source === 'free' && counts(grant, now))) return { ledger, changed }
  addGrant(ledger, { source: 'free', amount: FREE_GRANT, grantedAt: now, expiresAt: now + FREE_PERIOD_MS })
  return { ledger, changed: true }
}

/** What the grants that still count have left, less the debt. */
function spendable(ledger: Ledger, now: number): number {
  const left = ledger.grants.reduce((sum, grant) => sum + (counts(grant, now) ? grant.left : 0), 0)
  return left - ledger.debt
}

/** The balance of a ledger that has a free grant, as `load` leaves it. */
function balanceOf(ledger: Ledger, now: number): Balance {
  const free = ledger.grants.filter((grant) => grant.source === 'free')
  return { balance: spendable(ledger, now), nextGrantAt: Math.max(...free.map((grant) => grant.expiresAt)) }
}

function accountOf(ledger: Ledger, now: number): Account {
  return {
    balance: spendable(ledger, now),
    debt: ledger.debt,
    held: ledger.holds.reduce((sum, hold) => sum + hold.amount, 0),
    grants: ledger.grants,
  }
}

/**
 * The ledger's logic for one user, kept apart from the Durable Object class so tests can run it
 * over in-memory storage. A Durable Object handles one request at a time, so get-then-put is safe.
 */
export async function reserve(storage: LedgerStorage, now: number, most: number): Promise<Reservation> {
  if (!Number.isSafeInteger(most) || most < 0) throw new Error('a hold must be a non-negative integer')
  const { ledger, changed } = await load(storage, now)
  const current = balanceOf(ledger, now)
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
  const spendFrom = ledger.grants.filter((grant) => counts(grant, now))
  for (const grant of spendFrom.toSorted((a, b) => a.expiresAt - b.expiresAt)) {
    const spent = Math.min(grant.left, rest)
    grant.left -= spent
    rest -= spent
  }
  // The call was already answered: what the grants don't cover is owed, and comes out of the next grant.
  ledger.debt += rest
  await storage.put(KEY, ledger)
  return balanceOf(ledger, now)
}

export async function read(storage: LedgerStorage, now: number): Promise<Account> {
  const { ledger } = await stored(storage, now)
  return accountOf(ledger, now)
}

export async function grant(storage: LedgerStorage, now: number, { amount, expiresAt, by }: ManualGrant) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('a grant must be a positive integer')
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('a grant must expire after it is made')
  const { ledger } = await stored(storage, now)
  addGrant(ledger, { source: 'manual', amount, grantedAt: now, expiresAt, by })
  await storage.put(KEY, ledger)
  return accountOf(ledger, now)
}
