import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type Env } from '../src/app'
import { FakeClerk } from './clerk'
import {
  FAKE_COST,
  FAKE_USAGE,
  FakeAiBinding,
  FakeD1Database,
  FakeExecutionContext,
  FakeUsageDataset,
  MODEL,
  usageCosting,
} from './fakes'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
let clock = new Date('2026-11-08T12:00:00Z')
/** Every error line the worker logged in the current test. */
let logged: string[] = []
const app = createApp({ now: () => clock, logError: (line) => logged.push(line) })

let clerk: FakeClerk
let otherClerk: FakeClerk
let ai: FakeAiBinding
let db: FakeD1Database
let usage: FakeUsageDataset
let env: Env
let token: string

beforeAll(async () => {
  clerk = await FakeClerk.create()
  otherClerk = await FakeClerk.create()
})

beforeEach(async () => {
  ai = new FakeAiBinding()
  logged = []
  clock = new Date('2026-11-08T12:00:00Z')
  env = {
    AI: ai,
    DB: (db = new FakeD1Database()),
    USAGE: (usage = new FakeUsageDataset()),
    MODEL,
    AI_GATEWAY_ID: 'gw-test',
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: `${EXT}, https://notion-copilot.example`,
  }
  token = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
})

const json = (res: Response): Promise<any> => res.json()

function req(method: string, path: string, bearer?: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
  return app.request(path, init, env, new FakeExecutionContext())
}

const hi = [{ role: 'user', content: 'hi' }]
const chat = (bearer: string | undefined, body: unknown = { messages: hi }) =>
  req('POST', '/v1/chat/completions', bearer, body)

describe('UC-AUTH-001 Sign in to use Notico', () => {
  it('[UC-AUTH-001-S01] request without a session is refused', async () => {
    const res = await chat(undefined)
    expect(res.status).toBe(401)
    expect((await json(res)).error.code).toBe('unauthorized')
  })

  it('[UC-AUTH-001-S01] invalid, forged and expired sessions are refused', async () => {
    const forged = await otherClerk.sessionToken({ userId: 'user_eve', azp: EXT })
    const expired = await clerk.sessionToken({ userId: 'user_alice', azp: EXT, expiresInSec: -60 })
    for (const bad of ['not-a-jwt', forged, expired]) {
      expect((await chat(bad)).status).toBe(401)
    }
    expect(ai.calls).toHaveLength(0)
  })

  it('[UC-AUTH-001-S02] session issued to another site is refused', async () => {
    const elsewhere = await clerk.sessionToken({ userId: 'user_alice', azp: 'https://evil.example' })
    expect((await chat(elsewhere)).status).toBe(401)
  })
})

describe('UC-CHAT-001 Ask the AI from the side panel', () => {
  it('[UC-CHAT-001-S01] reply streams as server-sent events', async () => {
    const res = await chat(token, { messages: hi, stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const text = (await res.text())
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(6)).choices[0]?.delta.content ?? '')
      .join('')
    expect(text).toBe('Hello from Workers AI ')
  })

  it('[UC-CHAT-001-S02] asking for another model is refused', async () => {
    const res = await chat(token, { messages: hi, model: 'openai/gpt-5' })
    expect(res.status).toBe(400)
    expect((await json(res)).error.code).toBe('unsupported_model')
    expect(ai.calls).toHaveLength(0)
  })
})

// Standalone tests: implementation behavior worth guarding, not product contract (see docs/bdd.md).
describe('worker API', () => {
  it('GET /health needs no session (infrastructure)', async () => {
    expect((await req('GET', '/health')).status).toBe(200)
  })

  it('/v1/me returns the Clerk user id and model', async () => {
    const res = await req('GET', '/v1/me', token)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ userId: 'user_alice', model: MODEL })
  })

  it('a session from any allowed origin is accepted', async () => {
    const web = await clerk.sessionToken({ userId: 'user_alice', azp: 'https://notion-copilot.example' })
    expect((await chat(web)).status).toBe(200)
  })

  it('a session without an origin (Clerk Native API) is accepted', async () => {
    const native = await clerk.sessionToken({ userId: 'user_alice' })
    const res = await app.request('/v1/me', { headers: { authorization: `Bearer ${native}` } }, env)
    expect(res.status).toBe(200)
    expect((await json(res)).userId).toBe('user_alice')
  })

  it('API is off without the JWT key', async () => {
    env.CLERK_JWT_KEY = undefined
    const res = await chat(token)
    expect(res.status).toBe(503)
    expect((await json(res)).error.code).toBe('not_configured')
  })

  it('API is off without allowed origins', async () => {
    env.CLERK_AUTHORIZED_PARTIES = ''
    const res = await chat(token)
    expect(res.status).toBe(503)
    expect((await json(res)).error.code).toBe('not_configured')
  })

  it('extension origin passes CORS preflight', async () => {
    const res = await app.request(
      '/v1/chat/completions',
      { method: 'OPTIONS', headers: { origin: EXT, 'access-control-request-method': 'POST' } },
      env,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('sign-in page loads Clerk with the publishable key', async () => {
    env.CLERK_PUBLISHABLE_KEY = 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk' // example.clerk.accounts.dev
    const res = await req('GET', '/login')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(html).toContain('data-clerk-publishable-key="pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk"')
    expect(html).toContain('src="https://example.clerk.accounts.dev/npm/@clerk/clerk-js@6/dist/clerk.browser.js"')
    expect(html).toContain('src="https://example.clerk.accounts.dev/npm/@clerk/ui@1/dist/ui.browser.js"')
  })

  it("sign-in page loads Clerk from a production instance's Frontend API", async () => {
    // A production key: `clerk.example.com$` in base64, without the padding, as Clerk writes it.
    env.CLERK_PUBLISHABLE_KEY = 'pk_live_Y2xlcmsuZXhhbXBsZS5jb20k'
    let html = await (await req('GET', '/login')).text()
    expect(html).toContain('data-clerk-publishable-key="pk_live_Y2xlcmsuZXhhbXBsZS5jb20k"')
    expect(html).toContain('src="https://clerk.example.com/npm/@clerk/clerk-js@6/dist/clerk.browser.js"')
    // `clerk.sample.cc$` would end in `==`, which the key leaves out.
    env.CLERK_PUBLISHABLE_KEY = 'pk_live_Y2xlcmsuc2FtcGxlLmNjJA'
    html = await (await req('GET', '/login')).text()
    expect(html).toContain('src="https://clerk.sample.cc/npm/@clerk/ui@1/dist/ui.browser.js"')
  })

  it('sign-in page turns Clerk SDK telemetry off', async () => {
    env.CLERK_PUBLISHABLE_KEY = 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk'
    const html = await (await req('GET', '/login')).text()
    const options = /window\.Clerk\.load\(\{([^]*?)\}\)/.exec(html)?.[1]
    expect(options).toMatch(/^\s*telemetry: false,$/m)
  })

  it('root URL redirects to the sign-in page', async () => {
    const res = await req('GET', '/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('sign-in page is off without a publishable key', async () => {
    expect((await req('GET', '/login')).status).toBe(503)
  })

  it('non-streamed reply goes through the gateway tagged with the user', async () => {
    const res = await chat(token, { messages: hi, max_tokens: 50 })
    expect(res.status).toBe(200)
    expect((await json(res)).choices[0].message.content).toBe('Hello from Workers AI')
    expect(ai.calls[0]).toEqual({
      model: MODEL,
      inputs: { messages: hi, max_tokens: 50 },
      options: {
        gateway: {
          id: 'gw-test',
          collectLog: false,
          skipCache: true,
          metadata: { app: 'notico', user: 'user_alice' },
        },
      },
    })
  })

  it('without a gateway the model is called directly', async () => {
    env.AI_GATEWAY_ID = ''
    await chat(token)
    expect(ai.calls[0].options).toBeUndefined()
  })

  it('invalid bodies are rejected without calling the model', async () => {
    expect((await chat(token, { messages: [] })).status).toBe(400)
    expect((await chat(token, [1])).status).toBe(400)
    expect((await chat(token, { messages: [{ role: 'tool', content: 'x' }] })).status).toBe(400)
    expect((await chat(token, { messages: [{ role: 'user', content: 1 }] })).status).toBe(400)
    expect((await chat(token, { messages: [{ role: 'user', content: 'x'.repeat(200_001) }] })).status).toBe(400)
    expect((await chat(token, { messages: hi, max_tokens: 100_000 })).status).toBe(400)
    expect((await chat(token, { messages: hi, stream: 'false' })).status).toBe(400)
    expect(ai.calls).toHaveLength(0)
  })

  it('passes only role and content to the model, and defaults max_tokens when unset', async () => {
    await chat(token, { messages: [{ role: 'user', content: 'hi', name: 'x', extra: 1 }], max_tokens: null })
    expect(ai.calls[0].inputs).toEqual({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 16_384 })
  })

  it('naming the server model is allowed', async () => {
    expect((await chat(token, { messages: hi, model: MODEL })).status).toBe(200)
  })

  it('model failure returns 502', async () => {
    ai.failWith = new Error('capacity')
    const res = await chat(token)
    expect(res.status).toBe(502)
    const { error } = await json(res)
    expect(error.code).toBe('provider_error')
    expect(error.message).not.toContain('capacity')
  })
})

describe('UC-CHAT-001 credits', () => {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  /** Every reply from now on costs this many credits. A user starts with 200. */
  const repliesCost = (credits: number) => {
    ai.usage = usageCosting(credits)
  }
  const later = (ms: number) => {
    clock = new Date(clock.getTime() + ms)
  }
  const refused = async (res: Response) => {
    expect(res.status).toBe(402)
    const { error } = await json(res)
    expect(error.code).toBe('out_of_credits')
    return String(error.message)
  }

  it('[UC-CHAT-001-S09] a user with no credits left is refused, told when credits arrive, and the model is not called', async () => {
    repliesCost(150)
    expect((await chat(token)).status).toBe(200)
    // 50 credits are left: the call goes ahead, and takes the balance below zero.
    expect((await chat(token)).status).toBe(200)
    const message = await refused(await chat(token))
    // The week started with the first request, at 12:00 on 2026-11-08.
    expect(message).toBe('You have no credits left. Your next 200 free credits arrive on 2026-11-15 at 12:00 UTC.')
    expect(ai.calls).toHaveLength(2)
  })

  it('[UC-CHAT-001-S10] a new week brings new free credits', async () => {
    repliesCost(200)
    expect((await chat(token)).status).toBe(200)
    later(WEEK_MS - 1000)
    await refused(await chat(token))
    later(1000)
    expect((await chat(token)).status).toBe(200)
  })

  it('[UC-CHAT-001-S13] what a call overspent is taken out of the next free credits', async () => {
    repliesCost(150)
    await chat(token)
    await chat(token)
    await refused(await chat(token))
    // 100 credits overspent, so the new week has 100 to spend, not 200.
    later(WEEK_MS)
    repliesCost(90)
    expect((await chat(token)).status).toBe(200)
    repliesCost(20)
    expect((await chat(token)).status).toBe(200)
    expect(await refused(await chat(token))).toContain('2026-11-22 at 12:00 UTC')
  })

  it('[UC-CHAT-001-S14] credits left when the week ends are gone', async () => {
    repliesCost(50)
    await chat(token)
    // 150 credits were left. The new week has 200, not 350.
    later(WEEK_MS)
    repliesCost(150)
    expect((await chat(token)).status).toBe(200)
    expect((await chat(token)).status).toBe(200)
    await refused(await chat(token))
  })

  it('[UC-CHAT-001-S15] input read from the cache costs the cached price', async () => {
    // As the hosted model reported a second call with the same long prompt.
    ai.usage = { prompt_tokens: 5639, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 5568 } }
    await chat(token)
    await (await chat(token, { messages: hi, stream: true })).text()
    const cost = 71 * 300 + 5568 * 6 + 6 * 1200
    expect(records().map((r) => [r.promptTokens, r.cachedTokens, r.microCredits])).toEqual([
      [5639, 5568, cost],
      [5639, 5568, cost],
    ])
  })

  it('calls sent at once all start on the same balance, and what they overspent is owed', async () => {
    repliesCost(190)
    await chat(token)
    // 10 credits are left, and two replies that cost 190 each are written at once.
    const replies = [
      await chat(token, { messages: hi, stream: true }),
      await chat(token, { messages: hi, stream: true }),
    ]
    expect(replies.map((res) => res.status)).toEqual([200, 200])
    for (const res of replies) await res.text()
    // 370 credits overspent: the next week's 200 credits pay back part of it, and leave nothing to spend.
    later(WEEK_MS)
    await refused(await chat(token))
    expect(ai.calls).toHaveLength(3)
  })

  it('concurrent requests neither lose a charge nor grant a week twice', async () => {
    const replies = await Promise.all(Array.from({ length: 8 }, () => chat(token)))
    expect(replies.map((res) => res.status)).toEqual(Array(8).fill(200))
    await Promise.all(replies.map((res) => res.text()))
    expect(db.rows('grants')).toHaveLength(1)
    expect(db.rows('model_calls').map((r) => r.micro_credits)).toEqual(Array(8).fill(FAKE_COST))
    expect(db.rows('grants')[0]).toMatchObject({ amount: 200_000_000, left: 200_000_000 - 8 * FAKE_COST })
  })

  it('each model call leaves a record of how it ended, its tokens, and what it cost', async () => {
    ai.usage = { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 900 } }
    await chat(token)
    later(1000)
    await (await chat(token, { messages: hi, stream: true })).text()
    const call = {
      user_id: 'user_alice',
      model: MODEL,
      outcome: 'ok',
      finish_reason: 'stop',
      prompt_tokens: 1000,
      cached_tokens: 900,
      completion_tokens: 5,
      estimated: 0,
      micro_credits: 100 * 300 + 900 * 6 + 5 * 1200,
      owed: 0,
    }
    const start = Date.parse('2026-11-08T12:00:00Z')
    expect(db.rows('model_calls')).toEqual([
      { id: 1, ...call, started_at: start, ended_at: start, stream: 0 },
      { id: 2, ...call, started_at: start + 1000, ended_at: start + 1000, stream: 1 },
    ])
  })

  it('model calls that failed or cost nothing are recorded, and charge nothing', async () => {
    ai.failWith = new Error('capacity')
    await chat(token)
    ai.failWith = undefined
    ai.rawSse = ''
    await (await chat(token, { messages: hi, stream: true })).text()
    ai.rawSse = undefined
    ai.streamFailWith = new Error('connection reset')
    await (await chat(token, { messages: hi, stream: true })).text().catch(() => {})
    expect(db.rows('model_calls').map((r) => [r.outcome, r.stream, r.prompt_tokens, r.micro_credits])).toEqual([
      ['provider_error', 0, 0, 0],
      ['incomplete', 1, 0, 0],
      ['stream_error', 1, 0, 0],
    ])
    expect(db.rows('grants')[0]).toMatchObject({ left: 200_000_000 })
    // A request refused before the model was called is no model call.
    await chat(token, { messages: [] })
    expect(db.rows('model_calls')).toHaveLength(3)
  })

  it('a stream cut short is recorded with the estimate it was charged by', async () => {
    const res = await chat(token, { messages: hi, stream: true })
    const reader = res.body!.getReader()
    for (let i = 0; i < 5; i++) await reader.read()
    await reader.cancel()
    expect(db.rows('model_calls')).toEqual([
      expect.objectContaining({ outcome: 'cancelled', estimated: 1, prompt_tokens: 1, completion_tokens: 2 }),
    ])
  })

  it('the part of a cost the grants did not cover is recorded as owed, and the next grant pays it back', async () => {
    repliesCost(150)
    await chat(token)
    await chat(token)
    expect(db.rows('model_calls').map((r) => [r.micro_credits, r.owed])).toEqual([
      [150_000_000, 0],
      [150_000_000, 100_000_000],
    ])
    later(WEEK_MS)
    repliesCost(30)
    await chat(token)
    expect(db.rows('grants').map((r) => [r.source, r.amount, r.repaid, r.left])).toEqual([
      ['free', 200_000_000, 0, 0],
      ['free', 200_000_000, 100_000_000, 70_000_000],
    ])
  })

  it('grants and model calls of several users are kept apart in one database', async () => {
    const bob = await clerk.sessionToken({ userId: 'user_bob', azp: EXT })
    repliesCost(150)
    await chat(token)
    await chat(token)
    repliesCost(30)
    await chat(bob)
    expect(db.rows('grants').map((r) => [r.user_id, r.left])).toEqual([
      ['user_alice', 0],
      ['user_bob', 170_000_000],
    ])
    expect(db.rows('model_calls').map((r) => [r.user_id, r.owed])).toEqual([
      ['user_alice', 0],
      ['user_alice', 100_000_000],
      ['user_bob', 0],
    ])
    // Alice's debt is hers: Bob can still ask, and she cannot.
    await refused(await chat(token))
    expect((await chat(bob)).status).toBe(200)
  })

  it('a charge is taken from the grant that expires first, then from the next', async () => {
    repliesCost(150)
    await chat(token)
    // 50 credits are left of the free week; an admin grants 100 more, that expire after it.
    const admin = await clerk.sessionToken({ userId: 'user_root', azp: 'http://localhost', claims: { role: 'admin' } })
    env.CLERK_AUTHORIZED_PARTIES += ', http://localhost'
    expect((await req('POST', '/v1/admin/accounts/user_alice/grants', admin, { credits: 100, days: 30 })).status).toBe(
      200,
    )
    repliesCost(60)
    await chat(token)
    expect(db.rows('grants').map((r) => [r.source, r.left])).toEqual([
      ['free', 0],
      ['manual', 90_000_000],
    ])
  })

  it('a stream that ended before the client stopped reading is charged its totals, not an estimate', async () => {
    ai.usage = { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 900 } }
    const res = await chat(token, { messages: hi, stream: true })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('[DONE]\n')) text += decoder.decode((await reader.read()).value, { stream: true })
    await reader.cancel()
    expect(records()).toEqual([
      expect.objectContaining({
        outcome: 'cancelled',
        promptTokens: 1000,
        cachedTokens: 900,
        completionTokens: 5,
        microCredits: 100 * 300 + 900 * 6 + 5 * 1200,
      }),
    ])
  })

  it('a stream that breaks off before it reports or carries anything costs nothing', async () => {
    ai.rawSse = ''
    await (await chat(token, { messages: hi, stream: true })).text()
    ai.rawSse = undefined
    ai.streamFailWith = new Error('connection reset')
    await (await chat(token, { messages: hi, stream: true })).text().catch(() => {})
    expect(records().map((r) => [r.outcome, r.promptTokens, r.microCredits])).toEqual([
      ['incomplete', 0, 0],
      ['stream_error', 0, 0],
    ])
  })

  it('a call is charged what its tokens cost', async () => {
    await chat(token)
    expect(records()[0]).toMatchObject({ cachedTokens: 0, microCredits: FAKE_COST })
  })

  it('each user has their own credits', async () => {
    repliesCost(200)
    await chat(token)
    await refused(await chat(token))
    const bob = await clerk.sessionToken({ userId: 'user_bob', azp: EXT })
    expect((await chat(bob)).status).toBe(200)
  })

  it('a user who comes back after a month gets one grant, not one for each week away', async () => {
    repliesCost(150)
    await chat(token)
    later(30 * 24 * 60 * 60 * 1000)
    expect((await chat(token)).status).toBe(200)
    expect((await chat(token)).status).toBe(200)
    expect(await refused(await chat(token))).toContain('2026-12-15 at 12:00 UTC')
  })

  it('requests that are refused, and model calls that fail, cost nothing', async () => {
    repliesCost(200)
    await chat(undefined)
    await chat(token, { messages: [] })
    await chat(token, { messages: hi, model: 'other' })
    ai.failWith = new Error('capacity')
    expect((await chat(token)).status).toBe(502)
    ai.failWith = undefined
    expect(records().map((r) => r.microCredits)).toEqual([0, 0, 0])
    // All 200 credits are still there: one call goes ahead and uses them up.
    expect((await chat(token)).status).toBe(200)
    await refused(await chat(token))
  })

  it('a request stamped a little before the week began gets no second grant', async () => {
    repliesCost(200)
    await chat(token)
    // Another instance whose clock is a second behind.
    later(-1000)
    await refused(await chat(token))
  })

  it('a reply the user stops is charged an estimate of what it used', async () => {
    const res = await chat(token, { messages: hi, stream: true })
    const reader = res.body!.getReader()
    // 80 bytes: the first piece of the reply, "Hello ", and the start of the next.
    for (let i = 0; i < 5; i++) await reader.read()
    await reader.cancel()
    // No chunk reported the prompt, so it is estimated from the input: 2 characters, 1 token, of
    // which 90%, rounded down, counts as cached: none. The reply is estimated from the 6 characters
    // that were streamed: 2 tokens.
    expect(records()).toEqual([
      expect.objectContaining({
        outcome: 'cancelled',
        promptTokens: 1,
        cachedTokens: 0,
        completionTokens: 2,
        microCredits: 300 + 2 * 1200,
      }),
    ])
  })

  it('a stream cut short is charged the prompt it reported, 90% of it as cached, and the reply by its size', async () => {
    // Workers AI gives the prompt in its first chunk; how much of it was cached only comes at the end.
    ai.rawSse =
      'data: {"choices":[{"delta":{"content":""}}],"usage":{"prompt_tokens":1000,"completion_tokens":0}}\n\n' +
      'data: {"choices":[{"delta":{"content":"abcdef","reasoning_content":"ghi"}}],"usage":{"prompt_tokens":0,"completion_tokens":2}}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"abc","arguments":"{}x"}}]}}]}\n\n'
    await (await chat(token, { messages: hi, stream: true })).text()
    expect(records()[0]).toMatchObject({
      outcome: 'incomplete',
      promptTokens: 1000,
      cachedTokens: 900,
      completionTokens: 5,
      microCredits: 100 * 300 + 900 * 6 + 5 * 1200,
    })
  })

  it('a stream that carries a model error and no usage costs nothing', async () => {
    ai.rawSse = 'data: {"error":{"message":"model overloaded"}}\n\n'
    await (await chat(token, { messages: hi, stream: true })).text()
    expect(records()[0]).toMatchObject({ outcome: 'provider_error', microCredits: 0 })
  })

  it('an unreachable database refuses the request without calling the model', async () => {
    db.failWith = new Error('D1_ERROR: Network connection lost.')
    const res = await chat(token)
    expect(res.status).toBe(503)
    const { error } = await json(res)
    expect(error.code).toBe('credits_unavailable')
    expect(error.message).not.toContain('D1_ERROR')
    expect(logged).toEqual(['credit check failed: Error: D1_ERROR: Network connection lost.'])
    expect(ai.calls).toHaveLength(0)
  })

  it('a model call whose record fails still sends the reply, is not charged, and the usage record says so', async () => {
    db.failOn = { sql: 'INSERT INTO model_calls', error: new Error('D1_ERROR: Network connection lost.') }
    expect((await chat(token)).status).toBe(200)
    expect(await (await chat(token, { messages: hi, stream: true })).text()).toContain('[DONE]')
    expect(records().map((r) => [r.outcome, r.microCredits])).toEqual([
      ['ok', 0],
      ['ok', 0],
    ])
    expect(db.rows('grants')[0]).toMatchObject({ left: 200_000_000 })
    expect(logged).toEqual(Array(2).fill('model call record failed: Error: D1_ERROR: Network connection lost.'))
  })

  it('a model with no price is a configuration error, not a free call', async () => {
    env.MODEL = '@cf/test/unpriced'
    const res = await chat(token)
    expect(res.status).toBe(503)
    expect((await json(res)).error.code).toBe('not_configured')
    expect(ai.calls).toHaveLength(0)
  })
})

/** Reads a usage data point back into named fields, following the layout in src/usage.ts. */
function usageRecord(point: FakeUsageDataset['points'][number]) {
  const [userId] = point.indexes ?? []
  const [model, outcome, finishReason, mode] = point.blobs ?? []
  const [messages, inputChars, promptTokens, completionTokens, durationMs, cachedTokens, microCredits] =
    point.doubles ?? []
  return {
    userId,
    model,
    outcome,
    finishReason,
    mode,
    messages,
    inputChars,
    promptTokens,
    completionTokens,
    durationMs,
    cachedTokens,
    microCredits,
  }
}
const records = () => usage.points.map(usageRecord)

describe("UC-CHAT-002 Keep a record of each user's chat usage", () => {
  const two = [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hello' },
  ]

  it('[UC-CHAT-002-S01] a streamed reply leaves a record with its token counts', async () => {
    const res = await chat(token, { messages: two, stream: true })
    expect(res.status).toBe(200)
    await res.text()
    expect(records()).toEqual([
      {
        userId: 'user_alice',
        model: MODEL,
        outcome: 'ok',
        finishReason: 'stop',
        mode: 'stream',
        messages: 2,
        inputChars: 13,
        promptTokens: FAKE_USAGE.prompt_tokens,
        completionTokens: FAKE_USAGE.completion_tokens,
        durationMs: expect.any(Number),
        cachedTokens: 0,
        microCredits: FAKE_COST,
      },
    ])
    expect(records()[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(ai.calls[0].inputs.stream_options).toEqual({ include_usage: true })
  })

  it('[UC-CHAT-002-S01] a non-streamed reply leaves a record with its token counts', async () => {
    expect((await chat(token, { messages: two })).status).toBe(200)
    expect(records()).toEqual([
      expect.objectContaining({
        userId: 'user_alice',
        outcome: 'ok',
        finishReason: 'stop',
        mode: 'sync',
        messages: 2,
        inputChars: 13,
        promptTokens: FAKE_USAGE.prompt_tokens,
        completionTokens: FAKE_USAGE.completion_tokens,
        microCredits: FAKE_COST,
      }),
    ])
  })

  it('[UC-CHAT-002-S02] refused and failed requests leave a record of how they ended', async () => {
    await chat(token, { messages: [] })
    ai.failWith = new Error('capacity')
    await chat(token)
    ai.failWith = undefined
    ai.usage = usageCosting(200)
    await chat(token)
    await chat(token)
    db.failWith = new Error('D1_ERROR: Network connection lost.')
    await chat(token)
    expect(records().map((r) => r.outcome)).toEqual([
      'bad_request',
      'provider_error',
      'ok',
      'out_of_credits',
      'credits_unavailable',
    ])
    expect(records().every((r) => r.userId === 'user_alice')).toBe(true)
  })

  it('[UC-CHAT-002-S02] a stream that breaks off leaves a record of how it ended', async () => {
    ai.streamFailWith = new Error('connection reset')
    const res = await chat(token, { messages: hi, stream: true })
    await expect(res.text()).rejects.toThrow('the model stream failed')
    expect(records().map((r) => r.outcome)).toEqual(['stream_error'])
  })

  it('[UC-CHAT-002-S02] a stream that ends early without an error is recorded as incomplete', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n'
    ai.rawSse = sse
    expect(await (await chat(token, { messages: hi, stream: true })).text()).toBe(sse)
    expect(records().map((r) => r.outcome)).toEqual(['incomplete'])
  })

  it('[UC-CHAT-002-S03] nothing users wrote or the AI replied is kept', async () => {
    const SECRET = 'zebra-7f3a-confidential'
    ai = env.AI = new FakeAiBinding(`reply ${SECRET}-reply`)
    const messages = [
      { role: 'system', content: `system ${SECRET}-system` },
      { role: 'user', content: `page ${SECRET}-user` },
      { role: 'assistant', content: `earlier ${SECRET}-assistant` },
    ]
    await (await chat(token, { messages, stream: true })).text()
    await chat(token, { messages })
    await chat(token, { messages, model: `${SECRET}-model` })
    expect(records()).toHaveLength(3)
    expect(JSON.stringify(usage.points)).not.toContain(SECRET)
    // The gateway is told not to keep prompts and replies in its logs or its cache.
    expect(
      ai.calls.every((call) => {
        const gateway = call.options?.gateway as { collectLog?: boolean; skipCache?: boolean } | undefined
        return gateway?.collectLog === false && gateway.skipCache === true
      }),
    ).toBe(true)
  })
})

// Standalone tests for what the worker writes to its logs when a request fails.
describe('error logs', () => {
  const SECRET = 'zebra-7f3a-confidential'
  const messages = [{ role: 'user', content: `page ${SECRET}` }]

  /** An error as a provider might return it: the request quoted past the start of the message, and in other fields. */
  function quotingError() {
    const err = new Error(`${'x'.repeat(200)} while reading ${JSON.stringify(messages)}`, {
      cause: new Error(`cause ${SECRET}`),
    })
    return Object.assign(err, { request: { messages } })
  }

  it('a failed model call logs only the name and the start of the message', async () => {
    const err = (ai.failWith = quotingError())
    err.name = 'ProviderError'
    expect((await chat(token, { messages })).status).toBe(502)
    expect(logged).toEqual([`model call failed: ProviderError: ${'x'.repeat(200)}`])
    expect(logged.join()).not.toContain(SECRET)
  })

  it('an unexpected error logs only the name and the start of the message', async () => {
    env.AI = {
      async run() {
        return {
          toJSON() {
            throw quotingError()
          },
        }
      },
    }
    expect((await chat(token, { messages })).status).toBe(500)
    expect(logged).toEqual([`request failed: Error: ${'x'.repeat(200)}`])
    expect(logged.join()).not.toContain(SECRET)
  })

  it('a stream that fails partway logs the same summary and ends with an error that quotes nothing', async () => {
    ai.streamFailWith = quotingError()
    const res = await chat(token, { messages, stream: true })
    const failure: unknown = await res.text().catch((err: unknown) => err)
    expect(String(failure)).toBe('Error: the model stream failed')
    expect(Object.keys(Object(failure))).toEqual([])
    expect(Object(failure).cause).toBeUndefined()
    expect(logged).toEqual([`model stream failed: Error: ${'x'.repeat(200)}`])
  })

  it('a long error name is cut too', async () => {
    const err = (ai.failWith = new Error('capacity'))
    err.name = `${'n'.repeat(60)}${SECRET}`
    await chat(token, { messages })
    expect(logged).toEqual([`model call failed: ${'n'.repeat(60)}: capacity`])
  })

  it('a thrown value that is not an error logs only its type', async () => {
    env.AI = {
      async run() {
        throw { message: `quoted ${SECRET}` }
      },
    }
    expect((await chat(token, { messages })).status).toBe(502)
    expect(logged).toEqual(['model call failed: non-error value of type object'])
  })

  it('a request that is refused logs nothing', async () => {
    expect((await chat(undefined, { messages })).status).toBe(401)
    expect((await chat(token, { messages: [] })).status).toBe(400)
    expect(logged).toEqual([])
  })
})

// Standalone tests for usage records.
describe('usage records', () => {
  it('a stream that carries a model error is recorded as provider_error', async () => {
    ai.rawSse = 'data: {"error":{"message":"model overloaded"}}\n\ndata: [DONE]\n\n'
    await (await chat(token, { messages: hi, stream: true })).text()
    expect(records().map((r) => r.outcome)).toEqual(['provider_error'])
  })

  it('a reply that cannot be sent is recorded once', async () => {
    env.AI = {
      async run() {
        return { usage: { prompt_tokens: 1n } }
      },
    }
    expect((await chat(token)).status).toBe(500)
    expect(records().map((r) => r.outcome)).toEqual(['internal'])
  })

  it('requests that fail auth leave no record', async () => {
    await chat(undefined)
    await chat('not-a-jwt')
    expect(usage.points).toHaveLength(0)
  })

  it('a stream the client cancels is recorded as cancelled', async () => {
    const res = await chat(token, { messages: hi, stream: true })
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    expect(records().map((r) => r.outcome)).toEqual(['cancelled'])
  })

  it('the stream reaches the client unchanged', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n'
    ai.rawSse = sse
    expect(await (await chat(token, { messages: hi, stream: true })).text()).toBe(sse)
    expect(records()[0]).toMatchObject({ outcome: 'ok', promptTokens: 0, completionTokens: 0, finishReason: '' })
  })

  it('reads the totals from a Workers AI stream with per-chunk usage', async () => {
    // Shape recorded from the production model: per-chunk usage, a zeroed chunk, then the totals.
    const usageOf = (p: number, c: number) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c })
    ai.rawSse = [
      { choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }], usage: usageOf(0, 2) },
      { choices: [{ index: 0, delta: { content: '!' }, finish_reason: 'length' }], usage: usageOf(0, 4) },
      { choices: [], usage: usageOf(0, 0) },
      { response: '', usage: usageOf(36, 30) },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join('')
      .concat('data: [DONE]\n\n')
    await (await chat(token, { messages: hi, stream: true })).text()
    expect(records()[0]).toMatchObject({
      outcome: 'ok',
      finishReason: 'length',
      promptTokens: 36,
      completionTokens: 30,
    })
  })

  it('unknown finish reasons and malformed token counts are not copied into records', async () => {
    ai.rawSse =
      'data: {"choices":[{"delta":{},"finish_reason":"free text"}],"usage":{"prompt_tokens":"9","completion_tokens":-1}}\n\ndata: [DONE]\n\n'
    await (await chat(token, { messages: hi, stream: true })).text()
    expect(records()[0]).toMatchObject({ finishReason: 'other', promptTokens: 0, completionTokens: 0 })
  })

  it('non-object events in the stream are passed through and skipped', async () => {
    const sse = 'data: null\n\ndata: 3\n\ndata: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n'
    ai.rawSse = sse
    expect(await (await chat(token, { messages: hi, stream: true })).text()).toBe(sse)
    expect(records().map((r) => r.outcome)).toEqual(['ok'])
  })

  it('reads the fields of a reply loosely: a field of another shape counts as missing', async () => {
    const replies: [unknown, Record<string, unknown>][] = [
      [
        { choices: { 0: { finish_reason: 'length' } }, usage: [] },
        { finishReason: 'length', promptTokens: 0 },
      ],
      [
        { choices: 'stop', usage: 'x' },
        { finishReason: '', promptTokens: 0 },
      ],
      [
        { choices: [null, { finish_reason: 'stop' }], usage: { prompt_tokens: 7 } },
        { finishReason: '', promptTokens: 7 },
      ],
      [['stop'], { finishReason: '', promptTokens: 0 }],
    ]
    for (const [reply, recorded] of replies) {
      env.USAGE = usage = new FakeUsageDataset()
      env.AI = {
        async run() {
          return reply
        },
      }
      const res = await chat(token)
      // The reply itself goes to the client as the model gave it.
      expect([res.status, await json(res)]).toEqual([200, reply])
      expect(records()[0]).toMatchObject({ outcome: 'ok', ...recorded })
    }
  })

  it('a non-streamed reply without usage is still recorded', async () => {
    env.AI = {
      async run() {
        return null
      },
    }
    expect((await chat(token)).status).toBe(200)
    expect(records()[0]).toMatchObject({ outcome: 'ok', promptTokens: 0, completionTokens: 0, finishReason: '' })
  })

  it('a streamed request refused before the model is called is recorded as streamed', async () => {
    await chat(token, { messages: [], stream: true })
    await chat(token, { messages: hi, max_tokens: 100_000, stream: true })
    expect(records().map((r) => [r.outcome, r.mode])).toEqual([
      ['bad_request', 'stream'],
      ['bad_request', 'stream'],
    ])
  })

  it('a failing usage dataset does not fail the request', async () => {
    env.USAGE = {
      writeDataPoint() {
        throw new Error('dataset unavailable')
      },
    }
    expect((await chat(token)).status).toBe(200)
  })
})

const pageTool = {
  type: 'function',
  function: {
    name: 'get_current_page',
    description: 'Returns the title and URL of the Notion page open in the current tab.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
}
const searchTool = {
  type: 'function',
  function: {
    name: 'search_pages',
    description: 'Searches Notion pages by keyword.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
}
const tools = [pageTool, searchTool]
const askPage = [{ role: 'user', content: 'Which Notion page am I on?' }]
/** The conversation after the extension ran get_current_page. */
const withToolResult = (result: string) => [
  ...askPage,
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_current_page', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'call_1', content: result },
]

/** Reads a streamed reply back the way an OpenAI client does: text, tool calls by index, and the finish reason. */
async function readStream(res: Response) {
  let text = ''
  let finishReason: string | undefined
  const calls: { id?: string; name?: string; arguments: string }[] = []
  for (const event of (await res.text()).split('\n\n')) {
    if (!event.startsWith('data: ') || event === 'data: [DONE]') continue
    const choice = JSON.parse(event.slice(6)).choices?.[0]
    if (!choice) continue
    text += choice.delta?.content ?? ''
    for (const d of choice.delta?.tool_calls ?? []) {
      const call = (calls[d.index] ??= { arguments: '' })
      if (d.id) call.id = d.id
      if (d.function?.name) call.name = d.function.name
      call.arguments += d.function?.arguments ?? ''
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }
  return { text, calls, finishReason }
}

describe('UC-AGENT-001 Ask the AI something that needs a tool', () => {
  it('[UC-AGENT-001-S01] the streamed reply asks the extension to run tools, with their arguments', async () => {
    ai = env.AI = new FakeAiBinding("I'll check.")
    ai.toolCalls = [
      { name: 'get_current_page', arguments: '{}' },
      { name: 'search_pages', arguments: '{"query": "quarterly planning"}' },
    ]
    const res = await chat(token, { messages: askPage, tools, stream: true })
    expect(res.status).toBe(200)
    const reply = await readStream(res)
    expect(reply.finishReason).toBe('tool_calls')
    expect(reply.calls).toEqual([
      { id: 'chatcmpl-tool-0', name: 'get_current_page', arguments: '{}' },
      { id: 'chatcmpl-tool-1', name: 'search_pages', arguments: '{"query": "quarterly planning"}' },
    ])
    expect(JSON.parse(reply.calls[1].arguments)).toEqual({ query: 'quarterly planning' })
    // The model was offered the extension's tools.
    expect(ai.calls[0].inputs.tools).toEqual(tools)
  })

  it('[UC-AGENT-001-S01] the non-streamed reply asks the extension to run a tool', async () => {
    ai.toolCalls = [{ name: 'get_current_page', arguments: '{}' }]
    const res = await chat(token, { messages: askPage, tools })
    expect(res.status).toBe(200)
    const { choices } = await json(res)
    expect(choices[0].finish_reason).toBe('tool_calls')
    expect(choices[0].message.tool_calls).toEqual([
      { id: 'chatcmpl-tool-0', type: 'function', function: { name: 'get_current_page', arguments: '{}' } },
    ])
  })

  it('[UC-AGENT-001-S02] the AI answers from the tool result the extension sends back', async () => {
    ai = env.AI = new FakeAiBinding('You are on Q4 Roadmap')
    const result = JSON.stringify({ title: 'Q4 Roadmap', url: 'https://www.notion.so/Q4-Roadmap-abc123' })
    const res = await chat(token, { messages: withToolResult(result), tools, stream: true })
    expect(res.status).toBe(200)
    expect((await readStream(res)).text).toBe('You are on Q4 Roadmap ')
    // The model got the whole exchange: the question, its own tool call, and the result.
    expect(ai.calls[0].inputs.messages).toEqual([
      ...askPage,
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_current_page', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: result },
    ])
  })

  it('[UC-AGENT-001-S03] nothing in tool definitions, calls, or results is kept', async () => {
    const SECRET = 'okapi-91c2-confidential'
    ai = env.AI = new FakeAiBinding(`checking ${SECRET}-preamble`)
    ai.toolCalls = [{ name: 'search_pages', arguments: JSON.stringify({ query: `${SECRET}-arguments` }) }]
    const secretTools = [
      {
        type: 'function',
        function: {
          name: 'search_pages',
          description: `${SECRET}-description`,
          parameters: { type: 'object', properties: { [`${SECRET}-param`]: { type: 'string' } } },
        },
      },
    ]
    const messages = [
      { role: 'user', content: `find ${SECRET}-user` },
      {
        role: 'assistant',
        content: `${SECRET}-assistant`,
        tool_calls: [
          { id: `${SECRET}-id`, type: 'function', function: { name: 'search_pages', arguments: `"${SECRET}-args"` } },
        ],
      },
      { role: 'tool', tool_call_id: `${SECRET}-id`, content: `${SECRET}-result` },
    ]
    await (await chat(token, { messages, tools: secretTools, stream: true })).text()
    await chat(token, { messages, tools: secretTools })
    expect(records()).toHaveLength(2)
    expect(records().map((r) => r.finishReason)).toEqual(['tool_calls', 'tool_calls'])
    expect(JSON.stringify(usage.points)).not.toContain(SECRET)
    expect(
      ai.calls.every((call) => {
        const gateway = call.options?.gateway as { collectLog?: boolean; skipCache?: boolean } | undefined
        return gateway?.collectLog === false && gateway.skipCache === true
      }),
    ).toBe(true)
  })
})

describe('tool calling', () => {
  it('a streamed tool call leaves a record with its totals and finish reason', async () => {
    ai.toolCalls = [{ name: 'get_current_page', arguments: '{}' }]
    await (await chat(token, { messages: askPage, tools, stream: true })).text()
    expect(records()).toEqual([
      expect.objectContaining({
        outcome: 'ok',
        finishReason: 'tool_calls',
        promptTokens: FAKE_USAGE.prompt_tokens,
        completionTokens: FAKE_USAGE.completion_tokens,
      }),
    ])
  })

  it('tool definitions and tool calls count toward the size limit and the record', async () => {
    await chat(token, { messages: withToolResult('{"title":"x"}'), tools: [pageTool] })
    const { inputChars } = records()[0]
    const toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'get_current_page', arguments: '{}' } }]
    const result = '{"title":"x"}'
    expect(inputChars).toBe(
      askPage[0].content.length +
        JSON.stringify(toolCalls).length +
        'call_1'.length +
        result.length +
        JSON.stringify([pageTool]).length,
    )

    const big = 'x'.repeat(200_001)
    const tooBig = [
      { messages: askPage, tools: [{ type: 'function', function: { name: 'f', description: big } }] },
      {
        messages: [
          ...askPage,
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: big } }],
          },
          { role: 'tool', tool_call_id: 'c', content: '{}' },
        ],
      },
      { messages: [...withToolResult(big)] },
    ]
    for (const body of tooBig) expect((await chat(token, body)).status).toBe(400)
    expect(ai.calls).toHaveLength(1)
  })

  it('passes only the tool fields the model needs', async () => {
    await chat(token, {
      messages: [
        ...askPage,
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_current_page', arguments: '{}', x: 1 }, x: 1 },
          ],
          refusal: null,
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{}', name: 'get_current_page' },
      ],
      tools: [{ ...pageTool, function: { ...pageTool.function, strict: true }, extra: 1 }],
      tool_choice: { type: 'function', function: { name: 'get_current_page', x: 1 } },
      parallel_tool_calls: false,
    })
    expect(ai.calls[0].inputs).toEqual({
      messages: [
        ...askPage,
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_current_page', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{}' },
      ],
      tools: [pageTool],
      tool_choice: { type: 'function', function: { name: 'get_current_page' } },
      max_tokens: 16_384,
    })
  })

  it('says what is wrong with each part of a request, and the first thing when several are', async () => {
    const call = { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }
    const tool = { type: 'function', function: { name: 'f' } }
    const refused: [unknown, string][] = [
      [[], 'body must be a JSON object'],
      [{}, 'messages must be a non-empty array'],
      [{ messages: [] }, 'messages must be a non-empty array'],
      [{ messages: Array.from({ length: 201 }, () => askPage[0]) }, 'at most 200 messages'],
      [{ messages: ['hi'] }, 'each message must be an object'],
      [{ messages: [{ content: 'hi' }] }, 'each message needs a role: system, user, assistant, or tool'],
      [{ messages: [{ role: 'user', content: 5 }] }, 'user messages need string content'],
      [{ messages: [{ role: 'system' }] }, 'system messages need string content'],
      [{ messages: [{ role: 'assistant' }] }, 'assistant messages need string content or tool_calls'],
      [
        { messages: [{ role: 'assistant', content: 5, tool_calls: [call] }] },
        'assistant content must be a string or null',
      ],
      [{ messages: [{ role: 'assistant', tool_calls: [] }] }, 'tool_calls must be an array of 1 to 32 calls'],
      [
        { messages: [{ role: 'assistant', tool_calls: [{ ...call, type: 'tool' }] }] },
        'each tool call needs an id, type "function", and a function with a name and string arguments',
      ],
      [{ messages: [{ role: 'tool', content: 'r' }] }, 'tool messages need a tool_call_id and string content'],
      // An id is at most 256 characters as JavaScript counts them, emoji (two each) included.
      [
        { messages: [{ role: 'assistant', tool_calls: [{ ...call, id: '😀'.repeat(128) + 'x' }] }] },
        'each tool call needs an id, type "function", and a function with a name and string arguments',
      ],
      [
        { messages: [{ role: 'tool', tool_call_id: '😀'.repeat(128) + 'x', content: 'r' }] },
        'tool messages need a tool_call_id and string content',
      ],
      [
        { messages: [{ role: 'tool', tool_call_id: 'c1', content: 'r' }] },
        'each tool message must answer a call from the assistant message before it',
      ],
      [
        { messages: [{ role: 'assistant', tool_calls: [call] }, askPage[0]] },
        'each tool call needs its result right after the assistant message',
      ],
      [{ messages: [{ role: 'assistant', tool_calls: [call, call] }] }, 'tool call ids in one message must be unique'],
      [{ messages: askPage, tools: [] }, 'tools must be an array of 1 to 64 tools'],
      [
        { messages: askPage, tools: [{ type: 'function' }] },
        'each tool needs type "function" and a function definition',
      ],
      [
        { messages: askPage, tools: [{ type: 'function', function: { name: 'bad name' } }] },
        'tool names are 1 to 64 letters, digits, underscores, or dashes',
      ],
      [{ messages: askPage, tools: [tool, tool] }, 'tool f is defined twice'],
      // Tools are read in order: a name given twice is said before what is wrong with it, or with a later tool.
      [
        { messages: askPage, tools: [tool, { type: 'function', function: { name: 'f', description: 5 } }] },
        'tool f is defined twice',
      ],
      [
        { messages: askPage, tools: [tool, tool, { type: 'function', function: { name: 'bad name' } }] },
        'tool f is defined twice',
      ],
      [
        { messages: askPage, tools: [{ type: 'function', function: { name: 'f', description: 5 } }] },
        'tool descriptions must be strings',
      ],
      [
        { messages: askPage, tools: [{ type: 'function', function: { name: 'f', parameters: [] } }] },
        'tool parameters must be an object',
      ],
      [{ messages: askPage, tool_choice: 'auto' }, 'tool_choice needs tools'],
      [
        { messages: askPage, tools: [tool], tool_choice: 'always' },
        'tool_choice must be auto, required, or {"type":"function","function":{"name":...}}',
      ],
      [
        { messages: askPage, tools: [tool], tool_choice: { type: 'function', function: { name: 'g' } } },
        'tool_choice names an unknown tool: g',
      ],
      [{ messages: askPage, max_tokens: 0 }, 'max_tokens must be an integer from 1 to 16384'],
      [{ messages: askPage, stream: 'yes' }, 'stream must be a boolean'],
      // The conversation is checked first, then the tools, then the settings.
      [{ messages: [], tools: [], max_tokens: 0, stream: 1 }, 'messages must be a non-empty array'],
      [{ messages: askPage, tools: [], max_tokens: 0, stream: 1 }, 'tools must be an array of 1 to 64 tools'],
      [
        { messages: askPage, max_tokens: 0, stream: 1, model: 'other' },
        'max_tokens must be an integer from 1 to 16384',
      ],
    ]
    for (const [body, message] of refused) {
      const res = await chat(token, body)
      expect([res.status, await json(res)], JSON.stringify(body).slice(0, 80)).toEqual([
        400,
        { error: { code: 'bad_request', message } },
      ])
    }
    expect(ai.calls).toHaveLength(0)
  })

  it('tools without a description or parameters are allowed', async () => {
    const bare = [{ type: 'function', function: { name: 'ping' } }]
    expect((await chat(token, { messages: askPage, tools: bare })).status).toBe(200)
    expect(ai.calls[0].inputs.tools).toEqual(bare)
  })

  it('tool_choice auto and required are passed to the model', async () => {
    for (const tool_choice of ['auto', 'required']) {
      expect((await chat(token, { messages: askPage, tools, tool_choice })).status).toBe(200)
    }
    expect(ai.calls.map((c) => c.inputs.tool_choice)).toEqual(['auto', 'required'])
  })

  it('tool_choice none is refused, since the model does not honor it', async () => {
    const res = await chat(token, { messages: askPage, tools, tool_choice: 'none' })
    expect(res.status).toBe(400)
    expect((await json(res)).error.message).toContain('leave out tools')
    expect(ai.calls).toHaveLength(0)
  })

  it('each tool call gets one result right after it', async () => {
    const [question, call, result] = withToolResult('{}')
    const pageCall = { id: 'call_1', type: 'function', function: { name: 'get_current_page', arguments: '{}' } }
    const searchCall = { id: 'call_2', type: 'function', function: { name: 'search_pages', arguments: '{}' } }
    const twoCalls = { role: 'assistant', content: '', tool_calls: [pageCall, searchCall] }
    const result2 = { role: 'tool', tool_call_id: 'call_2', content: '[]' }
    const later = { role: 'user', content: 'go on' }
    const bad = [
      [question, result],
      [question, { ...result, tool_call_id: 'call_2' }],
      [question, result, call],
      [question, call],
      [question, call, later, result],
      [question, twoCalls, result],
      [question, twoCalls, result, later, result2],
      // Ids are unique within a message and each call gets one result.
      [question, { ...call, tool_calls: [pageCall, pageCall] }, result],
      [question, call, result, result],
    ]
    for (const messages of bad) expect((await chat(token, { messages })).status).toBe(400)
    expect(ai.calls).toHaveLength(0)
    // The client's id is not echoed back.
    const stray = { ...result, tool_call_id: 'stray-<id>' }
    expect((await json(await chat(token, { messages: [question, stray] }))).error.message).not.toContain('stray')
    // Results for several calls may come in any order.
    expect((await chat(token, { messages: [question, twoCalls, result2, result, later] })).status).toBe(200)
  })

  it('an agent can run several tool rounds, even if ids repeat across rounds', async () => {
    ai.toolCalls = [{ name: 'get_current_page', arguments: '{}' }]
    const messages: unknown[] = [...askPage]
    for (let round = 0; round < 2; round++) {
      const res = await chat(token, { messages, tools, stream: true })
      expect(res.status).toBe(200)
      const reply = await readStream(res)
      const toolCalls = reply.calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }))
      messages.push({ role: 'assistant', content: reply.text, tool_calls: toolCalls })
      messages.push({ role: 'tool', tool_call_id: toolCalls[0].id, content: '{"title":"Q4 Roadmap"}' })
    }
    ai.toolCalls = undefined
    expect((await chat(token, { messages, tools })).status).toBe(200)
    expect(ai.calls).toHaveLength(3)

    // Clients or other models may number ids per reply; results pair with the calls right before them.
    const [question, call, result] = withToolResult('{}')
    expect((await chat(token, { messages: [question, call, result, call, result] })).status).toBe(200)
  })

  it('tool_choice with a malformed name is refused without echoing it', async () => {
    const name = 'x'.repeat(1000)
    const res = await chat(token, { messages: askPage, tools, tool_choice: { type: 'function', function: { name } } })
    expect(res.status).toBe(400)
    expect((await json(res)).error.message).not.toContain(name)
  })

  it('deeply nested tool parameters are refused, not a server error', async () => {
    // Built as text: parsing this much nesting works, serializing it again does not.
    const depth = 20_000
    const parameters = '{"a":'.repeat(depth) + '{}' + '}'.repeat(depth)
    const body = `{"messages":${JSON.stringify(askPage)},"tools":[{"type":"function","function":{"name":"deep","parameters":${parameters}}}]}`
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers, body }, env)
    expect(res.status).toBe(400)
    expect(ai.calls).toHaveLength(0)

    // Up to 64 levels is fine; one more is refused.
    const nested = (levels: number) => {
      let p: Record<string, unknown> = {}
      for (let i = 1; i < levels; i++) p = { a: p }
      return [{ type: 'function', function: { name: 'nested', parameters: p } }]
    }
    expect((await chat(token, { messages: askPage, tools: nested(64) })).status).toBe(200)
    expect((await chat(token, { messages: askPage, tools: nested(65) })).status).toBe(400)
  })

  it('invalid tools are rejected without calling the model', async () => {
    const fn = (f: Record<string, unknown>) => [{ type: 'function', function: f }]
    const bad: unknown[] = [
      'get_current_page',
      [],
      Array.from({ length: 65 }, (_, i) => ({ type: 'function', function: { name: `t${i}` } })),
      [{ type: 'code_interpreter' }],
      [{ type: 'function' }],
      fn({ name: 'has space' }),
      fn({ name: 'x'.repeat(65) }),
      fn({ name: 1 }),
      fn({ name: 'f', description: 1 }),
      fn({ name: 'f', parameters: 'object' }),
      fn({ name: 'f', parameters: [] }),
      [pageTool, pageTool],
    ]
    for (const t of bad) expect((await chat(token, { messages: askPage, tools: t })).status).toBe(400)
    expect(ai.calls).toHaveLength(0)
  })

  it('invalid tool_choice is rejected without calling the model', async () => {
    const bad = [
      { tool_choice: 'auto' },
      { tools, tool_choice: 'any' },
      { tools, tool_choice: { type: 'function', function: { name: 'unknown' } } },
      { tools, tool_choice: { type: 'function' } },
      { tools, tool_choice: { function: { name: 'get_current_page' } } },
    ]
    for (const body of bad) expect((await chat(token, { messages: askPage, ...body })).status).toBe(400)
    expect(ai.calls).toHaveLength(0)
  })

  it('invalid tool calls and tool results are rejected without calling the model', async () => {
    const call = { id: 'call_1', type: 'function', function: { name: 'get_current_page', arguments: '{}' } }
    const assistant = (m: Record<string, unknown>) => [...askPage, { role: 'assistant', ...m }]
    const bad: unknown[][] = [
      assistant({}),
      assistant({ content: 1, tool_calls: [call] }),
      assistant({ tool_calls: [] }),
      assistant({ tool_calls: {} }),
      assistant({ tool_calls: Array.from({ length: 33 }, (_, i) => ({ ...call, id: `c${i}` })) }),
      assistant({ tool_calls: [{ ...call, id: '' }] }),
      assistant({ tool_calls: [{ ...call, id: 'x'.repeat(257) }] }),
      assistant({ tool_calls: [{ ...call, type: 'other' }] }),
      assistant({ tool_calls: [{ ...call, function: { name: 'get_current_page', arguments: {} } }] }),
      assistant({ tool_calls: [{ ...call, function: { name: 'bad name', arguments: '{}' } }] }),
      [...askPage, { role: 'tool', content: '{}' }],
      [...askPage, { role: 'tool', tool_call_id: 'call_1', content: { title: 'x' } }],
      [...askPage, { role: 'developer', content: 'x' }],
      [...askPage, null],
    ]
    for (const messages of bad) expect((await chat(token, { messages })).status).toBe(400)
    expect(ai.calls).toHaveLength(0)
  })
})
