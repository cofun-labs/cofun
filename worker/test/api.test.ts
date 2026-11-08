import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type Env } from '../src/app'
import { FakeClerk } from './clerk'
import { FAKE_USAGE, FakeAiBinding, FakeQuotaNamespace, FakeUsageDataset } from './fakes'

const MODEL = '@cf/test/model'
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
let clock = new Date('2026-11-08T12:00:00Z')
const app = createApp({ now: () => clock })

let clerk: FakeClerk
let otherClerk: FakeClerk
let ai: FakeAiBinding
let quota: FakeQuotaNamespace
let usage: FakeUsageDataset
let env: Env
let token: string

beforeAll(async () => {
  clerk = await FakeClerk.create()
  otherClerk = await FakeClerk.create()
})

beforeEach(async () => {
  ai = new FakeAiBinding()
  clock = new Date('2026-11-08T12:00:00Z')
  env = {
    AI: ai,
    QUOTA: (quota = new FakeQuotaNamespace()),
    USAGE: (usage = new FakeUsageDataset()),
    DAILY_REQUEST_LIMIT: '100',
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
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env)
}

const hi = [{ role: 'user', content: 'hi' }]
const chat = (bearer: string | undefined, body: unknown = { messages: hi }) =>
  req('POST', '/v1/chat/completions', bearer, body)

describe('UC-AUTH-001 Sign in to use Copilot', () => {
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
    expect((await chat(token, { messages: hi, model: 'openai/gpt-5' })).status).toBe(400)
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
    expect(html).toContain('data-clerk-publishable-key="pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk"')
    expect(html).toContain('src="https://example.clerk.accounts.dev/npm/@clerk/clerk-js@6/dist/clerk.browser.js"')
    expect(html).toContain('src="https://example.clerk.accounts.dev/npm/@clerk/ui@1/dist/ui.browser.js"')
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
        gateway: { id: 'gw-test', collectLog: false, metadata: { app: 'notion-copilot', user: 'user_alice' } },
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
    expect(ai.calls[0].inputs).toEqual({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096 })
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

describe('UC-CHAT-001 daily quota', () => {
  beforeEach(() => {
    env.DAILY_REQUEST_LIMIT = '2'
  })

  it("[UC-CHAT-001-S04] a user over today's quota is refused and the model is not called", async () => {
    expect((await chat(token)).status).toBe(200)
    expect((await chat(token)).status).toBe(200)
    const res = await chat(token)
    expect(res.status).toBe(429)
    const { error } = await json(res)
    expect(error.code).toBe('rate_limited')
    expect(error.message).toContain('00:00 UTC')
    expect(ai.calls).toHaveLength(2)
  })

  it('[UC-CHAT-001-S05] the quota resets at 00:00 UTC', async () => {
    clock = new Date('2026-11-08T23:59:59Z')
    await chat(token)
    await chat(token)
    expect((await chat(token)).status).toBe(429)
    clock = new Date('2026-11-09T00:00:00Z')
    expect((await chat(token)).status).toBe(200)
  })

  it('each user has their own quota', async () => {
    await chat(token)
    await chat(token)
    expect((await chat(token)).status).toBe(429)
    const bob = await clerk.sessionToken({ userId: 'user_bob', azp: EXT })
    expect((await chat(bob)).status).toBe(200)
  })

  it('rejected requests do not use up the quota', async () => {
    await chat(undefined)
    await chat(token, { messages: [] })
    await chat(token, { messages: hi, model: 'other' })
    expect((await chat(token)).status).toBe(200)
    expect((await chat(token)).status).toBe(200)
  })

  it('a request stamped with an earlier day does not reset the quota', async () => {
    clock = new Date('2026-11-09T00:00:01Z')
    await chat(token)
    await chat(token)
    // Another instance whose clock still reads the previous day.
    clock = new Date('2026-11-08T23:59:59Z')
    expect((await chat(token)).status).toBe(429)
    clock = new Date('2026-11-09T00:00:02Z')
    expect((await chat(token)).status).toBe(429)
  })

  it('an unavailable quota counter refuses the request without calling the model', async () => {
    quota.failWith = new Error('Durable Object reset because its code was updated')
    const res = await chat(token)
    expect(res.status).toBe(503)
    const { error } = await json(res)
    expect(error.code).toBe('quota_unavailable')
    expect(error.message).not.toContain('Durable Object')
    expect(ai.calls).toHaveLength(0)
  })

  it('a limit of 0 turns chat off without promising a reset', async () => {
    env.DAILY_REQUEST_LIMIT = '0'
    const res = await chat(token)
    expect(res.status).toBe(503)
    const { error } = await json(res)
    expect(error.code).toBe('chat_disabled')
    expect(error.message).not.toContain('00:00 UTC')
    expect(ai.calls).toHaveLength(0)
  })

  it('chat is off without a valid daily limit', async () => {
    for (const bad of [undefined, '', 'abc', '-1']) {
      env.DAILY_REQUEST_LIMIT = bad
      expect((await chat(token)).status).toBe(503)
    }
    expect(ai.calls).toHaveLength(0)
  })
})

/** Reads a usage data point back into named fields, following the layout in src/usage.ts. */
function usageRecord(point: FakeUsageDataset['points'][number]) {
  const [userId] = point.indexes ?? []
  const [model, outcome, finishReason, mode] = point.blobs ?? []
  const [messages, inputChars, promptTokens, completionTokens, latencyMs] = point.doubles ?? []
  return { userId, model, outcome, finishReason, mode, messages, inputChars, promptTokens, completionTokens, latencyMs }
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
        latencyMs: expect.any(Number),
      },
    ])
    expect(records()[0].latencyMs).toBeGreaterThanOrEqual(0)
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
      }),
    ])
  })

  it('[UC-CHAT-002-S02] refused and failed requests leave a record of how they ended', async () => {
    env.DAILY_REQUEST_LIMIT = '1'
    await chat(token, { messages: [] })
    await chat(token)
    await chat(token)
    env.DAILY_REQUEST_LIMIT = '100'
    ai.failWith = new Error('capacity')
    await chat(token)
    ai.failWith = undefined
    quota.failWith = new Error('Durable Object reset')
    await chat(token)
    expect(records().map((r) => r.outcome)).toEqual([
      'bad_request',
      'ok',
      'rate_limited',
      'provider_error',
      'quota_unavailable',
    ])
    expect(records().every((r) => r.userId === 'user_alice')).toBe(true)
  })

  it('[UC-CHAT-002-S02] a stream that breaks off leaves a record of how it ended', async () => {
    ai.streamFailWith = new Error('connection reset')
    const res = await chat(token, { messages: hi, stream: true })
    await expect(res.text()).rejects.toThrow('connection reset')
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
    // The gateway is told not to keep prompts and replies in its logs.
    expect(
      ai.calls.every((call) => (call.options?.gateway as { collectLog?: boolean } | undefined)?.collectLog === false),
    ).toBe(true)
  })
})

// Standalone tests for usage records.
describe('usage records', () => {
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
