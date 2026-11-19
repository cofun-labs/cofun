import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type Env } from '../src/app'
import { MAX_QUEUED_BYTES, STREAM_DEADLINE_MS } from '../src/usage'
import { FakeClerk } from './clerk'
import {
  FAKE_COST,
  FAKE_USAGE,
  FakeAiBinding,
  FakeD1Database,
  FakeExecutionContext,
  FakeUsageDataset,
  FakeRateLimiter,
  FakeTimers,
  MODEL,
  usageCosting,
} from './fakes'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
// What /v1/me says a request to the model can hold.
const SERVED = { context_window: 1_048_576, max_tokens: 65_536 }
let clock = new Date('2026-11-08T12:00:00Z')
/** Every error line the worker logged in the current test. */
let logged: string[] = []
let timers = new FakeTimers()
const app = createApp({
  now: () => clock,
  logError: (line) => logged.push(line),
  after: (ms, fire) => timers.after(ms, fire),
})

let clerk: FakeClerk
let otherClerk: FakeClerk
let ai: FakeAiBinding
let db: FakeD1Database
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
  timers = new FakeTimers()
  contexts = []
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
    AI_GATEWAY_ID: 'gw-test',
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: `${EXT}, https://cofun.example`,
  }
  token = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
})

const json = (res: Response): Promise<any> => res.json()
/** For a binding written for one test, which searches nothing. */
const noSearch = () => Promise.reject(new Error('this test searches nothing'))

function req(method: string, path: string, bearer?: string, body?: unknown, more: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...more }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
  const ctx = new FakeExecutionContext()
  contexts.push(ctx)
  return app.request(path, init, env, ctx)
}
/** The execution context of each request of the current test. */
let contexts: FakeExecutionContext[] = []
/** Waits until the work every request handed its execution context has ended: its calls are charged. */
const charged = async () => {
  await Promise.allSettled(contexts.flatMap((ctx) => ctx.waiting))
}

const hi = [{ role: 'user', content: 'hi' }]

/** `text` as a stream of 64 kB chunks, sent with no content-length. */
function inChunks(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let at = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(at, (at += 64 * 1024)))
    },
  })
}
/** Notico's header naming its product, as it sends it with every model request. */
const NOTICO = { 'x-cofun-client': 'notico/0.3.0' }
const chat = (bearer: string | undefined, body: unknown = { messages: hi }, more: Record<string, string> = NOTICO) =>
  req('POST', '/v1/chat/completions', bearer, body, more)
/** The record of each model call, with its tokens and what it was charged. */
const calls = () => db.calls()

describe('UC-COFUN-CHAT-001 Ask the hosted model: only with a valid session', () => {
  it('[UC-COFUN-CHAT-001-S03] request without a session is refused', async () => {
    const res = await chat(undefined)
    expect(res.status).toBe(401)
    expect((await json(res)).error.code).toBe('unauthorized')
  })

  it('[UC-COFUN-CHAT-001-S03] invalid, forged and expired sessions are refused', async () => {
    const forged = await otherClerk.sessionToken({ userId: 'user_eve', azp: EXT })
    const expired = await clerk.sessionToken({ userId: 'user_alice', azp: EXT, expiresInSec: -60 })
    for (const bad of ['not-a-jwt', forged, expired]) {
      expect((await chat(bad)).status).toBe(401)
    }
    expect(ai.calls).toHaveLength(0)
  })

  it('[UC-COFUN-CHAT-001-S04] session issued to another site is refused', async () => {
    const elsewhere = await clerk.sessionToken({ userId: 'user_alice', azp: 'https://evil.example' })
    expect((await chat(elsewhere)).status).toBe(401)
  })
})

describe('UC-COFUN-CHAT-001 Ask the hosted model', () => {
  it('[UC-COFUN-CHAT-001-S01] reply streams as server-sent events', async () => {
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

  it('[UC-COFUN-CHAT-001-S02] asking for another model is refused', async () => {
    const res = await chat(token, { messages: hi, model: 'openai/gpt-5' })
    expect(res.status).toBe(400)
    expect((await json(res)).error.code).toBe('unsupported_model')
    expect(ai.calls).toHaveLength(0)
  })
})

// Standalone tests: implementation behavior worth guarding, not product contract (see docs/bdd.md).
describe('worker API', () => {
  it('[@no-uc:access] GET /health needs no session (infrastructure)', async () => {
    expect((await req('GET', '/health')).status).toBe(200)
  })

  it('[@no-uc:contract] /v1/me returns the Clerk user id, the model, and what a request to it can hold', async () => {
    const res = await req('GET', '/v1/me', token)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ userId: 'user_alice', model: MODEL, ...SERVED })
  })

  it('[@no-uc:access] a session from any allowed origin is accepted', async () => {
    const web = await clerk.sessionToken({ userId: 'user_alice', azp: 'https://cofun.example' })
    expect((await chat(web)).status).toBe(200)
  })

  it('[@no-uc:access] a validly signed session that names no origin is accepted', async () => {
    // Clerk hands a side panel that just loaded such a token, for its first minute.
    const noOrigin = await clerk.sessionToken({ userId: 'user_alice' })
    const res = await req('GET', '/v1/me', noOrigin)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ userId: 'user_alice', model: MODEL, ...SERVED })
  })

  it('[@no-uc:access] a session whose origin is not text is refused', async () => {
    const notText = await clerk.sessionToken({ userId: 'user_alice', claims: { azp: [EXT] } })
    const res = await req('GET', '/v1/me', notText)
    expect(res.status).toBe(401)
    expect((await json(res)).error.code).toBe('unauthorized')
  })

  it('[@no-uc:access] API is off without the JWT key', async () => {
    env.CLERK_JWT_KEY = undefined
    const res = await chat(token)
    expect(res.status).toBe(503)
    expect((await json(res)).error.code).toBe('not_configured')
  })

  it('[@no-uc:access] API is off without allowed origins', async () => {
    env.CLERK_AUTHORIZED_PARTIES = ''
    const res = await chat(token)
    expect(res.status).toBe(503)
    expect((await json(res)).error.code).toBe('not_configured')
  })

  it('[@no-uc:access] extension origin passes CORS preflight, with the headers the extension sends', async () => {
    const res = await app.request(
      '/v1/chat/completions',
      { method: 'OPTIONS', headers: { origin: EXT, 'access-control-request-method': 'POST' } },
      env,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-headers')?.split(',')).toEqual(
      expect.arrayContaining(['authorization', 'x-cofun-client', 'x-cofun-chat-id', 'x-cofun-turn-id']),
    )
  })

  it('[@no-uc:access] sign-in page loads Clerk with the publishable key', async () => {
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

  it("[@no-uc:access] sign-in page loads Clerk from a production instance's Frontend API", async () => {
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

  it('[@no-uc:privacy] sign-in page turns Clerk SDK telemetry off', async () => {
    env.CLERK_PUBLISHABLE_KEY = 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk'
    const html = await (await req('GET', '/login')).text()
    const options = /window\.Clerk\.load\(\{([^]*?)\}\)/.exec(html)?.[1]
    expect(options).toMatch(/^\s*telemetry: false,$/m)
  })

  it('[@no-uc:access] sign-in page is off without a publishable key', async () => {
    expect((await req('GET', '/login')).status).toBe(503)
  })

  it('[@no-uc:money] non-streamed reply goes through the gateway tagged with the user', async () => {
    const res = await chat(token, { messages: hi, max_tokens: 50 })
    expect(res.status).toBe(200)
    expect((await json(res)).choices[0].message.content).toBe('Hello from Workers AI')
    expect(ai.calls[0]).toEqual({
      model: MODEL,
      inputs: { messages: hi, max_completion_tokens: 50 },
      options: {
        gateway: {
          id: 'gw-test',
          collectLog: false,
          skipCache: true,
          metadata: { product: 'notico', user: 'user_alice' },
        },
      },
    })
  })

  it('[@no-uc:money] a chat body too large is refused with 413 before it is read whole, with or without its length', async () => {
    const payload = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(7 * 1024 * 1024) }] })
    const send = (body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) => {
      // Node needs `duplex` to send a stream; the Workers types do not list it.
      const init = {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
        body,
        duplex: 'half',
      }
      const request = new Request('http://localhost/v1/chat/completions', init)
      return app.request(request, undefined, env, new FakeExecutionContext())
    }
    const sized = await send(payload, { 'content-length': String(payload.length) })
    expect(sized.status).toBe(413)
    expect((await json(sized)).error.code).toBe('too_large')
    // Sent in chunks with no length, as a chunked upload is.
    expect((await send(inChunks(payload))).status).toBe(413)
    // A body in chunks within the limit is read as usual.
    expect((await send(inChunks(JSON.stringify({ messages: hi })))).status).toBe(200)
    expect(ai.calls).toHaveLength(1)
  })

  it('[@no-uc:contract] passes only role and content to the model, and defaults max_tokens when unset', async () => {
    await chat(token, { messages: [{ role: 'user', content: 'hi', name: 'x', extra: 1 }], max_tokens: null })
    expect(ai.calls[0].inputs).toEqual({ messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 65_536 })
  })

  it('[@no-uc:contract] naming the server model is allowed', async () => {
    expect((await chat(token, { messages: hi, model: MODEL })).status).toBe(200)
  })

  it('[@no-uc:contract] model failure returns 502', async () => {
    ai.failWith = new Error('capacity')
    const res = await chat(token)
    expect(res.status).toBe(502)
    const { error } = await json(res)
    expect(error.code).toBe('provider_error')
    expect(error.message).not.toContain('capacity')
  })
})

describe('UC-COFUN-CREDITS-001 Spend credits on the hosted model', () => {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  /** Every reply from now on costs this many credits. A user starts with 200. */
  const repliesCost = (credits: number) => {
    ai.usage = usageCosting(credits)
  }
  const later = (ms: number) => {
    clock = new Date(clock.getTime() + ms)
  }
  /**
   * The model writes the first piece of its reply, "Hello ", and is still writing when the user
   * stops it: the worker reads the model as it writes, so what it read is what the model wrote.
   */
  const modelWritesFirstPiece = () => {
    const first = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello ' } }] })}\n\n`
    ai.pause = { after: first.length, until: new Promise(() => {}) }
  }
  const refused = async (res: Response) => {
    expect(res.status).toBe(402)
    const { error } = await json(res)
    expect(error.code).toBe('out_of_credits')
    return String(error.message)
  }

  it('[UC-COFUN-CREDITS-001-S01] a user with no credits left is refused, told when credits arrive, and the model is not called', async () => {
    repliesCost(150)
    expect((await chat(token)).status).toBe(200)
    // 50 credits are left: the call goes ahead, and takes the balance below zero.
    expect((await chat(token)).status).toBe(200)
    const message = await refused(await chat(token))
    // The week started with the first request, at 12:00 on 2026-11-08.
    expect(message).toBe(
      'You have no credits left. Your next 200 free credits arrive on 2026-11-15 at 12:00 UTC, or you can buy credits.',
    )
    expect(ai.calls).toHaveLength(2)
  })

  it('[UC-COFUN-CREDITS-001-S15] an input estimated to cost more than the credits left is refused before the model', async () => {
    repliesCost(199)
    expect((await chat(token)).status).toBe(200)
    // About a credit is left. 600,000 characters estimate 200,000 input tokens, 1.2 credits at the
    // cached price.
    const message = await refused(await chat(token, { messages: [{ role: 'user', content: 'x'.repeat(600_000) }] }))
    expect(message).toBe(
      'This request needs about 2 credits and you have 1 left. Start a new chat or shorten it, buy credits, or wait for your next 200 free credits on 2026-11-15 at 12:00 UTC.',
    )
    expect(ai.calls).toHaveLength(1)
    expect((await chat(token)).status).toBe(200)
    expect(ai.calls).toHaveLength(2)
  })

  it('[UC-COFUN-CREDITS-001-S02] a new week brings new free credits', async () => {
    repliesCost(200)
    expect((await chat(token)).status).toBe(200)
    later(WEEK_MS - 1000)
    await refused(await chat(token))
    later(1000)
    expect((await chat(token)).status).toBe(200)
  })

  it('[UC-COFUN-CREDITS-001-S03] a call that costs more than was left takes only what was left, and the next free credits arrive in full', async () => {
    repliesCost(150)
    await chat(token)
    // 50 credits are left: the call costs 150, takes the 50, and the 100 beyond them are forgiven.
    await chat(token)
    expect(db.grants().map((r) => r.left)).toEqual([0])
    expect(db.calls().map((r) => r.micro_credits)).toEqual([150_000_000, 150_000_000])
    // What a spend took from the grant: the 50 left of it, and nothing for the second.
    expect(db.rows('spend_grants').map((r) => [r.spend_id, r.grant_id, r.micro_credits])).toEqual([
      [1, 1, 150_000_000],
      [2, 1, 50_000_000],
    ])
    await refused(await chat(token))
    // The new week has all of its 200 credits to spend.
    later(WEEK_MS)
    repliesCost(180)
    expect((await chat(token)).status).toBe(200)
    repliesCost(20)
    expect((await chat(token)).status).toBe(200)
    expect(await refused(await chat(token))).toContain('2026-11-22 at 12:00 UTC')
  })

  it('[UC-COFUN-CREDITS-001-S02] credits left when the week ends are gone', async () => {
    repliesCost(50)
    await chat(token)
    // 150 credits were left. The new week has 200, not 350.
    later(WEEK_MS)
    repliesCost(150)
    expect((await chat(token)).status).toBe(200)
    expect((await chat(token)).status).toBe(200)
    await refused(await chat(token))
  })

  it('[UC-COFUN-CREDITS-001-S05] input read from the cache costs the cached price', async () => {
    // As the hosted model reported a second call with the same long prompt.
    ai.usage = { prompt_tokens: 5639, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 5568 } }
    await chat(token)
    await (await chat(token, { messages: hi, stream: true })).text()
    const cost = 71 * 300 + 5568 * 6 + 6 * 1200
    expect(calls().map((r) => [r.prompt_tokens, r.cached_tokens, r.micro_credits])).toEqual([
      [5639, 5568, cost],
      [5639, 5568, cost],
    ])
  })

  it('[UC-COFUN-CREDITS-001-S12] the reply says what the call cost, streamed or not, as it was charged', async () => {
    ai.usage = { prompt_tokens: 5639, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 5568 } }
    const cost = { micro_credits: 71 * 300 + 5568 * 6 + 6 * 1200, estimated: false }
    expect((await json(await chat(token))).cost).toEqual(cost)
    const sse = await (await chat(token, { messages: hi, stream: true })).text()
    const events = sse.split('\n\n').filter(Boolean)
    // The last chunk before [DONE] says what the call cost; the chunk with the usage comes before it.
    expect(events.slice(-2)).toEqual([`data: ${JSON.stringify({ choices: [], cost })}`, 'data: [DONE]'])
    expect(events.at(-3)).toContain('"usage"')
    expect(db.calls().map((r) => r.micro_credits)).toEqual([cost.micro_credits, cost.micro_credits])
  })

  it("[UC-COFUN-CREDITS-001-S13] a stream that breaks off, or ends in the model's error, after part of the reply costs nothing, and says so", async () => {
    const cost = { micro_credits: 0, estimated: false }
    // The reply's first piece, then the stream ends without its totals or [DONE].
    ai.rawSse =
      'data: {"choices":[{"delta":{"content":"abcdef"}}],"usage":{"prompt_tokens":1000,"completion_tokens":2}}\n\n'
    const broken = await (await chat(token, { messages: hi, stream: true })).text()
    expect(broken.split('\n\n').filter(Boolean).at(-1)).toBe(`data: ${JSON.stringify({ choices: [], cost })}`)
    // The reply's first piece, then the model's error.
    ai.rawSse =
      'data: {"choices":[{"delta":{"content":"abcdef"}}],"usage":{"prompt_tokens":1000,"completion_tokens":2}}\n\n' +
      'data: {"error":{"message":"model overloaded"}}\n\ndata: [DONE]\n\n'
    const failed = await (await chat(token, { messages: hi, stream: true })).text()
    expect(failed).toContain(`"cost":${JSON.stringify(cost)}`)
    // Their tokens are kept, for the operator; the user is charged nothing.
    expect(db.calls().map((r) => [r.outcome, r.prompt_tokens, r.estimated, r.micro_credits])).toEqual([
      ['incomplete', 1000, 0, 0],
      ['provider_error', 1000, 0, 0],
    ])
    expect(db.grants()[0]).toMatchObject({ left: 200_000_000 })
  })

  it('[@no-uc:money] a stream whose read fails says what it was charged before it errors', async () => {
    ai.streamFailWith = new Error('connection reset')
    ai.usage = { prompt_tokens: 3, completion_tokens: 0 }
    const res = await chat(token, { messages: hi, stream: true })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    await expect(
      (async () => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          text += decoder.decode(value, { stream: true })
        }
      })(),
    ).rejects.toThrow('the model stream failed')
    const [call] = db.calls()
    expect(call).toMatchObject({ outcome: 'stream_error' })
    expect(text).toContain(
      `"cost":${JSON.stringify({ micro_credits: call.micro_credits, estimated: call.estimated === 1 })}`,
    )
  })

  it('[UC-COFUN-CREDITS-001-S11] calls sent at once all start on the same balance, and what they cost beyond it is forgiven', async () => {
    repliesCost(190)
    await chat(token)
    // 10 credits are left, and two replies that cost 190 each are written at once: the model is
    // still writing the first when the second starts.
    let write!: () => void
    ai.pause = { after: 0, until: new Promise((resolve) => (write = resolve)) }
    const replies = [
      await chat(token, { messages: hi, stream: true }),
      await chat(token, { messages: hi, stream: true }),
    ]
    expect(replies.map((res) => res.status)).toEqual([200, 200])
    write()
    ai.pause = undefined
    for (const res of replies) await res.text()
    // They took the 10 credits that were left, and nothing below zero.
    expect(db.grants().map((r) => r.left)).toEqual([0])
    await refused(await chat(token))
    // The next week's 200 credits are all there to spend.
    later(WEEK_MS)
    repliesCost(200)
    expect((await chat(token)).status).toBe(200)
    await refused(await chat(token))
    expect(ai.calls).toHaveLength(4)
  })

  it('[@no-uc:money] concurrent requests neither lose a charge nor grant a week twice', async () => {
    const replies = await Promise.all(Array.from({ length: 8 }, () => chat(token)))
    expect(replies.map((res) => res.status)).toEqual(Array(8).fill(200))
    await Promise.all(replies.map((res) => res.text()))
    expect(db.grants()).toHaveLength(1)
    expect(db.calls().map((r) => r.micro_credits)).toEqual(Array(8).fill(FAKE_COST))
    expect(db.grants()[0]).toMatchObject({ amount: 200_000_000, left: 200_000_000 - 8 * FAKE_COST })
  })

  it('[@no-uc:money] each model call leaves a record of how it ended, its tokens, and what it cost', async () => {
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
      product: 'notico',
      kind: 'model_call',
    }
    const start = Date.parse('2026-11-08T12:00:00Z')
    expect(db.calls()).toEqual([
      { id: 1, ...call, started_at: start, created_at: start, stream: 0 },
      { id: 2, ...call, started_at: start + 1000, created_at: start + 1000, stream: 1 },
    ])
  })

  it('[@no-uc:money] model calls that failed or cost nothing are recorded, and charge nothing', async () => {
    ai.failWith = new Error('capacity')
    await chat(token)
    ai.failWith = undefined
    ai.rawSse = ''
    await (await chat(token, { messages: hi, stream: true })).text()
    ai.rawSse = undefined
    ai.streamFailWith = new Error('connection reset')
    await (await chat(token, { messages: hi, stream: true })).text().catch(() => {})
    expect(db.calls().map((r) => [r.outcome, r.stream, r.prompt_tokens, r.micro_credits])).toEqual([
      ['provider_error', 0, 0, 0],
      ['incomplete', 1, 0, 0],
      ['stream_error', 1, 0, 0],
    ])
    expect(db.grants()[0]).toMatchObject({ left: 200_000_000 })
    // A request refused before the model was called is no model call.
    await chat(token, { messages: [] })
    expect(db.calls()).toHaveLength(3)
  })

  it('[@no-uc:money] a stream cut short is recorded with the estimate it was charged by', async () => {
    modelWritesFirstPiece()
    const res = await chat(token, { messages: hi, stream: true })
    const reader = res.body!.getReader()
    // The first line: the first piece of the reply, "Hello ".
    await reader.read()
    await reader.cancel()
    expect(db.calls()).toEqual([
      expect.objectContaining({ outcome: 'cancelled', estimated: 1, prompt_tokens: 1, completion_tokens: 2 }),
    ])
  })

  it('[@no-uc:money] grants and model calls of several users are kept apart in one database', async () => {
    const bob = await clerk.sessionToken({ userId: 'user_bob', azp: EXT })
    repliesCost(150)
    await chat(token)
    await chat(token)
    repliesCost(30)
    await chat(bob)
    expect(db.grants().map((r) => [r.user_id, r.left])).toEqual([
      ['user_alice', 0],
      ['user_bob', 170_000_000],
    ])
    expect(db.calls().map((r) => r.user_id)).toEqual(['user_alice', 'user_alice', 'user_bob'])
    // Alice is out of credits, not Bob: he can still ask, and she cannot.
    await refused(await chat(token))
    expect((await chat(bob)).status).toBe(200)
  })

  it('[@no-uc:money] a charge is taken from the grant that expires first, then from the next', async () => {
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
    expect(db.grants().map((r) => [r.source, r.left])).toEqual([
      ['free', 0],
      ['manual', 90_000_000],
    ])
    // The second call's 60 credits came from both grants: the 50 left of the week, then 10.
    expect(db.rows('spend_grants').map((r) => [r.spend_id, r.grant_id, r.micro_credits])).toEqual([
      [1, 1, 150_000_000],
      [2, 1, 50_000_000],
      [2, 2, 10_000_000],
    ])
  })

  it('[@no-uc:money] a stream that ended before the client stopped reading is charged its totals, not an estimate', async () => {
    ai.rawSse =
      'data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":900}}}\n\n' +
      'data: [DONE]\n\n'
    // The model said it was done, and its stream has not closed yet when the user stops it.
    ai.pause = { after: ai.rawSse.length, until: new Promise(() => {}) }
    const res = await chat(token, { messages: hi, stream: true })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('[DONE]\n')) text += decoder.decode((await reader.read()).value, { stream: true })
    await reader.cancel()
    expect(calls()).toEqual([
      expect.objectContaining({
        outcome: 'cancelled',
        prompt_tokens: 1000,
        cached_tokens: 900,
        completion_tokens: 5,
        estimated: 0,
        micro_credits: 100 * 300 + 900 * 6 + 5 * 1200,
      }),
    ])
  })

  it('[@no-uc:money] a stream that breaks off before it reports or carries anything costs nothing', async () => {
    ai.rawSse = ''
    await (await chat(token, { messages: hi, stream: true })).text()
    ai.rawSse = undefined
    ai.streamFailWith = new Error('connection reset')
    await (await chat(token, { messages: hi, stream: true })).text().catch(() => {})
    expect(calls().map((r) => [r.outcome, r.prompt_tokens, r.micro_credits])).toEqual([
      ['incomplete', 0, 0],
      ['stream_error', 0, 0],
    ])
  })

  it('[UC-COFUN-CREDITS-001-S06] a call is charged what its tokens cost', async () => {
    await chat(token)
    expect(calls()[0]).toMatchObject({ cached_tokens: 0, micro_credits: FAKE_COST })
  })

  it('[UC-COFUN-CREDITS-001-S10] each user has their own credits', async () => {
    repliesCost(200)
    await chat(token)
    await refused(await chat(token))
    const bob = await clerk.sessionToken({ userId: 'user_bob', azp: EXT })
    expect((await chat(bob)).status).toBe(200)
  })

  it('[UC-COFUN-CREDITS-001-S14] a user who starts too many calls in a minute is told to wait, at no cost, and others are not', async () => {
    env.CHAT_LIMIT = new FakeRateLimiter(2)
    expect((await chat(token)).status).toBe(200)
    expect((await chat(token)).status).toBe(200)
    const res = await chat(token)
    expect(res.status).toBe(429)
    expect((await json(res)).error).toEqual({
      code: 'rate_limited',
      message: 'Too many requests at once. Wait a minute, then ask again.',
    })
    expect(ai.calls).toHaveLength(2)
    expect(db.calls()).toHaveLength(2)
    const bob = await clerk.sessionToken({ userId: 'user_bob', azp: EXT })
    expect((await chat(bob)).status).toBe(200)
  })

  it('[UC-COFUN-CREDITS-001-S02] a user who comes back after a month gets one grant, not one for each week away', async () => {
    repliesCost(150)
    await chat(token)
    later(30 * 24 * 60 * 60 * 1000)
    expect((await chat(token)).status).toBe(200)
    expect((await chat(token)).status).toBe(200)
    expect(await refused(await chat(token))).toContain('2026-12-15 at 12:00 UTC')
  })

  it('[UC-COFUN-CREDITS-001-S07] requests that are refused, and model calls that fail, cost nothing', async () => {
    repliesCost(200)
    await chat(undefined)
    await chat(token, { messages: [] })
    await chat(token, { messages: hi, model: 'other' })
    ai.failWith = new Error('capacity')
    expect((await chat(token)).status).toBe(502)
    ai.failWith = undefined
    // Only the failed call reached the model, and it charged nothing.
    expect(calls().map((r) => [r.outcome, r.micro_credits])).toEqual([['provider_error', 0]])
    // All 200 credits are still there: one call goes ahead and uses them up.
    expect((await chat(token)).status).toBe(200)
    await refused(await chat(token))
  })

  it('[@no-uc:money] a request stamped a little before the week began gets no second grant', async () => {
    repliesCost(200)
    await chat(token)
    // Another instance whose clock is a second behind.
    later(-1000)
    await refused(await chat(token))
  })

  it('[UC-COFUN-CREDITS-001-S08] a reply the user stops is charged an estimate of what it used', async () => {
    modelWritesFirstPiece()
    const res = await chat(token, { messages: hi, stream: true })
    const reader = res.body!.getReader()
    // The stream goes out a line at a time: this is the first piece of the reply, "Hello ".
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"Hello "')
    await reader.cancel()
    // No chunk reported the prompt, so it is estimated from the input: 2 characters, 1 token, of
    // which 90%, rounded down, counts as cached: none. The reply is estimated from the 6 characters
    // that were streamed: 2 tokens.
    expect(calls()).toEqual([
      expect.objectContaining({
        outcome: 'cancelled',
        prompt_tokens: 1,
        cached_tokens: 0,
        completion_tokens: 2,
        micro_credits: 300 + 2 * 1200,
      }),
    ])
  })

  it('[@no-uc:money] a stopped stream with a long input is charged no more input than the model window holds', async () => {
    // 3,300,000 characters estimate 1,100,000 tokens at the worker's 3 a token. The model counted
    // fewer and took it, so the fake's own window is set past it.
    ai.contextWindow = 2_000_000
    modelWritesFirstPiece()
    const res = await chat(token, { messages: [{ role: 'user', content: 'x'.repeat(3_300_000) }], stream: true })
    const reader = res.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"Hello "')
    await reader.cancel()
    expect(calls()).toEqual([expect.objectContaining({ outcome: 'cancelled', prompt_tokens: 1_048_576 })])
  })

  it('[@no-uc:money] a stream the user stops is charged the prompt it reported, 90% of it as cached, and the reply by its size', async () => {
    // Workers AI gives the prompt in its first chunk; how much of it was cached only comes at the end.
    ai.rawSse =
      'data: {"choices":[{"delta":{"content":""}}],"usage":{"prompt_tokens":1000,"completion_tokens":0}}\n\n' +
      'data: {"choices":[{"delta":{"content":"abcdef","reasoning_content":"ghi"}}],"usage":{"prompt_tokens":0,"completion_tokens":2}}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"abc","arguments":"{}x"}}]}}]}\n\n'
    // The model is still writing when the user stops it.
    ai.pause = { after: ai.rawSse.length, until: new Promise(() => {}) }
    const reader = (await chat(token, { messages: hi, stream: true })).body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('tool_calls')) text += decoder.decode((await reader.read()).value, { stream: true })
    await reader.cancel()
    expect(calls()[0]).toMatchObject({
      outcome: 'cancelled',
      prompt_tokens: 1000,
      cached_tokens: 900,
      completion_tokens: 5,
      micro_credits: 100 * 300 + 900 * 6 + 5 * 1200,
    })
  })

  it('[@no-uc:money] a stream whose read fails after its end is charged its totals, as its last chunk says', async () => {
    ai.rawSse =
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":5}}\n\n' +
      'data: [DONE]\n\n'
    ai.failAfterRawSse = new Error('connection reset')
    const reader = (await chat(token, { messages: hi, stream: true })).body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    await expect(
      (async () => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          text += decoder.decode(value, { stream: true })
        }
      })(),
    ).rejects.toThrow('the model stream failed')
    const cost = { micro_credits: 1000 * 300 + 5 * 1200, estimated: false }
    expect(calls()).toEqual([expect.objectContaining({ outcome: 'stream_error', micro_credits: cost.micro_credits })])
    expect(text).toContain(`"cost":${JSON.stringify(cost)}`)
  })

  it('[@no-uc:money] a stream that carries a model error and no usage costs nothing', async () => {
    ai.rawSse = 'data: {"error":{"message":"model overloaded"}}\n\n'
    await (await chat(token, { messages: hi, stream: true })).text()
    expect(calls()[0]).toMatchObject({ outcome: 'provider_error', micro_credits: 0 })
  })

  it('[@no-uc:money] an unreachable database refuses the request without calling the model', async () => {
    db.failWith = new Error('D1_ERROR: Network connection lost.')
    const res = await chat(token)
    expect(res.status).toBe(503)
    const { error } = await json(res)
    expect(error.code).toBe('credits_unavailable')
    expect(error.message).not.toContain('D1_ERROR')
    expect(logged).toEqual(['credit check failed: Error: D1_ERROR: Network connection lost.'])
    expect(ai.calls).toHaveLength(0)
  })

  it('[@no-uc:money] a model call whose record fails still sends the reply and is not charged', async () => {
    db.failOn = { sql: 'INSERT INTO model_calls', error: new Error('D1_ERROR: Network connection lost.') }
    expect((await chat(token)).status).toBe(200)
    expect(await (await chat(token, { messages: hi, stream: true })).text()).toContain('[DONE]')
    expect(db.grants()[0]).toMatchObject({ left: 200_000_000 })
    expect(logged).toEqual(Array(2).fill('model call record failed: Error: D1_ERROR: Network connection lost.'))
  })

  it('[@no-uc:money] a model with no price is a configuration error, not a free call', async () => {
    env.MODEL = '@cf/test/unpriced'
    const res = await chat(token)
    expect(res.status).toBe(503)
    expect((await json(res)).error.code).toBe('not_configured')
    expect(ai.calls).toHaveLength(0)
  })
})

// Standalone tests for what the worker writes to its logs when a request fails.
describe('UC-COFUN-CREDITS-001 Calls going at once, and replies the client does not read', () => {
  const streamed = { messages: hi, stream: true }
  const later = (ms: number) => {
    clock = new Date(clock.getTime() + ms)
  }
  /** The model writes nothing more until the function given back is called: calls stay going. */
  const stillWriting = () => {
    let write!: () => void
    ai.pause = { after: 0, until: new Promise((resolve) => (write = resolve)) }
    return () => {
      ai.pause = undefined
      write()
    }
  }

  it('[UC-COFUN-CREDITS-001-S16] a user with 3 answers being written is told to wait before a fourth, which costs nothing', async () => {
    const write = stillWriting()
    const going = [await chat(token, streamed), await chat(token, streamed), await chat(token, streamed)]
    expect(going.map((res) => res.status)).toEqual([200, 200, 200])
    const res = await chat(token, streamed)
    expect(res.status).toBe(429)
    const { error } = await json(res)
    expect(error.code).toBe('rate_limited')
    expect(error.message).toBe('3 answers are already being written. Wait for one to finish, then ask again.')
    expect(ai.calls).toHaveLength(3)
    // Another user is not held up by them.
    const bob = await clerk.sessionToken({ userId: 'user_bob', azp: EXT })
    expect((await chat(bob)).status).toBe(200)
    // Once they are written, the user can ask again, and the request refused cost nothing.
    write()
    for (const reply of going) await reply.text()
    expect(calls().filter((call) => call.user_id === 'user_alice')).toHaveLength(3)
    expect((await chat(token, streamed)).status).toBe(200)
  })

  it('[@no-uc:money] calls that start together never take more than 3 slots', async () => {
    const write = stillWriting()
    const replies = await Promise.all(Array.from({ length: 6 }, () => chat(token, streamed)))
    expect(replies.map((res) => res.status).toSorted()).toEqual([200, 200, 200, 429, 429, 429])
    expect(ai.calls).toHaveLength(3)
    write()
    await Promise.all(replies.map((res) => res.text()))
  })

  it('[@no-uc:money] a reply the client does not read is charged as soon as the model is done', async () => {
    const res = await chat(token, streamed)
    // Nothing of the reply was read, and the call is charged its totals already.
    await charged()
    expect(calls()).toHaveLength(1)
    expect(calls()[0]).toMatchObject({ outcome: 'ok', estimated: 0, micro_credits: FAKE_COST })
    // The client reads it all later, with what it cost.
    const text = await res.text()
    expect(text).toContain(`"cost":${JSON.stringify({ micro_credits: FAKE_COST, estimated: false })}`)
    expect(text).toContain('data: [DONE]')
  })

  it('[@no-uc:money] a client that falls far behind is sent nothing more, and the call is charged the totals the model reports', async () => {
    ai.rawSse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(MAX_QUEUED_BYTES + 1024 * 1024) } }] })}\n\n` +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":5}}\n\n' +
      'data: [DONE]\n\n'
    const res = await chat(token, streamed)
    await charged()
    expect(calls()[0]).toMatchObject({
      outcome: 'abandoned',
      estimated: 0,
      prompt_tokens: 1000,
      completion_tokens: 5,
      micro_credits: 1000 * 300 + 5 * 1200,
    })
    // What was held for the client is dropped: its stream ends in an error, since the reply has a gap.
    await expect(res.text()).rejects.toThrow('the client fell too far behind the reply')
  })

  it('[@no-uc:money] a stream still going at its deadline is ended, charged an estimate, and frees its slot', async () => {
    // The model writes the start of the reply, then nothing more.
    ai.pause = { after: 64, until: new Promise(() => {}) }
    const going = [await chat(token, streamed), await chat(token, streamed), await chat(token, streamed)]
    expect((await chat(token, streamed)).status).toBe(429)
    later(STREAM_DEADLINE_MS)
    timers.advance(STREAM_DEADLINE_MS)
    const texts = await Promise.all(going.map((res) => res.text()))
    expect(calls()).toEqual(Array(3).fill(expect.objectContaining({ outcome: 'timeout', estimated: 1 })))
    for (const text of texts) {
      expect(text).toContain('"estimated":true')
      expect(text).not.toContain('data: [DONE]')
    }
    ai.pause = undefined
    expect((await chat(token, streamed)).status).toBe(200)
  })

  it('[@no-uc:money] a slot whose call was never charged stops counting once it expires', async () => {
    // The calls are answered, but their record fails: their slots stay taken.
    db.failOn = { sql: 'INSERT INTO spends', error: new Error('D1 is down') }
    for (let i = 0; i < 3; i++) expect((await chat(token)).status).toBe(200)
    db.failOn = undefined
    expect((await chat(token)).status).toBe(429)
    // A slot lasts past the stream's deadline, so a call that runs is charged before it expires.
    later(STREAM_DEADLINE_MS + 5 * 60 * 1000)
    expect((await chat(token)).status).toBe(200)
  })
})

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

  it('[@no-uc:privacy] a failed model call logs only the name and the start of the message', async () => {
    const err = (ai.failWith = quotingError())
    err.name = 'ProviderError'
    expect((await chat(token, { messages })).status).toBe(502)
    expect(logged).toEqual([`model call failed: ProviderError: ${'x'.repeat(200)}`])
    expect(logged.join()).not.toContain(SECRET)
  })

  it('[@no-uc:privacy] an unexpected error logs only the name and the start of the message', async () => {
    env.AI = {
      websearch: noSearch,
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

  it('[@no-uc:privacy] a stream that fails partway logs the same summary and ends with an error that quotes nothing', async () => {
    ai.streamFailWith = quotingError()
    const res = await chat(token, { messages, stream: true })
    const failure: unknown = await res.text().catch((err: unknown) => err)
    expect(String(failure)).toBe('Error: the model stream failed')
    expect(Object.keys(Object(failure))).toEqual([])
    expect(Object(failure).cause).toBeUndefined()
    expect(logged).toEqual([`model stream failed: Error: ${'x'.repeat(200)}`])
  })

  it('[@no-uc:privacy] a long error name is cut too', async () => {
    const err = (ai.failWith = new Error('capacity'))
    err.name = `${'n'.repeat(60)}${SECRET}`
    await chat(token, { messages })
    expect(logged).toEqual([`model call failed: ${'n'.repeat(60)}: capacity`])
  })

  it('[@no-uc:privacy] a thrown value that is not an error logs only its type', async () => {
    env.AI = {
      websearch: noSearch,
      async run() {
        throw { message: `quoted ${SECRET}` }
      },
    }
    expect((await chat(token, { messages })).status).toBe(502)
    expect(logged).toEqual(['model call failed: non-error value of type object'])
  })

  it('[@no-uc:privacy] a request that is refused logs nothing', async () => {
    expect((await chat(undefined, { messages })).status).toBe(401)
    expect((await chat(token, { messages: [] })).status).toBe(400)
    expect(logged).toEqual([])
  })
})

// Standalone tests for the product a model call is recorded under.
describe('product of a model call', () => {
  const products = () => db.calls().map((r) => r.product)

  it('[@no-uc:money] is the product the extension names in its header, whatever its version', async () => {
    await chat(token)
    await chat(token, { messages: hi }, { 'x-cofun-client': 'confluco/1.0.0' })
    expect(products()).toEqual(['notico', 'confluco'])
    expect(ai.calls.map((call) => call.options)).toMatchObject(
      ['notico', 'confluco'].map((product) => ({ gateway: { metadata: { product } } })),
    )
  })

  it('[@no-uc:money] is not read from the body or the query, nor sent on to the model', async () => {
    const res = await req(
      'POST',
      '/v1/chat/completions?product=confluco',
      token,
      { messages: hi, product: 'confluco' },
      NOTICO,
    )
    expect(res.status).toBe(200)
    expect(products()).toEqual(['notico'])
    expect(ai.calls[0].inputs).not.toHaveProperty('product')
  })

  it('[@no-uc:contract] is unknown when the header names none or no product name, and the call goes ahead', async () => {
    // Store builds up to Notico 0.2.0 send no header.
    expect((await chat(token, { messages: hi }, {})).status).toBe(200)
    for (const bad of ['Notico/0.3.0', 'unknown/0.3.0', 'no tico/0.3.0', `${'a'.repeat(33)}/0.3.0`]) {
      expect((await chat(token, { messages: hi }, { 'x-cofun-client': bad })).status, bad).toBe(200)
    }
    expect(products()).toEqual(Array(5).fill('unknown'))
  })
})

// Standalone tests for the chat and question a spend is recorded with.
describe('chat and question of a spend', () => {
  const CHAT = '7f0c1a52-3b9e-4d2f-9a61-0c5e8b7d4f21'
  const TURN = 'c2d4e6f8-1a3b-4c5d-8e7f-90a1b2c3d4e5'
  const ids = () => db.rows('spends').map(({ chat_id, turn_id }) => ({ chat_id, turn_id }))

  it('[@no-uc:contract] are the ids the extension names in its headers', async () => {
    const res = await chat(token, { messages: hi }, { ...NOTICO, 'x-cofun-chat-id': CHAT, 'x-cofun-turn-id': TURN })
    expect(res.status).toBe(200)
    expect(ids()).toEqual([{ chat_id: CHAT, turn_id: TURN }])
  })

  it('[@no-uc:contract] are none when the request names none, and the call goes ahead', async () => {
    // Builds released before the headers existed send neither.
    expect((await chat(token)).status).toBe(200)
    expect(ids()).toEqual([{ chat_id: null, turn_id: null }])
  })

  it('[@no-uc:money] the chat goes to the model as its session, so its requests reach the instance that cached it', async () => {
    await chat(token, { messages: hi }, { ...NOTICO, 'x-cofun-chat-id': CHAT, 'x-cofun-turn-id': TURN })
    await chat(token)
    expect(ai.calls.map((call) => call.options?.extraHeaders)).toEqual([{ 'x-session-affinity': CHAT }, undefined])
  })

  it('[@no-uc:contract] a header that is not a UUID is refused, before the model is called', async () => {
    for (const [name, bad] of [
      ['x-cofun-chat-id', 'chat-1'],
      ['x-cofun-turn-id', ''],
    ]) {
      const res = await chat(token, { messages: hi }, { ...NOTICO, [name]: bad })
      expect(res.status, name).toBe(400)
      expect((await json(res)).error.message).toBe(`${name} must be a UUID`)
    }
    expect(ai.calls).toHaveLength(0)
    expect(ids()).toEqual([])
  })
})

// Standalone tests for how a reply is read for what it is charged.
describe('reading a reply for its charge', () => {
  it('[@no-uc:contract] the stream reaches the client unchanged, with what it cost ahead of [DONE]', async () => {
    const reply = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n'
    ai.rawSse = `${reply}data: [DONE]\n\n`
    const cost = 'data: {"choices":[],"cost":{"micro_credits":0,"estimated":false}}\n\n'
    expect(await (await chat(token, { messages: hi, stream: true })).text()).toBe(`${reply}${cost}data: [DONE]\n\n`)
    expect(calls()[0]).toMatchObject({ outcome: 'ok', prompt_tokens: 0, completion_tokens: 0, finish_reason: '' })
  })

  it('[@no-uc:money] reads the totals from a Workers AI stream with per-chunk usage', async () => {
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
    expect(calls()[0]).toMatchObject({
      outcome: 'ok',
      finish_reason: 'length',
      prompt_tokens: 36,
      completion_tokens: 30,
    })
  })

  it('[@no-uc:money] unknown finish reasons and malformed token counts are not copied into the record', async () => {
    ai.rawSse =
      'data: {"choices":[{"delta":{},"finish_reason":"free text"}],"usage":{"prompt_tokens":"9","completion_tokens":-1}}\n\ndata: [DONE]\n\n'
    await (await chat(token, { messages: hi, stream: true })).text()
    expect(calls()[0]).toMatchObject({ finish_reason: 'other', prompt_tokens: 0, completion_tokens: 0 })
  })

  it('[@no-uc:contract] non-object events in the stream are passed through and skipped', async () => {
    const events = 'data: null\n\ndata: 3\n\ndata: {"choices":[{"delta":{"content":"a"}}]}\n\n'
    ai.rawSse = `${events}data: [DONE]\n\n`
    const cost = 'data: {"choices":[],"cost":{"micro_credits":0,"estimated":false}}\n\n'
    expect(await (await chat(token, { messages: hi, stream: true })).text()).toBe(`${events}${cost}data: [DONE]\n\n`)
    expect(calls().map((r) => r.outcome)).toEqual(['ok'])
  })

  it('[@no-uc:money] reads the fields of a reply loosely: a field of another shape counts as missing', async () => {
    const replies: [unknown, Record<string, unknown>][] = [
      [
        { choices: { 0: { finish_reason: 'length' } }, usage: [] },
        { finish_reason: 'length', prompt_tokens: 0 },
      ],
      [
        { choices: 'stop', usage: 'x' },
        { finish_reason: '', prompt_tokens: 0 },
      ],
      [
        { choices: [null, { finish_reason: 'stop' }], usage: { prompt_tokens: 7 } },
        { finish_reason: '', prompt_tokens: 7 },
      ],
      [['stop'], { finish_reason: '', prompt_tokens: 0 }],
    ]
    for (const [reply, recorded] of replies) {
      env.AI = {
        websearch: noSearch,
        async run() {
          return reply
        },
      }
      const res = await chat(token)
      // The reply itself goes to the client as the model gave it, with what it cost when it is an object.
      const cost = { micro_credits: Number(recorded.prompt_tokens) * 300, estimated: false }
      const sent = typeof reply === 'object' && reply !== null && !Array.isArray(reply) ? { ...reply, cost } : reply
      expect([res.status, await json(res)]).toEqual([200, sent])
      expect(calls().at(-1)).toMatchObject({ outcome: 'ok', ...recorded })
    }
  })

  it('[@no-uc:money] a non-streamed reply without usage is still recorded', async () => {
    env.AI = {
      websearch: noSearch,
      async run() {
        return null
      },
    }
    expect((await chat(token)).status).toBe(200)
    expect(calls()[0]).toMatchObject({ outcome: 'ok', prompt_tokens: 0, completion_tokens: 0, finish_reason: '' })
  })

  it('[@no-uc:money] a failing usage dataset does not fail the request', async () => {
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

describe('UC-COFUN-CHAT-001 Ask the hosted model: tools', () => {
  it('[UC-COFUN-CHAT-001-S05] the streamed reply asks the extension to run tools, with their arguments', async () => {
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

  it('[UC-COFUN-CHAT-001-S05] the non-streamed reply asks the extension to run a tool', async () => {
    ai.toolCalls = [{ name: 'get_current_page', arguments: '{}' }]
    const res = await chat(token, { messages: askPage, tools })
    expect(res.status).toBe(200)
    const { choices } = await json(res)
    expect(choices[0].finish_reason).toBe('tool_calls')
    expect(choices[0].message.tool_calls).toEqual([
      { id: 'chatcmpl-tool-0', type: 'function', function: { name: 'get_current_page', arguments: '{}' } },
    ])
  })

  it('[UC-COFUN-CHAT-001-S06] the AI answers from the tool result the extension sends back', async () => {
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

  it('[UC-COFUN-CHAT-001-S07] nothing in tool definitions, calls, or results is kept', async () => {
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
    expect(calls().map((r) => r.finish_reason)).toEqual(['tool_calls', 'tool_calls'])
    expect(JSON.stringify(calls())).not.toContain(SECRET)
    expect(
      ai.calls.every((call) => {
        const gateway = call.options?.gateway as { collectLog?: boolean; skipCache?: boolean } | undefined
        return gateway?.collectLog === false && gateway.skipCache === true
      }),
    ).toBe(true)
  })
})

describe('tool calling', () => {
  it('[@no-uc:money] a streamed tool call leaves a record with its totals and finish reason', async () => {
    ai.toolCalls = [{ name: 'get_current_page', arguments: '{}' }]
    await (await chat(token, { messages: askPage, tools, stream: true })).text()
    expect(calls()).toEqual([
      expect.objectContaining({
        outcome: 'ok',
        finish_reason: 'tool_calls',
        prompt_tokens: FAKE_USAGE.prompt_tokens,
        completion_tokens: FAKE_USAGE.completion_tokens,
      }),
    ])
  })

  it('[@no-uc:money] an input over the model window is refused as a context overflow, and costs nothing', async () => {
    const res = await chat(token, { messages: [{ role: 'user', content: 'x'.repeat(3_200_000) }] })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toEqual({
      code: 'context_too_long',
      message: "the input exceeds the model's context window: its maximum context length is 1048576 tokens",
    })
    expect(ai.calls).toHaveLength(1)
    expect(db.rows('spends').map((row) => row.micro_credits)).toEqual([0])
  })

  it('[@no-uc:contract] passes only the tool fields the model needs', async () => {
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
      max_completion_tokens: 65_536,
    })
  })

  it('[@no-uc:contract] says what is wrong with each part of a request, and the first thing when several are', async () => {
    const call = { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }
    const tool = { type: 'function', function: { name: 'f' } }
    const refused: [unknown, string][] = [
      [[], 'body must be a JSON object'],
      [{}, 'messages must be a non-empty array'],
      [{ messages: [] }, 'messages must be a non-empty array'],
      [{ messages: ['hi'] }, 'each message must be an object'],
      [{ messages: [{ content: 'hi' }] }, 'each message needs a role: system, user, assistant, or tool'],
      [
        { messages: [{ role: 'developer', content: 'hi' }] },
        'each message needs a role: system, user, assistant, or tool',
      ],
      [{ messages: [{ role: 'user', content: 5 }] }, 'user messages need string content'],
      [{ messages: [{ role: 'system' }] }, 'system messages need string content'],
      [{ messages: [{ role: 'assistant' }] }, 'assistant messages need string content or tool_calls'],
      [
        { messages: [{ role: 'assistant', content: 5, tool_calls: [call] }] },
        'assistant content must be a string or null',
      ],
      [{ messages: [{ role: 'assistant', tool_calls: [] }] }, 'tool_calls must be an array of 1 to 32 calls'],
      [
        {
          messages: [
            { role: 'assistant', tool_calls: Array.from({ length: 33 }, (_, i) => ({ ...call, id: `c${i}` })) },
          ],
        },
        'tool_calls must be an array of 1 to 32 calls',
      ],
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
        {
          messages: askPage,
          tools: Array.from({ length: 65 }, (_, i) => ({ type: 'function', function: { name: `t${i}` } })),
        },
        'tools must be an array of 1 to 64 tools',
      ],
      [
        { messages: askPage, tools: [{ type: 'function', function: { name: 'x'.repeat(65) } }] },
        'tool names are 1 to 64 letters, digits, underscores, or dashes',
      ],
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
      [{ messages: askPage, max_tokens: 0 }, 'max_tokens must be an integer from 1 to 65536'],
      [{ messages: askPage, stream: 'yes' }, 'stream must be a boolean'],
      // The conversation is checked first, then the tools, then the settings.
      [{ messages: [], tools: [], max_tokens: 0, stream: 1 }, 'messages must be a non-empty array'],
      [{ messages: askPage, tools: [], max_tokens: 0, stream: 1 }, 'tools must be an array of 1 to 64 tools'],
      [
        { messages: askPage, max_tokens: 0, stream: 1, model: 'other' },
        'max_tokens must be an integer from 1 to 65536',
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

  it('[@no-uc:contract] tools without a description or parameters are allowed', async () => {
    const bare = [{ type: 'function', function: { name: 'ping' } }]
    expect((await chat(token, { messages: askPage, tools: bare })).status).toBe(200)
    expect(ai.calls[0].inputs.tools).toEqual(bare)
  })

  it('[@no-uc:contract] tool_choice auto and required are passed to the model', async () => {
    for (const tool_choice of ['auto', 'required']) {
      expect((await chat(token, { messages: askPage, tools, tool_choice })).status).toBe(200)
    }
    expect(ai.calls.map((c) => c.inputs.tool_choice)).toEqual(['auto', 'required'])
  })

  it('[@no-uc:contract] tool_choice none is refused, since the model does not honor it', async () => {
    const res = await chat(token, { messages: askPage, tools, tool_choice: 'none' })
    expect(res.status).toBe(400)
    expect((await json(res)).error.message).toContain('leave out tools')
    expect(ai.calls).toHaveLength(0)
  })

  it('[@no-uc:contract] each tool call gets one result right after it', async () => {
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

  it('[@no-uc:contract] an agent can run several tool rounds, even if ids repeat across rounds', async () => {
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

  it('[@no-uc:privacy] tool_choice with a malformed name is refused without echoing it', async () => {
    const name = 'x'.repeat(1000)
    const res = await chat(token, { messages: askPage, tools, tool_choice: { type: 'function', function: { name } } })
    expect(res.status).toBe(400)
    expect((await json(res)).error.message).not.toContain(name)
  })

  it('[@no-uc:contract] deeply nested tool parameters are refused, not a server error', async () => {
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
})
