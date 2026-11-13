// Stripe, as the worker uses it: Checkout Sessions for buying credits, and the events Stripe sends to
// the webhook. The worker is the only part of Cofun that talks to Stripe; the extension only opens
// the Checkout page Stripe hosts. Everything Stripe sends is parsed here, at the boundary.
import * as z from './zod'

/**
 * The API version requests are made with. Managed Payments needs 2025-03-31.basil or later. The
 * webhook endpoint is set up with a later version of the same basil release, 2025-08-27.basil (the
 * Dashboard no longer offers this one; docs/development.md), so events have the shapes parsed
 * below: the fields read here are the same in every basil version.
 */
const STRIPE_API_VERSION = '2025-03-31.basil'

/** What a Checkout Session is made for: a quantity of the credit price, bought by one user. */
export interface CheckoutRequest {
  /** The Stripe price of one unit, 1,000 credits. */
  price: string
  /** How many units: the pack. Kept on the session too, so the webhook can check what was paid for. */
  quantity: number
  /** The credits the pack gives, for the text Checkout shows. */
  credits: number
  /** The Clerk user id of the buyer. */
  userId: string
  /** Where Stripe sends the buyer after paying, and after going back without paying. */
  successUrl: string
  cancelUrl: string
}

/** A line item of a Checkout Session: which price, and how many of it. */
export interface LineItem {
  price: string
  quantity: number
}

/** The slice of Stripe's API the worker uses. Tests pass a fake through `env.STRIPE`. */
export interface StripeApi {
  /** Makes a Checkout Session for the pack, and gives the URL of its page. */
  createCheckout(request: CheckoutRequest): Promise<{ url: string }>
  /** What a Checkout Session sells: its line items. Events about a session do not carry them. */
  lineItems(sessionId: string): Promise<LineItem[]>
}

/**
 * Where a Checkout Session records whom it is for and what it sells: the quantity of which price. Metadata is written
 * only by the worker, with its secret key, and comes back in events Stripe signs, so the webhook can
 * trust it.
 */
export const META_USER = 'cofun_user_id'
export const META_QUANTITY = 'cofun_quantity'
export const META_PRICE = 'cofun_price'

/** The form body of a request to Stripe's API: nested parameters written `a[b][c]=…`. */
function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString()
}

const CreatedSession = z.object({ url: z.url({ protocol: /^https$/ }) })
const LineItems = z.object({
  data: z.array(
    z
      .object({ price: z.object({ id: z.string() }), quantity: z.int().min(0) })
      .transform((item): LineItem => ({ price: item.price.id, quantity: item.quantity })),
  ),
  has_more: z.boolean(),
})
const StripeError = z.object({ error: z.object({ message: z.string() }) })

/** How requests reach Stripe: `fetch` when deployed. Tests pass a fake that answers as Stripe would. */
export type Send = (url: string, init: RequestInit) => Promise<Response>

/** Stripe's API over HTTP, with the account's secret key. */
export function stripeOverHttp(secretKey: string, send: Send = (url, init) => fetch(url, init)): StripeApi {
  const headers = { authorization: `Bearer ${secretKey}`, 'stripe-version': STRIPE_API_VERSION }

  /** What Stripe answered, which must be a success. */
  async function answer(res: Response): Promise<unknown> {
    const body: unknown = await res.json().catch(() => undefined)
    if (!res.ok) {
      const message = StripeError.safeParse(body).data?.error.message ?? 'no error message'
      throw new Error(`Stripe answered ${res.status}: ${message}`)
    }
    return body
  }

  return {
    async createCheckout({ price, quantity, credits, userId, successUrl, cancelUrl }) {
      const res = await send('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
        body: form({
          // A one-time payment, with Stripe as the merchant of record. Managed Payments chooses the
          // payment methods and the currency the buyer sees (Adaptive Pricing), and adds the tax.
          mode: 'payment',
          'managed_payments[enabled]': 'true',
          'line_items[0][price]': price,
          'line_items[0][quantity]': String(quantity),
          client_reference_id: userId,
          [`metadata[${META_USER}]`]: userId,
          [`metadata[${META_QUANTITY}]`]: String(quantity),
          [`metadata[${META_PRICE}]`]: price,
          // Checkout names the product and its quantity ("1,000 Credits × 10"); this says what that gives.
          'custom_text[submit][message]': `You get ${credits.toLocaleString('en')} credits for Cofun, valid for one year.`,
          success_url: successUrl,
          cancel_url: cancelUrl,
        }),
      })
      const session = CreatedSession.safeParse(await answer(res))
      if (!session.success) throw new Error('Stripe answered a Checkout Session without a URL')
      return { url: session.data.url }
    },

    async lineItems(sessionId) {
      const url = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=100`
      const items = LineItems.safeParse(await answer(await send(url, { method: 'GET', headers })))
      if (!items.success) throw new Error('Stripe answered line items the worker does not understand')
      // The worker makes sessions of one line item; more than a page of them is not one of its sessions.
      if (items.data.has_more) throw new Error(`checkout session ${sessionId} has more than 100 line items`)
      return items.data.data
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
