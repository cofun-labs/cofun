// Stripe, as the worker uses it: Checkout Sessions for buying credits, and the events Stripe sends to
// the webhook. The worker is the only part of Cofun that talks to Stripe; the extension only opens
// the Checkout page Stripe hosts. Everything Stripe sends is parsed here, at the boundary.
import * as z from './zod'

/**
 * The API version requests are made with. Managed Payments needs 2025-03-31.basil or later; the
 * webhook endpoint is set up with the same version (docs/development.md), so events have the shapes
 * parsed below. The fields read here are the same in every later version.
 */
const STRIPE_API_VERSION = '2025-03-31.basil'

/** What a Checkout Session is made for: one pack, bought by one user. */
export interface CheckoutRequest {
  /** The Stripe price of the pack. */
  price: string
  /** The pack's credits, kept on the session so the webhook grants the pack that was chosen. */
  credits: number
  /** The Clerk user id of the buyer. */
  userId: string
  /** Where Stripe sends the buyer after paying, and after going back without paying. */
  successUrl: string
  cancelUrl: string
}

/** The slice of Stripe's API the worker uses. Tests pass a fake through `env.STRIPE`. */
export interface StripeApi {
  /** Makes a Checkout Session for the pack, and gives the URL of its page. */
  createCheckout(request: CheckoutRequest): Promise<{ url: string }>
}

/**
 * Where a Checkout Session records whom it is for and what it grants. Metadata is written only by
 * the worker, with its secret key, and comes back in events Stripe signs, so the webhook can trust it.
 */
export const META_USER = 'cofun_user_id'
export const META_CREDITS = 'cofun_credits'

/** The form body of a request to Stripe's API: nested parameters written `a[b][c]=…`. */
function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString()
}

const CreatedSession = z.object({ url: z.url({ protocol: /^https$/ }) })
const StripeError = z.object({ error: z.object({ message: z.string() }) })

/** How requests reach Stripe: `fetch` when deployed. Tests pass a fake that answers as Stripe would. */
export type Send = (url: string, init: RequestInit) => Promise<Response>

/** Stripe's API over HTTP, with the account's secret key. */
export function stripeOverHttp(secretKey: string, send: Send = (url, init) => fetch(url, init)): StripeApi {
  return {
    async createCheckout({ price, credits, userId, successUrl, cancelUrl }) {
      const res = await send('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'stripe-version': STRIPE_API_VERSION,
        },
        body: form({
          // A one-time payment, with Stripe as the merchant of record. Managed Payments chooses the
          // payment methods and the currency the buyer sees (Adaptive Pricing), and adds the tax.
          mode: 'payment',
          'managed_payments[enabled]': 'true',
          'line_items[0][price]': price,
          'line_items[0][quantity]': '1',
          client_reference_id: userId,
          [`metadata[${META_USER}]`]: userId,
          [`metadata[${META_CREDITS}]`]: String(credits),
          success_url: successUrl,
          cancel_url: cancelUrl,
        }),
      })
      const body: unknown = await res.json().catch(() => undefined)
      if (!res.ok) {
        const message = StripeError.safeParse(body).data?.error.message ?? 'no error message'
        throw new Error(`Stripe answered ${res.status}: ${message}`)
      }
      const session = CreatedSession.safeParse(body)
      if (!session.success) throw new Error('Stripe answered a Checkout Session without a URL')
      return { url: session.data.url }
    },
  }
}

/** How far an event's signed time may be from the worker's clock: Stripe's own libraries allow 5 minutes. */
const TOLERANCE_MS = 5 * 60 * 1000

const SignatureHeader = z
  .string()
  .max(4096)
  .transform((header) => {
    const parts = header.split(',').map((part) => part.split('='))
    const at = parts.find(([key]) => key === 't')?.[1]
    const signatures = parts.filter(([key, value]) => key === 'v1' && value).map(([, value]) => value)
    return { at: at && /^\d{1,12}$/.test(at) ? Number(at) * 1000 : undefined, signatures }
  })

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Whether two strings are equal, in a time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Checks that `payload` came from Stripe: the `Stripe-Signature` header holds a time and one or more
 * HMAC-SHA256 signatures of `<time>.<payload>` with the endpoint's signing secret, as
 * https://docs.stripe.com/webhooks#verify-manually describes. The time must be within 5 minutes of
 * `now`, so an old event cannot be sent again. Gives the payload's JSON, still to be parsed, or
 * undefined when it is not Stripe's.
 */
export async function verifiedEvent(
  payload: string,
  header: string | undefined,
  secret: string,
  now: number,
): Promise<unknown> {
  const parsed = SignatureHeader.safeParse(header)
  if (!parsed.success) return undefined
  const { at, signatures } = parsed.data
  if (at === undefined || !signatures.length || Math.abs(now - at) > TOLERANCE_MS) return undefined
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${at / 1000}.${payload}`)))
  if (!signatures.some((signature) => sameText(signature, expected))) return undefined
  try {
    return JSON.parse(payload)
  } catch {
    return undefined
  }
}

/** An event, as far as the worker reads every one: its type, and the object it is about. */
export const StripeEvent = z.object({
  id: z.string(),
  type: z.string(),
  data: z.object({ object: z.unknown() }),
})

/** A Checkout Session, as the events about one carry it. */
export const CheckoutSession = z.object({
  id: z.string(),
  mode: z.string(),
  /** `paid` once the money is there; `unpaid` while a payment method that completes later is pending. */
  payment_status: z.string(),
  /** The payment's PaymentIntent id: the reference a purchase is recorded with, and refunds and disputes name. */
  payment_intent: z.string().nullable(),
  client_reference_id: z.string().nullable(),
  metadata: z.record(z.string(), z.string()).nullable(),
})

/** A charge or a dispute, as far as the payment it is about. */
export const AboutPayment = z.object({ payment_intent: z.string().nullable() })
