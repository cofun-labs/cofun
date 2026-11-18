// The signed-in user's credits as the worker reports them (GET /v1/credits, and the grants they were
// given from GET /v1/credits/grants), the packs of credits it sells, and the Checkout page it opens
// for one. The one definition of each shape: the types come from the schemas.
import { z } from './zod'

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
