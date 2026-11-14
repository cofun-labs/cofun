// A user's own credits, as the side panel reads them (GET /v1/credits): tested through HTTP, with a
// clock the tests move and the worker's real SQL on SQLite.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type Env } from '../src/app'
import { FakeClerk } from './clerk'
import {
  FAKE_COST,
  FakeAiBinding,
  FakeD1Database,
  FakeExecutionContext,
  FakeUsageDataset,
  MODEL,
  usageCosting,
} from './fakes'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const START = Date.parse('2026-11-08T12:00:00Z')
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
/** A credit, in the micro-credits the worker answers in. */
const CREDIT = 1_000_000

let clock = new Date(START)
let logged: string[] = []
const app = createApp({ now: () => clock, logError: (line) => logged.push(line) })

let clerk: FakeClerk
let ai: FakeAiBinding
let db: FakeD1Database
let env: Env
let alice: string
let bob: string

beforeAll(async () => {
  clerk = await FakeClerk.create()
})

beforeEach(async () => {
  ai = new FakeAiBinding()
  logged = []
  clock = new Date(START)
  env = {
    AI: ai,
    DB: (db = new FakeD1Database()),
    USAGE: new FakeUsageDataset(),
    MODEL,
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: `${EXT}, http://localhost`,
  }
  alice = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
  bob = await clerk.sessionToken({ userId: 'user_bob', azp: EXT })
})

function req(method: string, path: string, bearer?: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
  return app.request(path, init, env, new FakeExecutionContext())
}

/** Asks the AI something; the reply costs `credits` (a multiple of 3, so its tokens come to exactly that). */
async function ask(bearer: string, credits?: number) {
  if (credits !== undefined) ai.usage = usageCosting(credits)
  return req('POST', '/v1/chat/completions', bearer, { messages: [{ role: 'user', content: 'hi' }] })
}

/** The user's credits as the worker reports them. */
async function credits(bearer: string, query = ''): Promise<any> {
  const res = await req('GET', `/v1/credits${query}`, bearer)
  expect(res.status).toBe(200)
  return res.json()
}

const at = (time: string) => {
  clock = new Date(time)
}
const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms)
}

describe('UC-NOTICO-CHAT-003 See credits, usage, and the plan', () => {
  it('[UC-NOTICO-CHAT-003-S01] a user who spent credits sees what is left, when it expires, and when the next free credits arrive', async () => {
    await ask(alice, 60)

    expect(await credits(alice)).toEqual({
      balance: 140 * CREDIT,
      free: { started: true, until: START + WEEK_MS },
      grants: [{ source: 'free', left: 140 * CREDIT, expiresAt: START + WEEK_MS }],
      usage: { days: 30, byDay: [{ day: '2026-11-08', microCredits: 60 * CREDIT }] },
    })
  })

  it('[UC-NOTICO-CHAT-003-S02] a new user sees the free credits as not started, nothing is written, and their first question starts with exactly that', async () => {
    const shown = await credits(alice)

    expect(shown).toEqual({
      balance: 200 * CREDIT,
      free: { started: false, toCome: 200 * CREDIT, lastsMs: WEEK_MS },
      grants: [],
      usage: { days: 30, byDay: [] },
    })
    expect(db.rows('grants')).toEqual([])
    expect(db.rows('model_calls')).toEqual([])

    // Looking did not start the week: it starts two days later, with the first question.
    later(2 * DAY_MS)
    expect((await ask(alice)).status).toBe(200)
    const after = await credits(alice)
    expect(after.balance).toBe(shown.balance - FAKE_COST)
    expect(after.free).toEqual({ started: true, until: START + 2 * DAY_MS + WEEK_MS })
  })

  it('[UC-NOTICO-CHAT-003-S02] a user whose week ended sees new free credits as not started, and the leftover is gone', async () => {
    await ask(alice, 60)
    later(WEEK_MS)

    const shown = await credits(alice)

    expect(shown).toMatchObject({
      balance: 200 * CREDIT,
      free: { started: false, toCome: 200 * CREDIT },
      grants: [],
    })
    expect(db.rows('grants')).toHaveLength(1)
    // The next question starts the new week with what was shown.
    await ask(alice, 30)
    expect((await credits(alice)).balance).toBe(shown.balance - 30 * CREDIT)
  })

  it('[UC-NOTICO-CHAT-003-S03] a user who overspent sees no credits left, and then the next free credits less what they owe', async () => {
    await ask(alice, 150)
    // 50 credits are left: the call goes ahead, and takes the balance 100 credits below zero.
    await ask(alice, 150)

    expect(await credits(alice)).toMatchObject({
      balance: -100 * CREDIT,
      free: { started: true, until: START + WEEK_MS },
      grants: [{ source: 'free', left: 0, expiresAt: START + WEEK_MS }],
    })

    later(WEEK_MS)
    const shown = await credits(alice)
    expect(shown).toMatchObject({ balance: 100 * CREDIT, free: { started: false, toCome: 100 * CREDIT }, grants: [] })

    // Exactly 100 credits to start with: a call that costs 90 goes ahead, one of 30 more ends them.
    expect((await ask(alice, 90)).status).toBe(200)
    expect((await credits(alice)).balance).toBe(shown.balance - 90 * CREDIT)
    expect((await ask(alice, 30)).status).toBe(200)
    expect((await ask(alice)).status).toBe(402)
  })

  it('[UC-NOTICO-CHAT-003-S02] credits granted by hand show beside free credits that have not started', async () => {
    const admin = await clerk.sessionToken({ userId: 'user_root', azp: 'http://localhost', claims: { role: 'admin' } })
    const grant = await req('POST', '/v1/admin/accounts/user_alice/grants', admin, { credits: 100, days: 30 })
    expect(grant.status).toBe(200)

    const shown = await credits(alice)

    expect(shown).toEqual({
      balance: 300 * CREDIT,
      free: { started: false, toCome: 200 * CREDIT, lastsMs: WEEK_MS },
      // Whose hand it was is not the user's to see.
      grants: [{ source: 'manual', left: 100 * CREDIT, expiresAt: START + 30 * DAY_MS }],
      usage: { days: 30, byDay: [] },
    })
    await ask(alice, 30)
    expect(await credits(alice)).toMatchObject({
      balance: 270 * CREDIT,
      grants: [
        { source: 'free', left: 170 * CREDIT, expiresAt: START + WEEK_MS },
        { source: 'manual', left: 100 * CREDIT, expiresAt: START + 30 * DAY_MS },
      ],
    })
  })

  it('[UC-NOTICO-CHAT-003-S04] usage is totalled per day, newest first, and a day is the day on the user’s own clock', async () => {
    at('2026-11-08T12:00:00Z')
    await ask(alice, 30)
    at('2026-11-08T23:30:00Z')
    await ask(alice, 60)
    at('2026-11-09T00:30:00Z')
    await ask(alice, 6)
    at('2026-11-10T09:00:00Z')

    // In UTC, 23:30 belongs to the 8th.
    expect((await credits(alice)).usage.byDay).toEqual([
      { day: '2026-11-09', microCredits: 6 * CREDIT },
      { day: '2026-11-08', microCredits: 90 * CREDIT },
    ])
    // An hour ahead of UTC, it is already the 9th.
    expect((await credits(alice, '?utc_offset=60')).usage.byDay).toEqual([
      { day: '2026-11-09', microCredits: 66 * CREDIT },
      { day: '2026-11-08', microCredits: 30 * CREDIT },
    ])
    // An hour behind, 00:30 on the 9th is still the 8th.
    expect((await credits(alice, '?utc_offset=-60')).usage.byDay).toEqual([
      { day: '2026-11-08', microCredits: 96 * CREDIT },
    ])
    // Offsets with half hours count too: at UTC+5:30, 23:30 and 00:30 are both on the 9th.
    expect((await credits(alice, '?utc_offset=330')).usage.byDay).toEqual([
      { day: '2026-11-09', microCredits: 66 * CREDIT },
      { day: '2026-11-08', microCredits: 30 * CREDIT },
    ])
  })

  it('[UC-NOTICO-CHAT-003-S04] usage covers the 30 most recent days of the user’s clock, today included', async () => {
    at('2026-11-08T23:30:00Z')
    await ask(alice, 30)
    at('2026-11-09T00:30:00Z')
    await ask(alice, 60)

    // 29 days after the 9th: in UTC the 8th has just dropped out.
    at('2026-12-08T12:00:00Z')
    expect((await credits(alice)).usage.byDay).toEqual([{ day: '2026-11-09', microCredits: 60 * CREDIT }])
    // An hour ahead of UTC, both calls were on the 9th, which is still in.
    expect((await credits(alice, '?utc_offset=60')).usage.byDay).toEqual([
      { day: '2026-11-09', microCredits: 90 * CREDIT },
    ])
    // The next day it is out, on either clock.
    at('2026-12-09T12:00:00Z')
    expect((await credits(alice)).usage.byDay).toEqual([])
    expect((await credits(alice, '?utc_offset=60')).usage.byDay).toEqual([])
  })

  it('[UC-NOTICO-CHAT-003-S05] a user sees only their own credits and usage', async () => {
    await ask(alice, 150)
    await ask(alice, 150)
    await ask(bob, 30)

    expect(await credits(bob)).toEqual({
      balance: 170 * CREDIT,
      free: { started: true, until: START + WEEK_MS },
      grants: [{ source: 'free', left: 170 * CREDIT, expiresAt: START + WEEK_MS }],
      usage: { days: 30, byDay: [{ day: '2026-11-08', microCredits: 30 * CREDIT }] },
    })
    expect(await credits(alice)).toMatchObject({
      balance: -100 * CREDIT,
      usage: { byDay: [{ day: '2026-11-08', microCredits: 300 * CREDIT }] },
    })
    // Nobody's credits without a session, and no way to name another account.
    expect((await req('GET', '/v1/credits')).status).toBe(401)
    expect(await credits(bob, '?user_id=user_alice')).toMatchObject({ balance: 170 * CREDIT })
  })

  it('reading credits writes nothing, however often', async () => {
    await ask(alice, 60)
    const before = [db.rows('grants'), db.rows('model_calls')]

    later(WEEK_MS + HOUR_MS)
    await credits(alice)
    await credits(alice, '?utc_offset=480')

    expect([db.rows('grants'), db.rows('model_calls')]).toEqual(before)
  })

  it('calls that cost nothing do not show as a day of usage', async () => {
    ai.failWith = new Error('capacity')
    expect((await ask(alice)).status).toBe(502)

    expect(db.rows('model_calls')).toHaveLength(1)
    expect((await credits(alice)).usage.byDay).toEqual([])
  })

  it('an offset that is not a whole number of minutes within a day is refused', async () => {
    for (const bad of ['abc', '1.5', '900', '-721', '', '1e2', '60&utc_offset=61']) {
      const res = await req('GET', `/v1/credits?utc_offset=${bad}`, alice)
      const body: any = await res.json()
      if (bad.includes('&')) {
        // The first value counts.
        expect(res.status).toBe(200)
        continue
      }
      expect([bad, res.status, body.error?.message]).toEqual([
        bad,
        400,
        'utc_offset must be a whole number of minutes from -720 to 840',
      ])
    }
    expect((await req('GET', '/v1/credits?utc_offset=840', alice)).status).toBe(200)
    expect((await req('GET', '/v1/credits?utc_offset=-720', alice)).status).toBe(200)
  })

  it('credits that cannot be read are reported as unavailable, and the failure is logged', async () => {
    db.failWith = new Error('D1_ERROR: Network connection lost.')

    const res = await req('GET', '/v1/credits', alice)

    expect(res.status).toBe(503)
    expect(((await res.json()) as any).error.code).toBe('credits_unavailable')
    expect(logged).toEqual(['credit read failed: Error: D1_ERROR: Network connection lost.'])
  })
})
