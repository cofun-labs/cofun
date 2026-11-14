// The history of a user's own credits, as the side panel reads it when the user opens it
// (GET /v1/credits/grants and GET /v1/credits/usage): tested through HTTP, with a clock the tests
// move and the worker's real SQL on SQLite.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type Env } from '../src/app'
import { FakeClerk } from './clerk'
import {
  FakeAiBinding,
  FakeD1Database,
  FakeExecutionContext,
  FakeUsageDataset,
  FakeRateLimiter,
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
/** How many grants one page holds. */
const PAGE = 20

let clock = new Date(START)
let logged: string[] = []
const app = createApp({ now: () => clock, logError: (line) => logged.push(line), logAdmin: () => {} })

let clerk: FakeClerk
let ai: FakeAiBinding
let db: FakeD1Database
let env: Env
let alice: string
let bob: string
let admin: string

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
    CHAT_LIMIT: new FakeRateLimiter(),
    MODEL,
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: `${EXT}, http://localhost`,
  }
  alice = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
  bob = await clerk.sessionToken({ userId: 'user_bob', azp: EXT })
  admin = await clerk.sessionToken({ userId: 'user_root', azp: 'http://localhost', claims: { role: 'admin' } })
})

function req(method: string, path: string, bearer?: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
  return app.request(path, init, env, new FakeExecutionContext())
}

/** Asks the AI something; the reply costs `credits` (a multiple of 3, so its tokens come to exactly that). */
async function ask(bearer: string, credits: number) {
  ai.usage = usageCosting(credits)
  const res = await req('POST', '/v1/chat/completions', bearer, { messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(200)
}

/** An operator grants `userId` credits by hand. */
async function grant(userId: string, credits: number, days: number) {
  const res = await req('POST', `/v1/admin/accounts/${userId}/grants`, admin, { credits, days })
  expect(res.status).toBe(200)
}

/** What a GET answers, which must be a success. */
async function get(path: string, bearer: string): Promise<any> {
  const res = await req('GET', path, bearer)
  expect(res.status).toBe(200)
  return res.json()
}

/** Every page of a user's grants, read to the end. */
async function allGrantPages(bearer: string): Promise<any[][]> {
  const pages = []
  let before: string | null = null
  do {
    const page = await get(`/v1/credits/grants${before ? `?before=${before}` : ''}`, bearer)
    pages.push(page.grants)
    before = page.next
  } while (before)
  return pages
}

const at = (time: string) => {
  clock = new Date(time)
}
const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms)
}

describe('UC-NOTICO-CHAT-003 the history of a user’s credits, and UC-COFUN-CREDITS-002 read only one’s own', () => {
  it('[UC-NOTICO-CHAT-003-S10] a user sees every grant they were given, newest first, with what went unspent of the expired ones', async () => {
    // Week one: 60 of the free credits are spent, and 140 expire unspent.
    await ask(alice, 60)
    // Week two: a new free week, and an hour later credits granted by hand for 30 days.
    later(WEEK_MS)
    await ask(alice, 30)
    later(HOUR_MS)
    await grant('user_alice', 100, 30)
    // Week three: the second free week has expired too, and the user has not come back.
    later(WEEK_MS)

    expect(await get('/v1/credits/grants', alice)).toEqual({
      grants: [
        // Whose hand it was is not the user's to see.
        {
          source: 'manual',
          amount: 100 * CREDIT,
          left: 100 * CREDIT,
          grantedAt: START + WEEK_MS + HOUR_MS,
          expiresAt: START + WEEK_MS + HOUR_MS + 30 * DAY_MS,
        },
        {
          source: 'free',
          amount: 200 * CREDIT,
          left: 170 * CREDIT,
          grantedAt: START + WEEK_MS,
          expiresAt: START + 2 * WEEK_MS,
        },
        { source: 'free', amount: 200 * CREDIT, left: 140 * CREDIT, grantedAt: START, expiresAt: START + WEEK_MS },
      ],
      next: null,
    })
  })

  it('[UC-NOTICO-CHAT-003-S10] a grant spent to the end, and one that paid back what was overspent, are in the history', async () => {
    await ask(alice, 150)
    // 50 credits are left: the call goes ahead, and overspends by 100.
    await ask(alice, 150)
    later(WEEK_MS)
    await ask(alice, 30)

    expect((await get('/v1/credits/grants', alice)).grants).toEqual([
      // 100 of the 200 paid back what was overspent, and 30 were spent.
      {
        source: 'free',
        amount: 200 * CREDIT,
        left: 70 * CREDIT,
        grantedAt: START + WEEK_MS,
        expiresAt: START + 2 * WEEK_MS,
      },
      { source: 'free', amount: 200 * CREDIT, left: 0, grantedAt: START, expiresAt: START + WEEK_MS },
    ])
  })

  it('[UC-NOTICO-CHAT-003-S10] grants are read a page at a time, to the end, each once and in order', async () => {
    // 45 grants, told apart by their amounts: 20 given an hour apart, then 25 in the same millisecond.
    for (let credits = 1; credits <= 45; credits++) {
      await grant('user_alice', credits, 30)
      if (credits <= 20) later(HOUR_MS)
    }

    const pages = await allGrantPages(alice)

    expect(pages.map((page) => page.length)).toEqual([PAGE, PAGE, 5])
    // Newest first; of grants given at the same moment, the one made last first.
    expect(pages.flat().map((g) => g.amount / CREDIT)).toEqual(Array.from({ length: 45 }, (_, i) => 45 - i))
  })

  it('a last page that is exactly full has nothing after it', async () => {
    for (let credits = 1; credits <= PAGE; credits++) await grant('user_alice', credits, 30)

    const page = await get('/v1/credits/grants', alice)

    expect(page.grants).toHaveLength(PAGE)
    expect(page.next).toBeNull()
  })

  it('a grant made while the user pages through the history does not shift the pages after it', async () => {
    for (let credits = 1; credits <= 25; credits++) await grant('user_alice', credits, 30)
    const first = await get('/v1/credits/grants', alice)

    later(HOUR_MS)
    await grant('user_alice', 99, 30)
    const second = await get(`/v1/credits/grants?before=${first.next}`, alice)

    expect(second.grants.map((g: any) => g.amount / CREDIT)).toEqual([5, 4, 3, 2, 1])
    expect(second.next).toBeNull()
  })

  it('[UC-NOTICO-CHAT-003-S11] a user reads the credits they used per day further back, a period at a time, to the end', async () => {
    at('2026-08-01T23:30:00Z')
    await ask(alice, 30)
    at('2026-08-02T00:30:00Z')
    await ask(alice, 60)
    at('2026-10-01T10:00:00Z')
    await ask(alice, 6)
    at('2026-11-08T12:00:00Z')
    await ask(alice, 30)
    at('2026-11-10T09:00:00Z')

    // The most recent period is the 30 days GET /v1/credits reports.
    const recent = await get('/v1/credits/usage', alice)
    expect(recent).toEqual({
      from: '2026-10-12',
      to: '2026-11-10',
      byDay: [{ day: '2026-11-08', microCredits: 30 * CREDIT }],
      // The day after the latest call before this period: the weeks without a call are skipped.
      earlier: '2026-10-02',
    })
    expect(recent.byDay).toEqual((await get('/v1/credits', alice)).usage.byDay)

    const october = await get(`/v1/credits/usage?before=${recent.earlier}`, alice)
    expect(october).toEqual({
      from: '2026-09-02',
      to: '2026-10-01',
      byDay: [{ day: '2026-10-01', microCredits: 6 * CREDIT }],
      earlier: '2026-08-03',
    })

    expect(await get(`/v1/credits/usage?before=${october.earlier}`, alice)).toEqual({
      from: '2026-07-04',
      to: '2026-08-02',
      byDay: [
        { day: '2026-08-02', microCredits: 60 * CREDIT },
        { day: '2026-08-01', microCredits: 30 * CREDIT },
      ],
      earlier: null,
    })
  })

  it('[UC-NOTICO-CHAT-003-S11] days further back are days on the user’s own clock too', async () => {
    at('2026-08-01T23:30:00Z')
    await ask(alice, 30)
    at('2026-08-02T00:30:00Z')
    await ask(alice, 60)
    at('2026-11-10T09:00:00Z')

    // An hour ahead of UTC, 23:30 on the 1st is already the 2nd.
    const ahead = await get('/v1/credits/usage?utc_offset=60', alice)
    expect(ahead.earlier).toBe('2026-08-03')
    expect((await get(`/v1/credits/usage?utc_offset=60&before=${ahead.earlier}`, alice)).byDay).toEqual([
      { day: '2026-08-02', microCredits: 90 * CREDIT },
    ])
    // An hour behind, 00:30 on the 2nd is still the 1st.
    const behind = await get('/v1/credits/usage?utc_offset=-60', alice)
    expect(behind.earlier).toBe('2026-08-02')
    expect(await get(`/v1/credits/usage?utc_offset=-60&before=${behind.earlier}`, alice)).toEqual({
      from: '2026-07-03',
      to: '2026-08-01',
      byDay: [{ day: '2026-08-01', microCredits: 90 * CREDIT }],
      earlier: null,
    })
  })

  it('a period ends the day before `before`, and each call falls in exactly one period', async () => {
    at('2026-10-11T23:59:59Z')
    await ask(alice, 30)
    at('2026-10-12T00:00:00Z')
    await ask(alice, 60)
    at('2026-11-10T09:00:00Z')

    // The most recent 30 days start on October 12.
    expect((await get('/v1/credits/usage', alice)).byDay).toEqual([{ day: '2026-10-12', microCredits: 60 * CREDIT }])
    expect((await get('/v1/credits/usage?before=2026-10-12', alice)).byDay).toEqual([
      { day: '2026-10-11', microCredits: 30 * CREDIT },
    ])
    // A period can end on any day.
    expect(await get('/v1/credits/usage?before=2026-10-13', alice)).toMatchObject({
      from: '2026-09-13',
      to: '2026-10-12',
      byDay: [
        { day: '2026-10-12', microCredits: 60 * CREDIT },
        { day: '2026-10-11', microCredits: 30 * CREDIT },
      ],
      earlier: null,
    })
  })

  it('a call that cost nothing can lead to a period with no usage', async () => {
    at('2026-08-01T10:00:00Z')
    ai.failWith = new Error('capacity')
    expect(
      (await req('POST', '/v1/chat/completions', alice, { messages: [{ role: 'user', content: 'hi' }] })).status,
    ).toBe(502)
    at('2026-11-10T09:00:00Z')

    const recent = await get('/v1/credits/usage', alice)
    expect(recent).toMatchObject({ byDay: [], earlier: '2026-08-02' })
    expect(await get(`/v1/credits/usage?before=${recent.earlier}`, alice)).toMatchObject({ byDay: [], earlier: null })
  })

  it('a user who was given nothing and used nothing has an empty history, and reading it writes nothing', async () => {
    expect(await get('/v1/credits/grants', alice)).toEqual({ grants: [], next: null })
    expect(await get('/v1/credits/usage', alice)).toEqual({
      from: '2026-10-10',
      to: '2026-11-08',
      byDay: [],
      earlier: null,
    })
    // Looking at the history does not start the week of free credits.
    expect(db.rows('grants')).toEqual([])
    expect(db.rows('model_calls')).toEqual([])
  })

  it('reading the history writes nothing, however often', async () => {
    await ask(alice, 60)
    const before = [db.rows('grants'), db.rows('model_calls')]

    later(WEEK_MS + HOUR_MS)
    await get('/v1/credits/grants', alice)
    await get('/v1/credits/usage?utc_offset=480', alice)
    await get('/v1/credits/usage?before=2026-11-01', alice)

    expect([db.rows('grants'), db.rows('model_calls')]).toEqual(before)
  })

  it('[UC-COFUN-CREDITS-002-S01] a user sees only their own history', async () => {
    for (let credits = 1; credits <= 25; credits++) await grant('user_alice', credits, 30)
    await ask(alice, 150)
    await ask(bob, 30)
    later(40 * DAY_MS)
    await ask(bob, 6)

    const free = { source: 'free', amount: 200 * CREDIT }
    expect((await get('/v1/credits/grants', bob)).grants).toMatchObject([
      { ...free, left: 194 * CREDIT, grantedAt: START + 40 * DAY_MS },
      { ...free, left: 170 * CREDIT, grantedAt: START },
    ])
    const usage = await get('/v1/credits/usage', bob)
    expect(usage).toMatchObject({ byDay: [{ day: '2026-12-18', microCredits: 6 * CREDIT }], earlier: '2026-11-09' })
    expect((await get(`/v1/credits/usage?before=${usage.earlier}`, bob)).byDay).toEqual([
      { day: '2026-11-08', microCredits: 30 * CREDIT },
    ])

    // A place in another user's history leads into the caller's own, and there is no way to name another account.
    const { next } = await get('/v1/credits/grants', alice)
    expect(next).not.toBeNull()
    // Alice's place is past her 20 newest grants of that moment; Bob has one, so nothing of his is left, and nothing of hers shows.
    expect(await get(`/v1/credits/grants?before=${next}`, bob)).toEqual({ grants: [], next: null })
    expect((await get('/v1/credits/grants?user_id=user_alice', bob)).grants).toHaveLength(2)
    expect((await get('/v1/credits/usage?user_id=user_alice', bob)).byDay).toEqual(usage.byDay)
    // Nobody's history without a session.
    expect((await req('GET', '/v1/credits/grants')).status).toBe(401)
    expect((await req('GET', '/v1/credits/usage')).status).toBe(401)
  })

  it('a place in the grants that no page gave is refused', async () => {
    for (const bad of ['abc', '', '12', '1.', '.1', '-1.0', '1.5.2', '1762603200000.12345', '1e3.0', '1762603200000']) {
      const res = await req('GET', `/v1/credits/grants?before=${bad}`, alice)
      const body: any = await res.json()
      expect([bad, res.status, body.error?.message]).toEqual([bad, 400, 'before must be the next of an earlier page'])
    }
    expect((await req('GET', '/v1/credits/grants?before=1762603200000.0', alice)).status).toBe(200)
  })

  it('a period of usage that does not end before a date, or an offset that is not one, is refused', async () => {
    for (const bad of ['abc', '', '2026-02-30', '2026-13-01', '1999-12-31', '20261108', '2026-11-08T00:00:00Z']) {
      const res = await req('GET', `/v1/credits/usage?before=${bad}`, alice)
      const body: any = await res.json()
      expect([bad, res.status, body.error?.message]).toEqual([bad, 400, 'before must be a date like 2026-11-12'])
    }
    for (const bad of ['abc', '1.5', '900', '-721']) {
      const res = await req('GET', `/v1/credits/usage?utc_offset=${bad}`, alice)
      const body: any = await res.json()
      expect([bad, res.status, body.error?.message]).toEqual([
        bad,
        400,
        'utc_offset must be a whole number of minutes from -720 to 840',
      ])
    }
    // A period that has not begun yet is empty, and leads back to the user's usage.
    await ask(alice, 30)
    expect(await get('/v1/credits/usage?before=2099-12-31&utc_offset=840', alice)).toMatchObject({
      byDay: [],
      earlier: '2026-11-10',
    })
  })

  it('a history that cannot be read is reported as unavailable, and the failure is logged', async () => {
    db.failWith = new Error('D1_ERROR: Network connection lost.')

    for (const path of ['/v1/credits/grants', '/v1/credits/usage']) {
      const res = await req('GET', path, alice)
      expect(res.status).toBe(503)
      expect(((await res.json()) as any).error.code).toBe('credits_unavailable')
    }
    expect(logged).toEqual(Array(2).fill('credit read failed: Error: D1_ERROR: Network connection lost.'))
  })

  it('each page of the history is read through an index, without sorting or reading the whole table', async () => {
    const plan = (sql: string, ...values: (string | number)[]) =>
      db.sqlite
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...values)
        .map((row) => String(row.detail))
        .join('; ')

    const grants = plan(
      `SELECT source FROM grants WHERE user_id = ? AND granted_at <= ? ORDER BY granted_at DESC, id DESC LIMIT 21 OFFSET ?`,
      'user_alice',
      START,
      0,
    )
    expect(grants).toContain('USING INDEX grants_by_user_granted (user_id=? AND granted_at<?)')
    expect(grants).not.toMatch(/TEMP B-TREE|SCAN/)

    const lastCall = plan(
      `SELECT max(started_at) AS at FROM model_calls WHERE user_id = ? AND started_at < ?`,
      'user_alice',
      START,
    )
    expect(lastCall).toContain('USING COVERING INDEX model_calls_by_user (user_id=? AND started_at<?)')
  })
})
