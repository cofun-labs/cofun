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
    CLERK_AUTHORIZED_PARTIES: `${EXT}, https://notion-kit.example`,
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

describe('Clerk session auth', () => {
  it('GET /health needs no session', async () => {
    expect((await req('GET', '/health')).status).toBe(200)
  })

  it('GET /v1/me returns the Clerk user id', async () => {
    const res = await req('GET', '/v1/me', token)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ userId: 'user_alice', model: MODEL })
  })

  it('rejects a missing token', async () => {
    const res = await chat(undefined)
    expect(res.status).toBe(401)
    expect((await json(res)).error.code).toBe('unauthorized')
  })

  it('rejects garbage, a token signed by another key, and an expired token', async () => {
    const forged = await otherClerk.sessionToken({ userId: 'user_eve', azp: EXT })
    const expired = await clerk.sessionToken({ userId: 'user_alice', azp: EXT, expiresInSec: -60 })
    for (const bad of ['not-a-jwt', forged, expired]) {
      expect((await chat(bad)).status).toBe(401)
    }
    expect(ai.calls).toHaveLength(0)
  })

  it('rejects a token issued for another origin', async () => {
    const elsewhere = await clerk.sessionToken({ userId: 'user_alice', azp: 'https://evil.example' })
    expect((await chat(elsewhere)).status).toBe(401)
  })

  it('accepts any allowed origin from the list', async () => {
    const web = await clerk.sessionToken({ userId: 'user_alice', azp: 'https://notion-kit.example' })
    expect((await chat(web)).status).toBe(200)
  })

  it('is off when CLERK_JWT_KEY is not set', async () => {
    env.CLERK_JWT_KEY = undefined
    const res = await chat(token)
    expect(res.status).toBe(503)
    expect((await json(res)).error.code).toBe('not_configured')
  })

  it('answers CORS preflight from the extension', async () => {
    const res = await app.request(
      '/v1/chat/completions',
      { method: 'OPTIONS', headers: { origin: EXT, 'access-control-request-method': 'POST' } },
      env,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('POST /v1/chat/completions', () => {
  it('returns a completion via the gateway, tagged with the user', async () => {
    const res = await chat(token, { messages: hi, max_tokens: 50 })
    expect(res.status).toBe(200)
    expect((await json(res)).choices[0].message.content).toBe('Hello from Workers AI')
    expect(ai.calls[0]).toEqual({
      model: MODEL,
      inputs: { messages: hi, max_tokens: 50 },
      options: { gateway: { id: 'gw-test', metadata: { app: 'notion-kit', user: 'user_alice' } } },
    })
  })

  it('calls Workers AI directly when no gateway is set', async () => {
    env.AI_GATEWAY_ID = ''
    await chat(token)
    expect(ai.calls[0].options).toBeUndefined()
  })

  it('streams OpenAI-style SSE', async () => {
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

  it('rejects bad bodies and other models without calling the model', async () => {
    expect((await chat(token, { messages: [] })).status).toBe(400)
    expect((await chat(token, [1])).status).toBe(400)
    expect((await chat(token, { messages: hi, model: 'openai/gpt-5' })).status).toBe(400)
    expect(ai.calls).toHaveLength(0)
  })

  it('accepts the server model by name', async () => {
    expect((await chat(token, { messages: hi, model: MODEL })).status).toBe(200)
  })

  it('maps model failures to 502', async () => {
    ai.failWith = new Error('capacity')
    const res = await chat(token)
    expect(res.status).toBe(502)
    expect((await json(res)).error).toEqual({ code: 'provider_error', message: 'capacity' })
  })
})
