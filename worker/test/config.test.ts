// The deployed worker's config (wrangler.jsonc) and the hosted extension's build config
// (extensions/notico/.env) name the worker's address in several places. They must agree, or the extension
// calls a host the worker isn't on, or no session from the admin page is accepted.
import { readFileSync } from 'node:fs'
import { experimental_readRawConfig } from 'wrangler'
import { describe, expect, it } from 'vitest'
import { createApp, type Env } from '../src/app'
import { packsOf } from '../src/billing'
import { FakeClerk } from './clerk'
import { FakeAiBinding, FakeD1Database, FakeUsageDataset, MODEL } from './fakes'

const { rawConfig } = experimental_readRawConfig({ config: new URL('../wrangler.jsonc', import.meta.url).pathname })
const routes = rawConfig.routes ?? []
const route = routes[0]
const host = typeof route === 'object' && 'custom_domain' in route ? route.pattern : undefined
/** The origin the deployed worker is reached on, and so the origin of its admin page. */
const ORIGIN = `https://${host}`
const AUTHORIZED_PARTIES = String(rawConfig.vars?.CLERK_AUTHORIZED_PARTIES)

/** The committed build config of the hosted extension (extensions/notico/.env), as `KEY=value` lines. */
function hostedEnv(): Record<string, string> {
  const text = readFileSync(new URL('../../extensions/notico/.env', import.meta.url), 'utf8')
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => /^\w+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
  )
}

describe("the deployed worker's address", () => {
  it('is one custom domain, on api.cofun.cc', () => {
    expect(routes).toHaveLength(1)
    expect(ORIGIN).toBe('https://api.cofun.cc')
  })

  it('is where the hosted extension signs in and calls the API', () => {
    const env = hostedEnv()
    expect(env.VITE_CLERK_SYNC_HOST).toBe(ORIGIN)
    expect(env.VITE_API_URL).toBe(`${ORIGIN}/v1`)
  })

  it('accepts an admin session from the admin page on that address', async () => {
    const clerk = await FakeClerk.create()
    const env: Env = {
      AI: new FakeAiBinding(),
      DB: new FakeD1Database(),
      USAGE: new FakeUsageDataset(),
      MODEL,
      CLERK_JWT_KEY: clerk.publicKeyPem,
      CLERK_AUTHORIZED_PARTIES: AUTHORIZED_PARTIES,
    }
    const app = createApp({ now: () => new Date('2026-11-13T12:00:00Z') })
    const token = await clerk.sessionToken({ userId: 'user_root', azp: ORIGIN, claims: { role: 'admin' } })
    const res = await app.request(
      `${ORIGIN}/v1/admin/accounts/user_alice`,
      { headers: { authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
  })
})

describe("the deployed worker's packs of credits", () => {
  it('are the four packs of the live Stripe account, and read as valid packs', () => {
    expect(packsOf(rawConfig.vars?.STRIPE_PACKS)).toEqual({
      packs: [
        { price: 'price_1UbL2eCT6MhL4FCm0k5RiqQk', credits: 5000 },
        { price: 'price_1UbL3MCT6MhL4FCmBnIas1Di', credits: 10_000 },
        { price: 'price_1UbL3xCT6MhL4FCm5T56YbQo', credits: 20_000 },
        { price: 'price_1UbL4PCT6MhL4FCmNck3f2Gh', credits: 50_000 },
      ],
    })
  })
})
