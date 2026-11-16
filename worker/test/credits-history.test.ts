// The history of a user's own credits, the grants they were given, as the side panel reads it when
// the user opens it (GET /v1/credits/grants): tested through HTTP, with a clock the tests
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
/** How many grants the history holds at most. */
const HISTORY_LIMIT = 200

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
    API_LIMIT: new FakeRateLimiter(),
    WEB_LIMIT: new FakeRateLimiter(),
    RENDER_LIMIT: new FakeRateLimiter(),
    SEARCH_LIMIT: new FakeRateLimiter(),
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

const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms)
}

describe('UC-NOTICO-CHAT-003 the history of the credits a user was given, and UC-COFUN-CREDITS-002 read only one’s own', () => {
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
      // For the installed Notico 0.1.0, which reads the history a page at a time: there is no other page.
      next: null,
    })
  })

  it('[UC-NOTICO-CHAT-003-S10] a grant spent to the end is in the history', async () => {
    await ask(alice, 150)
    // 50 credits are left: the call goes ahead, and takes only those 50.
    await ask(alice, 150)
    later(WEEK_MS)
    await ask(alice, 30)

    expect((await get('/v1/credits/grants', alice)).grants).toEqual([
      // Nothing of the new week went to the call that cost more than was left.
      {
        source: 'free',
        amount: 200 * CREDIT,
        left: 170 * CREDIT,
        grantedAt: START + WEEK_MS,
        expiresAt: START + 2 * WEEK_MS,
      },
      { source: 'free', amount: 200 * CREDIT, left: 0, grantedAt: START, expiresAt: START + WEEK_MS },
    ])
  })

  it('[UC-NOTICO-CHAT-003-S10] every grant is read at once, newest first, up to a limit', async () => {
    // Grants told apart by their amounts: 20 given an hour apart, then the rest in the same millisecond.
    const given = HISTORY_LIMIT + 5
    for (let credits = 1; credits <= given; credits++) {
      await grant('user_alice', credits, 30)
      if (credits <= 20) later(HOUR_MS)
    }

    const { grants } = await get('/v1/credits/grants', alice)

    // Newest first; of grants given at the same moment, the one made last first. The 5 oldest are past the limit.
    expect(grants.map((g: any) => g.amount / CREDIT)).toEqual(
      Array.from({ length: HISTORY_LIMIT }, (_, i) => given - i),
    )
  })

  it('[@no-uc:money] a user who was given nothing and used nothing has an empty history, and reading it writes nothing', async () => {
    expect(await get('/v1/credits/grants', alice)).toEqual({ grants: [], next: null })
    // Looking at the history does not start the week of free credits.
    expect(db.rows('grants')).toEqual([])
    expect(db.rows('model_calls')).toEqual([])
  })

  it('[@no-uc:money] reading the history writes nothing, however often', async () => {
    await ask(alice, 60)
    const before = [db.rows('grants'), db.rows('model_calls')]

    later(WEEK_MS + HOUR_MS)
    await get('/v1/credits/grants', alice)
    await get('/v1/credits/grants', alice)

    expect([db.rows('grants'), db.rows('model_calls')]).toEqual(before)
  })

  it('[UC-COFUN-CREDITS-002-S01] a user sees only their own history', async () => {
    await grant('user_alice', 25, 30)
    await ask(alice, 150)
    await ask(bob, 30)
    later(40 * DAY_MS)
    await ask(bob, 6)

    const free = { source: 'free', amount: 200 * CREDIT }
    expect((await get('/v1/credits/grants', bob)).grants).toMatchObject([
      { ...free, left: 194 * CREDIT, grantedAt: START + 40 * DAY_MS },
      { ...free, left: 170 * CREDIT, grantedAt: START },
    ])

    // There is no way to name another account.
    expect((await get('/v1/credits/grants?user_id=user_alice', bob)).grants).toHaveLength(2)
    // Nobody's history without a session.
    expect((await req('GET', '/v1/credits/grants')).status).toBe(401)
  })

  it('[@no-uc:money] a history that cannot be read is reported as unavailable, and the failure is logged', async () => {
    db.failWith = new Error('D1_ERROR: Network connection lost.')

    const res = await req('GET', '/v1/credits/grants', alice)
    expect(res.status).toBe(503)
    expect(((await res.json()) as any).error.code).toBe('credits_unavailable')
    expect(logged).toEqual(['credit read failed: Error: D1_ERROR: Network connection lost.'])
  })

  it('[@no-uc:money] the history is read through an index, without sorting or reading the whole table', async () => {
    const plan = (sql: string, ...values: (string | number)[]) =>
      db.sqlite
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...values)
        .map((row) => String(row.detail))
        .join('; ')

    const grants = plan(
      `SELECT source FROM grants WHERE user_id = ? ORDER BY granted_at DESC, id DESC LIMIT ${HISTORY_LIMIT}`,
      'user_alice',
    )
    expect(grants).toContain('USING INDEX grants_by_user_granted (user_id=?)')
    expect(grants).not.toMatch(/TEMP B-TREE|SCAN/)
  })
})
