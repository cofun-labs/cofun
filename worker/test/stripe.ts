import type { CheckoutRequest, StripeApi } from '../src/stripe'

/** The signing secret the tests' webhook endpoint has. A test value, not a real secret. */
export const WEBHOOK_SECRET = 'whsec_test_secret'

/**
 * Stands in for Stripe's API (env.STRIPE): keeps every Checkout Session the worker asked for, and
 * writes the events Stripe would send about them, carrying what the worker put on each session.
 */
export class FakeStripe implements StripeApi {
  /** Every session the worker made, in order. */
  readonly sessions: (CheckoutRequest & { id: string })[] = []
  /** When set, making a session fails with this error, like Stripe being unreachable. */
  failWith?: Error

  async createCheckout(request: CheckoutRequest): Promise<{ url: string }> {
    if (this.failWith) throw this.failWith
    const id = `cs_test_${this.sessions.length + 1}`
    this.sessions.push({ ...request, id })
    return { url: `https://checkout.stripe.com/c/pay/${id}` }
  }

  /**
   * The event Stripe sends about the latest session (or `session`): `checkout.session.completed` by
   * default, paid, with the payment `payment`. The amount is in the buyer's currency, with tax:
   * `currency` and `amountTotal` say what the buyer paid, which never decides the credits.
   */
  sessionEvent(
    options: {
      type?: string
      session?: number
      payment?: string
      paymentStatus?: string
      currency?: string
      amountTotal?: number
    } = {},
  ): Record<string, unknown> {
    const session = this.sessions[options.session ?? this.sessions.length - 1]
    if (!session) throw new Error('no session was made')
    return event(options.type ?? 'checkout.session.completed', {
      id: session.id,
      object: 'checkout.session',
      mode: 'payment',
      payment_status: options.paymentStatus ?? 'paid',
      payment_intent: options.payment ?? `pi_for_${session.id}`,
      client_reference_id: session.userId,
      currency: options.currency ?? 'usd',
      amount_total: options.amountTotal ?? session.credits / 10,
      metadata: { cofun_user_id: session.userId, cofun_credits: String(session.credits) },
      success_url: session.successUrl,
      cancel_url: session.cancelUrl,
    })
  }
}

let events = 0

/** An event as Stripe sends it, about `object`. */
export function event(type: string, object: Record<string, unknown>): Record<string, unknown> {
  return { id: `evt_test_${++events}`, object: 'event', type, livemode: false, data: { object } }
}

/** `charge.refunded` for the payment `payment`. */
export const refunded = (payment: string) =>
  event('charge.refunded', { id: `ch_for_${payment}`, object: 'charge', payment_intent: payment, refunded: true })

/** `charge.dispute.created` for the payment `payment`. */
export const disputed = (payment: string) =>
  event('charge.dispute.created', { id: `dp_for_${payment}`, object: 'dispute', payment_intent: payment })

/** The `Stripe-Signature` header Stripe sends with `payload`, signed at `at` (ms) with `secret`. */
export async function signature(payload: string, at: number, secret = WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const seconds = Math.floor(at / 1000)
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${seconds}.${payload}`))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `t=${seconds},v1=${hex}`
}
