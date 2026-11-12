// The signed-in user's credits as the worker reports them (GET /v1/credits), and how the side panel
// words them. The request itself is made by the agent (agent.ts), like every call to the worker.
import { z } from './zod'

/** The worker's amounts are micro-credits; the panel shows whole credits. */
const MICRO_CREDITS = 1_000_000
const DAY_MS = 24 * 60 * 60 * 1000

/** What the worker answers. The one definition of its shape: the type below comes from it. */
export const Credits = z.object({
  /** What the next question starts with. Below zero when the user overspent. */
  balance: z.int(),
  /**
   * The weekly free credits. Started: they run until `until`, and new ones can arrive from then.
   * Not started: the next question brings `toCome` (already part of `balance`), valid for `lastsMs`.
   */
  free: z.discriminatedUnion('started', [
    z.object({ started: z.literal(true), until: z.int() }),
    z.object({ started: z.literal(false), toCome: z.int(), lastsMs: z.int().min(1) }),
  ]),
  /** The grants that still count, the one that expires first first. */
  grants: z.array(z.object({ source: z.enum(['free', 'manual']), left: z.int().min(0), expiresAt: z.int() })),
  /** Credits used per day (the user's own days), newest first, over the last `days` days. */
  usage: z.object({
    days: z.int().min(1),
    byDay: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), microCredits: z.int().min(0) })),
  }),
})
export type Credits = z.infer<typeof Credits>

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
export function creditsText(micro: number): string {
  const whole = wholeCredits(micro)
  return `${whole} ${whole === '1' || whole === 'less than 1' ? 'credit' : 'credits'}`
}

const WHEN = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const DAY = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

/** A moment on the user's own clock, to the minute: "Nov 15, 12:00 PM". */
export const when = (ms: number) => WHEN.format(ms)

/** A day of usage (`YYYY-MM-DD`, already the user's own day) as a date: "Sun, Nov 8". */
export const dayText = (day: string) => DAY.format(new Date(`${day}T00:00:00Z`))

/** How long free credits last, in days. */
export const daysText = (ms: number) => {
  const days = Math.round(ms / DAY_MS)
  return days === 1 ? '1 day' : `${days} days`
}

/** The credits in two lines, as the account menu shows them: what is left, then the date that matters next. */
export function creditsSummary({ balance, free, grants }: Credits): { left: string; detail: string } {
  if (balance <= 0) {
    return {
      left: 'No credits left',
      detail: free.started
        ? `Free credits arrive with your first question after ${when(free.until)}`
        : 'Your next free credits go to what you overspent',
    }
  }
  const left = `${creditsText(balance)} left`
  const spendable = grants.filter((grant) => grant.left > 0)
  if (!free.started) {
    // Free credits that have not started, alone or beside credits that have.
    const detail = spendable.length
      ? `${creditsText(free.toCome)} of them start with your next question`
      : `Valid for ${daysText(free.lastsMs)} from your next question`
    return { left, detail }
  }
  const [first] = spendable
  if (!first) return { left, detail: '' }
  return {
    left,
    detail:
      spendable.length === 1
        ? `Expire ${when(first.expiresAt)}`
        : `${creditsText(first.left)} expire ${when(first.expiresAt)}`,
  }
}
