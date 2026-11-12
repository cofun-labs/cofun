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
/** The origin the tests reach the worker on, and so the origin of its admin page. */
const WORKER = 'http://localhost'
const DAY_MS = 24 * 60 * 60 * 1000
const CREDIT = 1_000_000
const START = new Date('2026-11-08T12:00:00Z')

let clock = START
let logged: string[] = []
let adminLog: string[] = []
const app = createApp({
  now: () => clock,
  logError: (line) => logged.push(line),
  logAdmin: (line) => adminLog.push(line),
})

let clerk: FakeClerk
let ai: FakeAiBinding
let db: FakeD1Database
let env: Env
/** An operator, signed in on the admin page. */
let admin: string
/** A user, signed in to the extension. */
let alice: string

beforeAll(async () => {
  clerk = await FakeClerk.create()
})

beforeEach(async () => {
  ai = new FakeAiBinding()
  logged = []
  adminLog = []
  clock = START
  env = {
    AI: ai,
    DB: (db = new FakeD1Database()),
    USAGE: new FakeUsageDataset(),
    MODEL,
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: `${EXT}, ${WORKER}`,
  }
  admin = await clerk.sessionToken({ userId: 'user_root', azp: WORKER, claims: { role: 'admin' } })
  alice = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
})

const json = (res: Response): Promise<any> => res.json()

function req(method: string, path: string, bearer?: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
  return app.request(path, init, env, new FakeExecutionContext())
}

const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms)
}
/** Every reply from now on costs this many credits. */
const repliesCost = (amount: number) => {
  ai.usage = usageCosting(amount)
}
const chat = (bearer: string) =>
  req('POST', '/v1/chat/completions', bearer, { messages: [{ role: 'user', content: 'hi' }] })
const lookUp = (userId: string, bearer = admin) => req('GET', `/v1/admin/accounts/${userId}`, bearer)
const grant = (userId: string, body: unknown, bearer = admin) =>
  req('POST', `/v1/admin/accounts/${userId}/grants`, bearer, body)
/** The account as an operator sees it. */
const account = async (userId: string) => {
  const res = await lookUp(userId)
  expect(res.status).toBe(200)
  return json(res)
}

describe("UC-ADMIN-001 Look at an account's credits and grant credits by hand", () => {
  it('[UC-ADMIN-001-S01] an operator sees an account’s balance and each of its grants', async () => {
    expect((await chat(alice)).status).toBe(200)
    expect(await account('user_alice')).toEqual({
      userId: 'user_alice',
      balance: 200 * CREDIT - FAKE_COST,
      debt: 0,
      grants: [
        {
          source: 'free',
          amount: 200 * CREDIT,
          left: 200 * CREDIT - FAKE_COST,
          grantedAt: START.getTime(),
          expiresAt: START.getTime() + 7 * DAY_MS,
        },
      ],
    })
  })

  it('[UC-ADMIN-001-S02] credits granted by hand can be spent, beside the weekly free credits, until they expire', async () => {
    // The user spends the whole free week and 10 credits more, and is out of credits.
    repliesCost(210)
    expect((await chat(alice)).status).toBe(200)
    expect((await chat(alice)).status).toBe(402)

    const res = await grant('user_alice', { credits: 100, days: 30 })
    expect(res.status).toBe(200)
    const granted = (await json(res)).grants[1]
    expect(granted).toEqual({
      source: 'manual',
      amount: 100 * CREDIT,
      left: 90 * CREDIT,
      grantedAt: START.getTime(),
      expiresAt: START.getTime() + 30 * DAY_MS,
      by: 'user_root',
    })

    repliesCost(60)
    expect((await chat(alice)).status).toBe(200)
    expect((await account('user_alice')).balance).toBe(30 * CREDIT)

    // A week later the free credits arrive as always, and are spent first: they expire first.
    later(7 * DAY_MS)
    expect((await chat(alice)).status).toBe(200)
    const { balance, grants } = await account('user_alice')
    expect(balance).toBe(170 * CREDIT)
    expect(grants.map((g: any) => [g.source, g.left / CREDIT])).toEqual([
      ['free', 0],
      ['manual', 30],
      ['free', 140],
    ])

    // Up to the moment they expire the granted credits count; after it they are gone.
    later(23 * DAY_MS - 1000)
    expect((await account('user_alice')).balance).toBe(30 * CREDIT)
    later(1000)
    expect((await account('user_alice')).balance).toBe(0)
    // Only the new free week is left to spend.
    repliesCost(210)
    expect((await chat(alice)).status).toBe(200)
    expect((await chat(alice)).status).toBe(402)
  })

  it('[UC-ADMIN-001-S03] someone who is not an operator is refused, whatever they ask for, and nothing changes', async () => {
    const strangers = [
      alice,
      // A role that is not the admin's, and values that only look like it.
      await clerk.sessionToken({ userId: 'user_eve', azp: WORKER, claims: { role: 'member' } }),
      await clerk.sessionToken({ userId: 'user_eve', azp: WORKER, claims: { role: 'Admin' } }),
      await clerk.sessionToken({ userId: 'user_eve', azp: WORKER, claims: { role: ['admin'] } }),
      await clerk.sessionToken({ userId: 'user_eve', azp: WORKER, claims: { role: null } }),
      await clerk.sessionToken({ userId: 'user_eve', azp: WORKER }),
      // An admin's session, but not one issued to the admin page.
      await clerk.sessionToken({ userId: 'user_root', azp: EXT, claims: { role: 'admin' } }),
      await clerk.sessionToken({ userId: 'user_root', claims: { role: 'admin' } }),
    ]
    for (const stranger of strangers) {
      const answers = [
        await lookUp('user_alice', stranger),
        await grant('user_alice', { credits: 100, days: 30 }, stranger),
        await grant('user_alice', { credits: -1 }, stranger),
        await lookUp('not a user id', stranger),
        await req('GET', '/v1/admin/nothing-here', stranger),
      ]
      for (const res of answers) {
        expect(res.status).toBe(403)
        expect(await json(res)).toEqual({ error: { code: 'forbidden', message: 'This account is not an admin.' } })
      }
    }
    expect((await account('user_alice')).grants).toEqual([])
    expect(adminLog).toEqual([])
  })

  it('[UC-ADMIN-001-S03] without a session nothing is shown', async () => {
    expect((await lookUp('user_alice', '')).status).toBe(401)
    expect((await grant('user_alice', { credits: 100, days: 30 }, '')).status).toBe(401)
  })

  it('[UC-ADMIN-001-S04] grants that have expired stay in the record and count for nothing', async () => {
    expect((await chat(alice)).status).toBe(200)
    await grant('user_alice', { credits: 10, days: 1 })
    later(8 * DAY_MS)
    const { balance, grants } = await account('user_alice')
    expect(balance).toBe(0)
    expect(grants.map((g: any) => [g.source, g.left])).toEqual([
      ['free', 200 * CREDIT - FAKE_COST],
      ['manual', 10 * CREDIT],
    ])
    // They are still there after the user's next week has begun.
    expect((await chat(alice)).status).toBe(200)
    expect((await account('user_alice')).grants).toHaveLength(3)
  })

  it('[UC-ADMIN-001-S05] what an account overspent is taken out of a grant first', async () => {
    repliesCost(150)
    await chat(alice)
    await chat(alice)
    expect(await account('user_alice')).toMatchObject({ balance: -100 * CREDIT, debt: 100 * CREDIT })

    await grant('user_alice', { credits: 300, days: 30 })
    const { balance, debt, grants } = await account('user_alice')
    expect({ balance, debt }).toEqual({ balance: 200 * CREDIT, debt: 0 })
    expect(grants[1]).toMatchObject({ source: 'manual', amount: 300 * CREDIT, left: 200 * CREDIT })
  })

  it('[UC-ADMIN-001-S06] looking up and granting leave the free week to start when the user next asks', async () => {
    // An account the worker has not seen has nothing, and looking at it gives it nothing.
    expect(await account('user_alice')).toEqual({ userId: 'user_alice', balance: 0, debt: 0, grants: [] })
    await grant('user_alice', { credits: 50, days: 30 })
    expect((await account('user_alice')).grants.map((g: any) => g.source)).toEqual(['manual'])

    later(3 * DAY_MS)
    expect((await chat(alice)).status).toBe(200)
    const { balance, grants } = await account('user_alice')
    // The whole free week, starting now, on top of what was granted.
    expect(grants[1]).toEqual({
      source: 'free',
      amount: 200 * CREDIT,
      left: 200 * CREDIT - FAKE_COST,
      grantedAt: clock.getTime(),
      expiresAt: clock.getTime() + 7 * DAY_MS,
    })
    expect(balance).toBe(250 * CREDIT - FAKE_COST)
  })

  it('[UC-ADMIN-001-S06] a grant by hand during the week does not move the next free credits', async () => {
    repliesCost(210)
    await chat(alice)
    later(2 * DAY_MS)
    await grant('user_alice', { credits: 40, days: 30 })
    repliesCost(30)
    await chat(alice)
    const refused = await chat(alice)
    expect(refused.status).toBe(402)
    // The week still ends 7 days after it began.
    expect((await json(refused)).error.message).toContain('2026-11-15 at 12:00 UTC')
  })

  it('[UC-ADMIN-001-S07] a grant beyond the limits is refused and the account does not change', async () => {
    const cases: [unknown, string][] = [
      [{ credits: 50_001, days: 30 }, 'credits must be a whole number from 1 to 50000'],
      [{ credits: 1_000_000, days: 30 }, 'credits must be a whole number from 1 to 50000'],
      [{ credits: 0, days: 30 }, 'credits must be a whole number from 1 to 50000'],
      [{ credits: -5, days: 30 }, 'credits must be a whole number from 1 to 50000'],
      [{ credits: 1.5, days: 30 }, 'credits must be a whole number from 1 to 50000'],
      [{ credits: '100', days: 30 }, 'credits must be a whole number from 1 to 50000'],
      [{ days: 30 }, 'credits must be a whole number from 1 to 50000'],
      [{ credits: 100, days: 367 }, 'days must be a whole number from 1 to 366'],
      [{ credits: 100, days: 0 }, 'days must be a whole number from 1 to 366'],
      [{ credits: 100 }, 'days must be a whole number from 1 to 366'],
      [[], 'body must be a JSON object'],
      [undefined, 'body must be a JSON object'],
    ]
    for (const [body, message] of cases) {
      const res = await grant('user_alice', body)
      expect(res.status).toBe(400)
      expect(await json(res)).toEqual({ error: { code: 'bad_request', message } })
    }
    expect((await account('user_alice')).grants).toEqual([])
    expect(adminLog).toEqual([])

    // The limits themselves are allowed.
    expect((await grant('user_alice', { credits: 50_000, days: 366 })).status).toBe(200)
    expect((await grant('user_alice', { credits: 1, days: 1 })).status).toBe(200)
  })
})

// Standalone tests: implementation behavior worth guarding, not product contract (see docs/bdd.md).
describe('admin API', () => {
  it('each grant by hand is logged: who granted, to whom, how much, until when', async () => {
    await grant('user_alice', { credits: 100, days: 30 })
    expect(adminLog).toEqual([
      'manual grant: admin=user_root user=user_alice credits=100 expires=2026-12-08T12:00:00.000Z',
    ])
    expect(logged).toEqual([])
  })

  it('looking up an account logs nothing', async () => {
    await account('user_alice')
    expect(adminLog).toEqual([])
  })

  it('a user id that is not shaped like one is refused', async () => {
    for (const id of ['alice', 'user_', 'user_a-b', 'org_abc', `user_${'a'.repeat(65)}`]) {
      const res = await lookUp(id)
      expect(res.status).toBe(400)
      expect((await json(res)).error.message).toBe('the user id must look like user_… (a Clerk user id)')
      expect((await grant(id, { credits: 100, days: 30 })).status).toBe(400)
    }
    expect(adminLog).toEqual([])
  })

  it('an unreachable database refuses the lookup and the grant, and nothing is logged as granted', async () => {
    db.failWith = new Error('D1_ERROR: Network connection lost.')
    const answers: [Response, string][] = [
      [await lookUp('user_alice'), 'Credits are unavailable, try again in a moment.'],
      // A grant that failed may have been written all the same: the admin is told to look, not to try again.
      [
        await grant('user_alice', { credits: 100, days: 30 }),
        'The grant may or may not have been made. Look the account up before granting again.',
      ],
    ]
    for (const [res, message] of answers) {
      expect(res.status).toBe(503)
      expect(await json(res)).toEqual({ error: { code: 'credits_unavailable', message } })
    }
    expect(adminLog).toEqual([])
    expect(logged).toEqual([
      'admin ledger call failed: Error: D1_ERROR: Network connection lost.',
      'admin ledger call failed: Error: D1_ERROR: Network connection lost.',
    ])
  })

  it('an admin session works from the origin the worker is reached on, whatever that is', async () => {
    const elsewhere = 'https://api.example'
    env.CLERK_AUTHORIZED_PARTIES = `${EXT}, ${WORKER}, ${elsewhere}`
    const token = await clerk.sessionToken({ userId: 'user_root', azp: elsewhere, claims: { role: 'admin' } })
    const headers = { authorization: `Bearer ${token}` }
    expect((await app.request(`${elsewhere}/v1/admin/accounts/user_alice`, { headers }, env)).status).toBe(200)
    // The same session is not an admin's on another origin of the worker.
    expect((await lookUp('user_alice', token)).status).toBe(403)
  })

  it('admin page loads Clerk with the publishable key, and cannot be framed', async () => {
    env.CLERK_PUBLISHABLE_KEY = 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk' // example.clerk.accounts.dev
    const res = await req('GET', '/admin')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    const html = await res.text()
    expect(html).toContain('data-clerk-publishable-key="pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk"')
    expect(html).toContain('src="https://example.clerk.accounts.dev/npm/@clerk/clerk-js@6/dist/clerk.browser.js"')
    // The form suggests 30 days, and Clerk's SDK telemetry is off as on the sign-in page.
    expect(html).toMatch(/<input id="days"[^>]* value="30"/)
    expect(/window\.Clerk\.load\(\{([^]*?)\}\)/.exec(html)?.[1]).toMatch(/^\s*telemetry: false,$/m)
  })

  it('admin page is off without a publishable key', async () => {
    expect((await req('GET', '/admin')).status).toBe(503)
  })
})
