// The signed-in user's credits as the worker reports them (GET /v1/credits, and the grants they were
// given from GET /v1/credits/grants), the packs it sells, and how an amount reads. The request itself
// is made by the agent (agent/worker.ts), like every call to the worker. How a panel words the rest
// (dates, sources, what is left) is the extension's own.
import { z } from './zod'

/** The worker's amounts are micro-credits; the panel shows whole credits. */
const MICRO_CREDITS = 1_000_000

/**
 * Where a grant's credits came from, as the worker names it. Any name is taken: the panel words the
 * sources it knows, and shows one it does not know yet (a newer worker) as plain credits, so a new
 * source never makes a read fail.
 */
const Source = z.string()

/** A day as the worker writes it, already the user's own day: YYYY-MM-DD. */
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const DayUsage = z.object({ day: Day, microCredits: z.int().min(0) })

/** What the worker answers. The one definition of its shape: the type below comes from it. */
export const Credits = z.object({
  /** What the next question starts with. Never below zero: what a question costs beyond it is forgiven. */
  balance: z.int().min(0),
  /**
   * The weekly free credits. Started: they run until `until`, and new ones can arrive from then.
   * Not started: the next question brings `toCome` (already part of `balance`), valid for `lastsMs`.
   */
  free: z.discriminatedUnion('started', [
    z.object({ started: z.literal(true), until: z.int() }),
    z.object({ started: z.literal(false), toCome: z.int(), lastsMs: z.int().min(1) }),
  ]),
  /** The grants that still count, the one that expires first first. */
  grants: z.array(z.object({ source: Source, left: z.int().min(0), expiresAt: z.int() })),
  /** Credits used per day (the user's own days), newest first, over the last `days` days. */
  usage: z.object({
    days: z.int().min(1),
    byDay: z.array(DayUsage),
  }),
})
export type Credits = z.infer<typeof Credits>

/** Every grant the user was given, newest first, the expired ones included. */
export const Grants = z.object({
  grants: z.array(
    z.object({
      source: Source,
      amount: z.int().min(0),
      /** What is left of it, or for an expired grant, what went unspent. */
      left: z.int().min(0),
      grantedAt: z.int(),
      expiresAt: z.int(),
      /** For a purchase: what it cost, in US cents. */
      usdCents: z.int().min(0).optional(),
      /**
       * For a purchase that was taken back: why (`refund`, `dispute`, or one a newer worker names).
       * It ended at `expiresAt`, and `left` is what was taken back.
       */
      revoked: z.string().optional(),
    }),
  ),
})
export type PastGrant = z.infer<typeof Grants>['grants'][number]

/**
 * The packs of credits on sale, smallest first, as the worker sells them: each a quantity of 1,000
 * credits, with its credits and its price in US cents.
 */
export const Packs = z.object({
  packs: z.array(z.object({ quantity: z.int().min(1), credits: z.int().min(1), usdCents: z.int().min(1) })),
})
export type Packs = z.infer<typeof Packs>
export type Pack = Packs['packs'][number]

/** The Checkout page for a pack, which the panel opens in a new tab. Only Stripe's own pages are opened. */
export const CheckoutPage = z.object({
  url: z.url({ protocol: /^https$/, hostname: /^checkout\.stripe\.com$/ }),
})

/** A pack's price: "US$5", "US$12.50". */
export function usdText(cents: number): string {
  const dollars = cents / 100
  return `US$${Number.isInteger(dollars) ? dollars.toLocaleString('en') : dollars.toLocaleString('en', { minimumFractionDigits: 2 })}`
}

/**
 * An amount as a whole number of credits. What is left is rounded down, so the panel never promises
 * more than there is; what was used is rounded to the nearest. An amount too small to show as 1 is
 * "less than 1", not 0: there is still something there.
 */
export function wholeCredits(micro: number, rounding: 'down' | 'nearest' = 'down'): string {
  const whole = rounding === 'down' ? Math.floor(micro / MICRO_CREDITS) : Math.round(micro / MICRO_CREDITS)
  if (whole <= 0) return micro > 0 ? 'less than 1' : '0'
  return whole.toLocaleString('en')
}
