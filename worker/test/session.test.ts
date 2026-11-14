// Every route the worker has, read from the app itself: those under /v1 refuse a request without
// a valid session, and the few outside it are the ones meant to be open. A route added in the wrong
// place fails here rather than going out without a session check.
import { describe, expect, it } from 'vitest'
import { createApp, type Env } from '../src/app'
import { FakeClerk } from './clerk'
import { FakeAiBinding, FakeD1Database, FakeUsageDataset, FakeRateLimiter, MODEL } from './fakes'

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

/** The routes of the app as Hono lists them, without middleware (which Hono lists as ALL). */
function routesOf(app: ReturnType<typeof createApp>): { method: string; path: string }[] {
  const routes = new Map<string, { method: string; path: string }>()
  for (const { method, path } of app.routes) if (method !== 'ALL') routes.set(`${method} ${path}`, { method, path })
  return [...routes.values()]
}

/** A request path for a route's path: each parameter filled in with a value of the right shape. */
const pathFor = (path: string) => path.replace(/:userId\b/g, 'user_alice').replace(/:\w+/g, 'x')

async function setup() {
  const clerk = await FakeClerk.create()
  const env: Env = {
    AI: new FakeAiBinding(),
    DB: new FakeD1Database(),
    USAGE: new FakeUsageDataset(),
    CHAT_LIMIT: new FakeRateLimiter(),
    MODEL,
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: EXTENSION,
  }
  return { app: createApp({ now: () => new Date('2026-11-13T12:00:00Z') }), env }
}

describe('routes and sessions', () => {
  it('lists only the open routes outside /v1', async () => {
    const { app } = await setup()
    const open = routesOf(app)
      .filter((r) => !r.path.startsWith('/v1'))
      .map((r) => `${r.method} ${r.path}`)
    expect(open.sort()).toEqual(
      [
        'GET /',
        'GET /admin',
        'GET /billing/cancelled',
        'GET /billing/paid',
        'GET /health',
        'GET /login',
        'POST /stripe/webhook',
      ].sort(),
    )
  })

  it('refuses every route under /v1 without a session', async () => {
    const { app, env } = await setup()
    const v1 = routesOf(app).filter((r) => r.path.startsWith('/v1'))
    expect(v1.length).toBeGreaterThanOrEqual(10)
    for (const { method, path } of v1) {
      const res = await app.request(pathFor(path), { method }, env)
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 })
    }
  })

  it('refuses every route under /v1 with a token that is not a valid session', async () => {
    const { app, env } = await setup()
    for (const { method, path } of routesOf(app).filter((r) => r.path.startsWith('/v1'))) {
      const res = await app.request(pathFor(path), { method, headers: { authorization: 'Bearer not-a-jwt' } }, env)
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 })
    }
  })
})
