import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type Env } from '../src/app'
import { FakeClerk } from './clerk'
import { FakeAiBinding } from './fakes'

const MODEL = '@cf/test/model'
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const app = createApp()

let clerk: FakeClerk
let otherClerk: FakeClerk
let ai: FakeAiBinding
let env: Env
let token: string

beforeAll(async () => {
  clerk = await FakeClerk.create()
  otherClerk = await FakeClerk.create()
})

beforeEach(async () => {
  ai = new FakeAiBinding()
  env = {
    AI: ai,
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

describe('UC-AUTH-002 API access requires a valid session', () => {
  it('GET /health needs no session (infrastructure)', async () => {
    expect((await req('GET', '/health')).status).toBe(200)
  })

  it('[UC-AUTH-002-S06] /v1/me returns the Clerk user id and model', async () => {
    const res = await req('GET', '/v1/me', token)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ userId: 'user_alice', model: MODEL })
  })

  it('[UC-AUTH-002-S01] request without a session is rejected', async () => {
    const res = await chat(undefined)
    expect(res.status).toBe(401)
    expect((await json(res)).error.code).toBe('unauthorized')
  })

  it('[UC-AUTH-002-S02] invalid, forged and expired tokens are rejected', async () => {
    const forged = await otherClerk.sessionToken({ userId: 'user_eve', azp: EXT })
    const expired = await clerk.sessionToken({ userId: 'user_alice', azp: EXT, expiresInSec: -60 })
    for (const bad of ['not-a-jwt', forged, expired]) {
      expect((await chat(bad)).status).toBe(401)
    }
    expect(ai.calls).toHaveLength(0)
  })

  it('[UC-AUTH-002-S03] token issued for another origin is rejected', async () => {
    const elsewhere = await clerk.sessionToken({ userId: 'user_alice', azp: 'https://evil.example' })
    expect((await chat(elsewhere)).status).toBe(401)
  })

  it('[UC-AUTH-002-S04] any allowed origin is accepted', async () => {
    const web = await clerk.sessionToken({ userId: 'user_alice', azp: 'https://notion-copilot.example' })
    expect((await chat(web)).status).toBe(200)
  })

  it('[UC-AUTH-002-S05] API is off without the JWT key', async () => {
    env.CLERK_JWT_KEY = undefined
    const res = await chat(token)
    expect(res.status).toBe(503)
    expect((await json(res)).error.code).toBe('not_configured')
  })

  it('[UC-AUTH-002-S07] extension origin passes CORS preflight', async () => {
    const res = await app.request(
      '/v1/chat/completions',
      { method: 'OPTIONS', headers: { origin: EXT, 'access-control-request-method': 'POST' } },
      env,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('UC-AUTH-001 Sign in through the web sign-in page', () => {
  it('[UC-AUTH-001-S01] sign-in page shows Clerk sign-in UI', async () => {
    env.CLERK_PUBLISHABLE_KEY = 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk' // example.clerk.accounts.dev
    const res = await req('GET', '/login')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    expect(html).toContain('data-clerk-publishable-key="pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk"')
    expect(html).toContain('src="https://example.clerk.accounts.dev/npm/@clerk/clerk-js@6/dist/clerk.browser.js"')
    expect(html).toContain('src="https://example.clerk.accounts.dev/npm/@clerk/ui@1/dist/ui.browser.js"')
  })

  it('[UC-AUTH-001-S02] root URL goes to the sign-in page', async () => {
    const res = await req('GET', '/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('[UC-AUTH-001-S03] sign-in page is off without a publishable key', async () => {
    expect((await req('GET', '/login')).status).toBe(503)
  })
})

describe('UC-CHAT-001 Chat from the side panel', () => {
  it('[UC-CHAT-001-S01] signed-in user gets a reply through the gateway', async () => {
    const res = await chat(token, { messages: hi, max_tokens: 50 })
    expect(res.status).toBe(200)
    expect((await json(res)).choices[0].message.content).toBe('Hello from Workers AI')
    expect(ai.calls[0]).toEqual({
      model: MODEL,
      inputs: { messages: hi, max_tokens: 50 },
      options: { gateway: { id: 'gw-test', metadata: { app: 'notion-copilot', user: 'user_alice' } } },
    })
  })

  it('[UC-CHAT-001-S04] without a gateway the model is called directly', async () => {
    env.AI_GATEWAY_ID = ''
    await chat(token)
    expect(ai.calls[0].options).toBeUndefined()
  })

  it('[UC-CHAT-001-S02] reply streams as server-sent events', async () => {
    const res = await chat(token, { messages: hi, stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const text = (await res.text())
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(6)).choices[0].delta.content)
      .join('')
    expect(text).toBe('Hello from Workers AI ')
  })

  it('[UC-CHAT-001-S05] invalid requests are rejected without calling the model', async () => {
    expect((await chat(token, { messages: [] })).status).toBe(400)
    expect((await chat(token, [1])).status).toBe(400)
    expect((await chat(token, { messages: hi, model: 'openai/gpt-5' })).status).toBe(400)
    expect(ai.calls).toHaveLength(0)
  })

  it('[UC-CHAT-001-S06] naming the server model is allowed', async () => {
    expect((await chat(token, { messages: hi, model: MODEL })).status).toBe(200)
  })

  it('[UC-CHAT-001-S07] model failure returns 502', async () => {
    ai.failWith = new Error('capacity')
    const res = await chat(token)
    expect(res.status).toBe(502)
    expect((await json(res)).error).toEqual({ code: 'provider_error', message: 'capacity' })
  })
})
