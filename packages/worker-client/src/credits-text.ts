// How the side panel words the signed-in user's credits, which the worker reports (their shapes are
// credits.ts's, which reads them). Imported as @cofun/worker-client/credits, which loads no client.
import type { Credits, PastGrant } from './credits'

/** The worker's amounts are micro-credits; the panel shows whole credits. */
const MICRO_CREDITS = 1_000_000
const DAY_MS = 24 * 60 * 60 * 1000

/** A pack's price: "US$5", "US$12.50". */
export function usdText(cents: number): string {
  const dollars = cents / 100
  return `US$${Number.isInteger(dollars) ? dollars.toLocaleString('en') : dollars.toLocaleString('en', { minimumFractionDigits: 2 })}`
}

/**
 * What the panel knows of the user's credits. `unavailable`: the last read failed, so no number is
 * shown: one read earlier may be wrong by now.
 */
export type CreditsState = { status: 'loading' } | { status: 'ready'; credits: Credits } | { status: 'unavailable' }

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

/** "1 credit", "200 credits", "less than 1 credit". */
function creditsText(micro: number): string {
  const whole = wholeCredits(micro)
  return `${whole} ${whole === '1' || whole === 'less than 1' ? 'credit' : 'credits'}`
}

const WHEN = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const WHEN_YEAR = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const DATE = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })
const DATE_YEAR = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' })
const DAY = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const DAY_SHORT = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })

const thisYear = (ms: number) => new Date(ms).getFullYear() === new Date().getFullYear()

/**
 * A moment on the user's own clock, to the minute: "Nov 15, 12:00 PM", with the year when it is not
 * this year's (bought credits last a year): "Nov 8, 2027, 5:30 PM".
 */
export const when = (ms: number) => (thisYear(ms) ? WHEN : WHEN_YEAR).format(ms)

/** The day of a moment on the user's own clock: "Nov 15", with the year when it is not this year's: "Nov 8, 2027". */
const dateText = (ms: number) => (thisYear(ms) ? DATE : DATE_YEAR).format(ms)

/** A day of usage (`YYYY-MM-DD`, already the user's own day) as a date: "Sun, Nov 8", or shorter, "Nov 8". */
export const dayText = (day: string, short = false) => (short ? DAY_SHORT : DAY).format(new Date(`${day}T00:00:00Z`))

/** A day on the user's own clock as the worker writes days: `YYYY-MM-DD`. */
function dayOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The last `days` days on the user's own clock, oldest first, ending with the day of `now`. */
export function lastDays(now: number, days: number): string[] {
  const today = new Date(now)
  return Array.from({ length: days }, (_, i) =>
    dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i))),
  )
}

/** How long free credits last, in days. */
export const daysText = (ms: number) => {
  const days = Math.round(ms / DAY_MS)
  return days === 1 ? '1 day' : `${days} days`
}

/** What is left of the grants that still count from `source`. */
export const leftFrom = ({ grants }: Credits, source: string) =>
  grants.filter((grant) => grant.source === source).reduce((sum, grant) => sum + grant.left, 0)

/**
 * What is left of the grants from `source`, with when the first of them expires: "5,000 · expire
 * Nov 8, 2027", or with several, how many of them expire then: "10,000 · 5,000 expire Nov 8, 2027".
 */
export function sourceLeftText(credits: Credits, source: string): string {
  const left = leftFrom(credits, source)
  const spendable = credits.grants.filter((grant) => grant.source === source && grant.left > 0)
  const [first] = spendable
  if (!first) return wholeCredits(left)
  // What expires first: the first grant, and any that expire at the same moment.
  const soonest = spendable.filter((grant) => grant.expiresAt === first.expiresAt).reduce((sum, g) => sum + g.left, 0)
  return `${wholeCredits(left)} · ${soonest === left ? '' : `${wholeCredits(soonest)} `}expire ${when(first.expiresAt)}`
}

/** A grant of the history in words: "Free weekly credits", "Bought 5,000 credits". One the panel does not know is plain "Credits". */
export function grantTitle({ source, amount }: PastGrant): string {
  if (source === 'free') return 'Free weekly credits'
  if (source === 'manual') return 'Credits from Cofun'
  if (source === 'purchase') return `Bought ${creditsText(amount)}`
  return 'Credits'
}

/**
 * A grant's dates, at the time `now`: the day it was given, what a purchase cost, and the day it
 * expires, expired, or was taken back.
 */
export function grantDatesText({ grantedAt, expiresAt, usdCents, revoked }: PastGrant, now: number): string {
  const parts = [dateText(grantedAt)]
  if (usdCents !== undefined) parts.push(`Paid ${usdText(usdCents)}`)
  if (revoked !== undefined) {
    parts.push(
      `${revoked === 'refund' ? 'refunded' : revoked === 'dispute' ? 'disputed' : 'taken back'} ${dateText(expiresAt)}`,
    )
  } else {
    parts.push(`${expiresAt > now ? 'expire' : 'expired'} ${dateText(expiresAt)}`)
  }
  return parts.join(' · ')
}

/**
 * What became of a grant, at the time `now`: what is left of it, what went unspent when it expired,
 * or what was taken back. `taken` marks the last, which the history shows as a loss.
 */
export function grantLeftText({ left, expiresAt, revoked }: PastGrant, now: number): { text: string; taken?: true } {
  if (left === 0) return { text: 'All used' }
  if (revoked !== undefined) return { text: `${wholeCredits(left)} taken back`, taken: true }
  return { text: `${wholeCredits(left)} ${expiresAt > now ? 'left' : 'unspent'}` }
}
