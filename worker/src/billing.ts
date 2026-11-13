// Buying credits: the packs on offer, and what the Stripe webhook does with the events it is sent.
// A paid purchase adds one grant of the pack's credits, valid for a year; a refund or a dispute takes
// back what is left of it. The routes are in app.ts.
import * as z from './zod'
import { Ledger, MICRO_CREDITS, takeBack, type Database } from './credits'
import { AboutPayment, CheckoutSession, META_CREDITS, META_USER, StripeEvent } from './stripe'

/** The most credits one pack may hold: a typo in the configuration must not sell a fortune for a dollar. */
const MAX_PACK_CREDITS = 1_000_000

/** A pack on offer: its credits, and the Stripe price that sells it. */
export interface Pack {
  credits: number
  price: string
}

/**
 * The STRIPE_PACKS var: which Stripe price sells how many credits, `{"price_…": 5000}`. Each Stripe
 * environment has prices of its own (the sandbox offers a smaller pack than live), so the packs are
 * configuration, not code. A JSON object in wrangler.jsonc, so it arrives as an object; in
 * `.dev.vars` every value is a string, so JSON text is read too. A price's amount must be its
 * credits at 1000 credits a US dollar: the side panel shows the price worked out that way.
 */
const Packs = z
  .union([
    z.string().transform((text, ctx) => {
      try {
        const value: unknown = JSON.parse(text)
        return value
      } catch {
        ctx.addIssue({ code: 'custom', message: 'not JSON' })
        return z.NEVER
      }
    }),
    z.unknown(),
  ])
  .pipe(
    z.record(
      z.string().regex(/^price_[A-Za-z0-9]{1,64}$/, { error: 'keys must be Stripe price ids (price_…)' }),
      z
        .int()
        .min(10)
        .max(MAX_PACK_CREDITS)
        .refine((credits) => credits % 10 === 0, { error: 'credits must be whole US cents (multiples of 10)' }),
    ),
  )
  .transform((record, ctx): Pack[] => {
    const packs = Object.entries(record)
      .map(([price, credits]) => ({ price, credits }))
      .toSorted((a, b) => a.credits - b.credits)
    if (new Set(packs.map((pack) => pack.credits)).size !== packs.length) {
      ctx.addIssue({ code: 'custom', message: 'two packs have the same credits' })
      return z.NEVER
    }
    return packs
  })

/** The packs on offer, smallest first, or a message saying what is wrong with the configuration. */
export function packsOf(value: unknown): { packs: Pack[] } | { error: string } {
  if (value === undefined || value === '') return { packs: [] }
  const parsed = Packs.safeParse(value)
  return parsed.success ? { packs: parsed.data } : { error: parsed.error.issues[0].message }
}

/** When purchased credits stop counting: one year after the purchase, on the same day and time (UTC). */
function purchaseExpiry(now: number): number {
  const at = new Date(now)
  at.setUTCFullYear(at.getUTCFullYear() + 1)
  return at.getTime()
}

/** What a Checkout Session says it grants, as the worker wrote it when it made the session. */
const Granting = z.object({
  [META_USER]: z.string().regex(/^user_[A-Za-z0-9]{1,64}$/),
  [META_CREDITS]: z
    .string()
    .regex(/^\d{1,7}$/)
    .transform(Number)
    .pipe(z.int().min(1).max(MAX_PACK_CREDITS)),
})

/** What the webhook did with an event, for the response and the log. */
export type Handled =
  | { done: 'granted' | 'granted already' | 'taken back' | 'ignored'; log?: string }
  /** The event names a payment that made no grant (yet): Stripe sends it again later. */
  | { done: 'retry'; log: string }

/**
 * Handles one event Stripe sent and signed. Events may arrive more than once and in any order, and
 * each step is safe to repeat: a payment grants once, and a purchase is taken back once. A refund or
 * a dispute can only follow a payment, but its event can arrive first; then it is answered with
 * `retry`, so Stripe sends it again once the payment's own event has been handled. Events the worker
 * does not act on are acknowledged and ignored.
 */
export async function handleEvent(db: Database, now: number, payload: unknown): Promise<Handled> {
  const event = StripeEvent.parse(payload)
  switch (event.type) {
    // A payment that went through at once, or one that completes later: Checkout says `unpaid` at
    // first and sends `async_payment_succeeded` when the money arrives (or `…_failed`, which grants
    // nothing).
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = CheckoutSession.parse(event.data.object)
      if (session.mode !== 'payment' || session.payment_status !== 'paid') return { done: 'ignored' }
      const granting = Granting.safeParse(session.metadata ?? {})
      // Every session the worker makes says what it grants: one that doesn't was not made for credits.
      if (!granting.success) return { done: 'ignored', log: `checkout session ${session.id} grants nothing` }
      const userId = granting.data[META_USER]
      const credits = granting.data[META_CREDITS]
      if (session.client_reference_id !== userId) {
        throw new Error(`checkout session ${session.id} names two users`)
      }
      // A paid session in payment mode has its PaymentIntent: without one there is nothing that a
      // refund could name later, so the event fails and Stripe sends it again.
      if (!session.payment_intent) throw new Error(`checkout session ${session.id} is paid with no payment intent`)
      // The credits are the pack's, as the worker wrote them on the session: never worked out from
      // the amount paid, which is in the buyer's currency and may include tax.
      const added = await new Ledger(db, userId).purchase(now, {
        amount: credits * MICRO_CREDITS,
        expiresAt: purchaseExpiry(now),
        payment: session.payment_intent,
      })
      return added
        ? { done: 'granted', log: `purchase: user=${userId} credits=${credits} payment=${session.payment_intent}` }
        : { done: 'granted already' }
    }
    // A refund, full or partial, takes back all that is left of the purchase: purchases are final,
    // and a refund is the exception (a billing error, the law, or Stripe as the seller of record).
    // A dispute does the same as soon as it is opened; a dispute that is won gives nothing back
    // (an operator can grant the credits by hand).
    case 'charge.refunded':
    case 'charge.dispute.created': {
      const why = event.type === 'charge.refunded' ? 'refund' : 'dispute'
      const payment = AboutPayment.parse(event.data.object).payment_intent
      if (!payment) return { done: 'ignored' }
      if (!(await takeBack(db, now, payment, why))) {
        return { done: 'retry', log: `${why} for payment=${payment}, which made no grant` }
      }
      return { done: 'taken back', log: `purchase taken back: payment=${payment} reason=${why}` }
    }
    default:
      return { done: 'ignored' }
  }
}
