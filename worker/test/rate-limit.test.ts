// The default rate limit of /v1: every route there but the chat counts toward one limit per user,
// and a request over it is refused before anything is read or bought. The chat keeps its own limit
// (tested in api.test.ts) and the two never count toward each other.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type Env } from '../src/app'
import { FakeClerk } from './clerk'
import { FakeAiBinding, FakeD1Database, FakeExecutionContext, FakeRateLimiter, FakeUsageDataset, MODEL } from './fakes'
import { FakeStripe } from './stripe'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const CHAT = 'POST /v1/chat/completions'
const REFUSAL = { code: 'rate_limited', message: 'Too many requests. Wait a minute, then try again.' }

const app = createApp({ now: () => new Date('2026-11-14T12:00:00Z'), logError: () => {} })

let clerk: FakeClerk
let ai: FakeAiBinding
let db: FakeD1Database
let stripe: FakeStripe
let chatLimit: FakeRateLimiter
let env: Env
let alice: string
let bob: string

beforeAll(async () => {
  clerk = await FakeClerk.create()
})

beforeEach(async () => {
  env = {
    AI: (ai = new FakeAiBinding()),
    DB: (db = new FakeD1Database()),
    USAGE: new FakeUsageDataset(),
    CHAT_LIMIT: (chatLimit = new FakeRateLimiter()),
    API_LIMIT: new FakeRateLimiter(),
    MODEL,
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: EXT,
    STRIPE: (stripe = new FakeStripe()),
    CREDIT_PRICE: 'price_credits',
    CREDIT_PACKS: [1, 5],
  }
  alice = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
  bob = await clerk.sessionToken({ userId: 'user_bob', azp: EXT })
})

function req(method: string, path: string, bearer: string, body?: unknown) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
  return app.request(path, init, env, new FakeExecutionContext())
}

const chat = (bearer: string) =>
  req('POST', '/v1/chat/completions', bearer, { messages: [{ role: 'user', content: 'hi' }] })

/** The refusal `res` carries, which must be a 429. */
async function refusal(res: Response): Promise<unknown> {
  expect(res.status).toBe(429)
  const body: { error?: unknown } = await res.json()
  return body.error
}

/** From here on, the database and Stripe answer nothing: a request that reaches either fails. */
function nothingAnswers() {
  db.failWith = new Error('the database was read')
  stripe.failWith = new Error('Stripe was called')
}

describe('the default rate limit of /v1', () => {
  it('[UC-COFUN-CREDITS-002-S02] a user who reads their credits too often in a minute is told to wait, nothing is read, and others still read theirs', async () => {
    env.API_LIMIT = new FakeRateLimiter(3)
    expect((await req('GET', '/v1/credits', alice)).status).toBe(200)
    expect((await req('GET', '/v1/credits/grants', alice)).status).toBe(200)
    expect((await req('GET', '/v1/me', alice)).status).toBe(200)
    expect((await req('GET', '/v1/credits', bob)).status).toBe(200)

    nothingAnswers()
    expect(await refusal(await req('GET', '/v1/credits', alice))).toEqual(REFUSAL)
    expect(await refusal(await req('GET', '/v1/credits/grants', alice))).toEqual(REFUSAL)
    // Bob is under his own limit, so his read goes through to the database.
    expect((await req('GET', '/v1/credits', bob)).status).toBe(503)
  })

  it('[UC-COFUN-BILLING-001-S13] a user over the limit who chooses a pack is told to wait, and no payment page is made', async () => {
    env.API_LIMIT = new FakeRateLimiter(1)
    expect((await req('POST', '/v1/billing/checkout', alice, { quantity: 5 })).status).toBe(200)
    expect(await refusal(await req('POST', '/v1/billing/checkout', alice, { quantity: 5 }))).toEqual(REFUSAL)
    expect(stripe.sessions).toHaveLength(1)
    expect((await req('POST', '/v1/billing/checkout', bob, { quantity: 1 })).status).toBe(200)
  })

  it('[UC-COFUN-CREDITS-002-S03] asking the AI and reading credits do not count toward each other’s limit', async () => {
    // A question's model calls leave the whole default limit for the panel's reads.
    env.API_LIMIT = new FakeRateLimiter(1)
    for (let call = 0; call < 5; call++) expect((await chat(alice)).status).toBe(200)
    expect((await req('GET', '/v1/credits', alice)).status).toBe(200)
    // Over the default limit, the user can still ask.
    expect(await refusal(await req('GET', '/v1/credits', alice))).toEqual(REFUSAL)
    expect((await chat(alice)).status).toBe(200)
    expect(ai.calls).toHaveLength(6)
    // And the reads took nothing from the chat's limit.
    expect(chatLimit.keys).toHaveLength(6)
  })

  it('applies to every route under /v1 except the chat, before anything is read', async () => {
    env.API_LIMIT = new FakeRateLimiter(0)
    nothingAnswers()
    const routes = new Map<string, { method: string; path: string }>()
    for (const { method, path } of app.routes) {
      // Hono lists middleware as ALL.
      if (method !== 'ALL' && path.startsWith('/v1')) routes.set(`${method} ${path}`, { method, path })
    }
    expect([...routes.keys()]).toContain(CHAT)
    routes.delete(CHAT)
    expect(routes.size).toBeGreaterThanOrEqual(9)
    for (const { method, path } of routes.values()) {
      const res = await req(method, path.replace(/:\w+/g, 'user_alice'), alice)
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 429 })
    }
  })
})
