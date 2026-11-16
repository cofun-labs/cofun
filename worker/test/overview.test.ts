import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type Env } from '../src/app'
import type { Database, Statement } from '../src/credits'
import { FakeClerk } from './clerk'
import {
  FAKE_COST,
  FAKE_USAGE,
  FakeAiBinding,
  FakeBrowserRun,
  FakeD1Database,
  FakeExecutionContext,
  FakeUsageDataset,
  FakeRateLimiter,
  MODEL,
  usageCosting,
} from './fakes'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
/** The origin the tests reach the worker on, and so the origin of its admin page. */
const WORKER = 'http://localhost'
const DAY_MS = 24 * 60 * 60 * 1000
const CREDIT = 1_000_000
const START = new Date('2026-11-08T12:00:00Z')

/** A reply that read part of its prompt from the cache, and what it costs: 60 tokens at 300, 40 cached at 6, 10 written at 1200. */
const CACHED_USAGE = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } }
const CACHED_COST = 30_240

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
let browser: FakeBrowserRun
/** An operator, signed in on the admin page. */
let admin: string

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
    BROWSER: (browser = new FakeBrowserRun()),
    DB: (db = new FakeD1Database()),
    USAGE: new FakeUsageDataset(),
    CHAT_LIMIT: new FakeRateLimiter(),
    API_LIMIT: new FakeRateLimiter(),
    WEB_LIMIT: new FakeRateLimiter(),
    RENDER_LIMIT: new FakeRateLimiter(),
    SEARCH_LIMIT: new FakeRateLimiter(),
    MODEL,
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: `${EXT}, ${WORKER}`,
  }
  admin = await clerk.sessionToken({ userId: 'user_root', azp: WORKER, claims: { role: 'admin' } })
})

const json = (res: Response): Promise<any> => res.json()
/** Notico's header naming its product, as it sends it with every model request. */
const NOTICO = { 'x-cofun-client': 'notico/0.3.0' }

function req(method: string, path: string, bearer?: string, body?: unknown, more: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...more }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
  return app.request(path, init, env, new FakeExecutionContext())
}

const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms)
}
const at = (time: string) => {
  clock = new Date(time)
}
/** Every reply from now on costs this many credits. */
const repliesCost = (amount: number) => {
  ai.usage = usageCosting(amount)
}
/** The user with this name, signed in to the extension, asks the AI something. */
const ask = async (name: string) => {
  const bearer = await clerk.sessionToken({ userId: `user_${name}`, azp: EXT })
  return req('POST', '/v1/chat/completions', bearer, { messages: [{ role: 'user', content: 'hi' }] }, NOTICO)
}
const asks = async (name: string) => expect((await ask(name)).status).toBe(200)
const grant = async (name: string, credits: number, days: number) =>
  expect((await req('POST', `/v1/admin/accounts/user_${name}/grants`, admin, { credits, days })).status).toBe(200)

/** The query of a period: its first and last day, and anything else. */
const period = (from: string, to: string, more: Record<string, string | number> = {}) =>
  '?' + new URLSearchParams({ from, to, ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, String(v)])) })
const getOverview = (query: string, bearer = admin) => req('GET', `/v1/admin/overview${query}`, bearer)
const getAccounts = (query: string, bearer = admin) => req('GET', `/v1/admin/accounts${query}`, bearer)
/** What an operator sees of a period. */
const overview = async (from: string, to: string, more?: Record<string, string | number>) => {
  const res = await getOverview(period(from, to, more))
  expect(res.status).toBe(200)
  return json(res)
}
const accounts = async (from: string, to: string, more?: Record<string, string | number>) => {
  const res = await getAccounts(period(from, to, more))
  expect(res.status).toBe(200)
  return json(res)
}
/** One account's own record (UC-COFUN-ADMIN-001). */
const lookUp = async (userId: string) => json(await req('GET', `/v1/admin/accounts/${userId}`, admin))

const NOTHING = {
  granted: { free: 0, manual: 0, purchase: 0 },
  spent: 0,
  forgiven: 0,
  calls: 0,
  failedCalls: 0,
  cancelledCalls: 0,
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  renders: 0,
  failedRenders: 0,
  renderMs: 0,
  renderSpent: 0,
  searches: 0,
  failedSearches: 0,
  searchSpent: 0,
}

/** What a product or an account spent on no search. */
const NO_SEARCHES = { searches: 0, searchSpent: 0 }
/** What a product or an account spent on no render and no search. */
const NO_RENDERS = { renders: 0, renderSpent: 0, ...NO_SEARCHES }

/**
 * Three days of the service. Nov 8: alice asks once and bob twice, each starting a free week. Nov 9:
 * carol is granted 100 credits by hand and asks once, with part of the prompt cached; a call of
 * alice's fails. Nov 10: nothing, and the clock is left there.
 */
async function threeDays() {
  await asks('alice')
  await asks('bob')
  await asks('bob')

  later(DAY_MS)
  await grant('carol', 100, 30)
  ai.failWith = new Error('the model is down')
  expect((await ask('alice')).status).toBe(502)
  ai.failWith = undefined
  ai.usage = CACHED_USAGE
  await asks('carol')
  ai.usage = FAKE_USAGE

  later(DAY_MS)
}

describe('UC-COFUN-ADMIN-002 See granted and spent credits as a whole', () => {
  it('[UC-COFUN-ADMIN-002-S01] an operator sees what was granted and spent in a period, in all and for each day', async () => {
    await threeDays()
    const nov8 = {
      ...NOTHING,
      granted: { free: 400 * CREDIT, manual: 0, purchase: 0 },
      spent: 3 * FAKE_COST,
      calls: 3,
      promptTokens: 36,
      completionTokens: 15,
    }
    const nov9 = {
      ...NOTHING,
      granted: { free: 200 * CREDIT, manual: 100 * CREDIT, purchase: 0 },
      spent: CACHED_COST,
      calls: 2,
      failedCalls: 1,
      cancelledCalls: 0,
      promptTokens: 100,
      cachedTokens: 40,
      completionTokens: 10,
    }
    expect(await overview('2026-11-08', '2026-11-10')).toEqual({
      period: { from: Date.parse('2026-11-08T00:00:00Z'), to: Date.parse('2026-11-11T00:00:00Z'), utcOffset: 0 },
      totals: {
        granted: { free: 600 * CREDIT, manual: 100 * CREDIT, purchase: 0 },
        spent: 3 * FAKE_COST + CACHED_COST,
        forgiven: 0,
        calls: 5,
        failedCalls: 1,
        cancelledCalls: 0,
        promptTokens: 136,
        cachedTokens: 40,
        completionTokens: 25,
        renders: 0,
        failedRenders: 0,
        renderMs: 0,
        renderSpent: 0,
        searches: 0,
        failedSearches: 0,
        searchSpent: 0,
      },
      products: [{ product: 'notico', spent: 3 * FAKE_COST + CACHED_COST, calls: 5, ...NO_RENDERS }],
      days: [
        { day: '2026-11-08', ...nov8 },
        { day: '2026-11-09', ...nov9 },
        { day: '2026-11-10', ...NOTHING },
      ],
    })

    // One day of it is that day alone.
    expect(await overview('2026-11-09', '2026-11-09')).toMatchObject({
      totals: nov9,
      days: [{ day: '2026-11-09', ...nov9 }],
    })
  })

  it('[UC-COFUN-ADMIN-002-S10] an operator sees what each product spent, and what named no product', async () => {
    const askFrom = async (name: string, product: Record<string, string>) => {
      const bearer = await clerk.sessionToken({ userId: `user_${name}`, azp: EXT })
      const res = await req(
        'POST',
        '/v1/chat/completions',
        bearer,
        { messages: [{ role: 'user', content: 'hi' }] },
        product,
      )
      expect(res.status).toBe(200)
    }
    const CONFLUCO = { 'x-cofun-client': 'confluco/1.0.0' }
    // Alice uses both extensions, on two days.
    await asks('alice')
    await askFrom('alice', CONFLUCO)
    await askFrom('bob', CONFLUCO)
    // The same account, twice from a build that names no product.
    await askFrom('carol', {})
    await askFrom('carol', {})
    later(DAY_MS)
    await askFrom('alice', CONFLUCO)

    // The one that spent the most first.
    const { totals, products } = await overview('2026-11-08', '2026-11-09')
    expect(products).toEqual([
      { product: 'confluco', spent: 3 * FAKE_COST, calls: 3, ...NO_RENDERS },
      { product: 'unknown', spent: 2 * FAKE_COST, calls: 2, ...NO_RENDERS },
      { product: 'notico', spent: FAKE_COST, calls: 1, ...NO_RENDERS },
    ])
    // Every call counts under one product, so the products add up to the totals.
    expect(products.reduce((sum: number, p: { spent: number }) => sum + p.spent, 0)).toBe(totals.spent)
    expect(products.reduce((sum: number, p: { calls: number }) => sum + p.calls, 0)).toBe(totals.calls)

    // A period with no calls has no products.
    expect((await overview('2026-11-01', '2026-11-07')).products).toEqual([])
  })

  it('[UC-COFUN-ADMIN-002-S12] an operator sees the pages rendered, the browser time they used, and what they cost', async () => {
    browser.render('https://app.example/board', '# Board', 4000)
    browser.failedMs = 2000
    const renderAs = async (name: string, url: string, product: Record<string, string> = NOTICO) => {
      const bearer = await clerk.sessionToken({ userId: `user_${name}`, azp: EXT })
      return req('POST', '/v1/web/render', bearer, { url, max_chars: 1000 }, product)
    }
    // Alice renders a page, and one that fails: it used the browser, and costs nothing. Bob asks the
    // AI and renders from another product.
    expect((await renderAs('alice', 'https://app.example/board')).status).toBe(200)
    expect((await renderAs('alice', 'https://app.example/broken')).status).toBe(422)
    await asks('bob')
    expect((await renderAs('bob', 'https://app.example/board', { 'x-cofun-client': 'confluco/1.0.0' })).status).toBe(
      200,
    )
    later(DAY_MS)

    const ok = 4000 * 25
    const { totals, days, products } = await overview('2026-11-08', '2026-11-09')
    const renders = { renders: 3, failedRenders: 1, renderMs: 10_000, renderSpent: 2 * ok }
    expect(totals).toMatchObject({ spent: 2 * ok + FAKE_COST, calls: 1, ...renders })
    expect(days[0]).toMatchObject({ day: '2026-11-08', ...renders })
    expect(days[1]).toEqual({ day: '2026-11-09', ...NOTHING })
    expect(products).toEqual([
      {
        product: 'notico',
        spent: ok + FAKE_COST,
        calls: 1,
        renders: 2,
        renderSpent: ok,
        ...NO_SEARCHES,
      },
      { product: 'confluco', spent: ok, calls: 0, renders: 1, renderSpent: ok, ...NO_SEARCHES },
    ])
    expect((await accounts('2026-11-08', '2026-11-09')).accounts).toMatchObject([
      { userId: 'user_bob', spent: ok + FAKE_COST, calls: 1, renders: 1, renderSpent: ok },
      { userId: 'user_alice', spent: ok, calls: 0, renders: 2, renderSpent: ok },
    ])
  })

  it('[UC-COFUN-ADMIN-002-S13] an operator sees the web searches, the failed ones, and what they cost', async () => {
    env.AI_GATEWAY_ID = 'gw-test'
    ai.found.set('tea', [{ url: 'https://tea.example/', title: 'Tea', description: 'About tea.' }])
    const searchAs = async (name: string, product: Record<string, string> = NOTICO) => {
      const bearer = await clerk.sessionToken({ userId: `user_${name}`, azp: EXT })
      return req('POST', '/v1/web/search', bearer, { query: 'tea', limit: 5 }, product)
    }
    // Alice searches twice, and once more when the gateway turns the search away: that one costs
    // nothing. Bob asks the AI and searches from another product.
    expect((await searchAs('alice')).status).toBe(200)
    expect((await searchAs('alice')).status).toBe(200)
    ai.searchReply = () => Response.json({ ok: false, error: { code: 'rate_limited' } }, { status: 429 })
    expect((await searchAs('alice')).status).toBe(503)
    ai.searchReply = undefined
    await asks('bob')
    expect((await searchAs('bob', { 'x-cofun-client': 'confluco/1.0.0' })).status).toBe(200)
    later(DAY_MS)

    const one = 250_000
    const { totals, days, products } = await overview('2026-11-08', '2026-11-09')
    const searches = { searches: 4, failedSearches: 1, searchSpent: 3 * one }
    expect(totals).toMatchObject({ spent: 3 * one + FAKE_COST, calls: 1, renders: 0, ...searches })
    expect(days[0]).toMatchObject({ day: '2026-11-08', ...searches })
    expect(products).toEqual([
      {
        product: 'notico',
        spent: 2 * one + FAKE_COST,
        calls: 1,
        renders: 0,
        renderSpent: 0,
        searches: 3,
        searchSpent: 2 * one,
      },
      { product: 'confluco', spent: one, calls: 0, renders: 0, renderSpent: 0, searches: 1, searchSpent: one },
    ])
    expect((await accounts('2026-11-08', '2026-11-09')).accounts).toMatchObject([
      { userId: 'user_alice', spent: 2 * one, calls: 0, searches: 3, searchSpent: 2 * one },
      { userId: 'user_bob', spent: one + FAKE_COST, calls: 1, searches: 1, searchSpent: one },
    ])
  })

  it('[UC-COFUN-ADMIN-002-S14] an operator sees what was spent beyond the balance, and so forgiven', async () => {
    // Alice's first reply leaves her 50 of her 200 free credits; the second costs 150 and takes the
    // 50, so 100 are forgiven. Bob's reply is covered in full.
    repliesCost(150)
    await asks('alice')
    await asks('alice')
    repliesCost(10)
    await asks('bob')
    later(DAY_MS)

    const { totals, days } = await overview('2026-11-08', '2026-11-09')
    expect(totals).toMatchObject({ forgiven: 100 * CREDIT })
    expect(days).toMatchObject([
      { day: '2026-11-08', forgiven: 100 * CREDIT },
      { day: '2026-11-09', forgiven: 0 },
    ])
    expect((await accounts('2026-11-08', '2026-11-09')).accounts).toMatchObject([
      { userId: 'user_alice', spent: 300 * CREDIT, forgiven: 100 * CREDIT, balance: 0 },
      { userId: 'user_bob', forgiven: 0 },
    ])
  })

  it('[UC-COFUN-ADMIN-002-S09] a call the user stopped counts as a failed call, and as a cancelled one', async () => {
    await asks('alice')
    // Bob stops reading his reply partway.
    const bearer = await clerk.sessionToken({ userId: 'user_bob', azp: EXT })
    const res = await req('POST', '/v1/chat/completions', bearer, {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    // And a call of carol's fails at the model.
    ai.failWith = new Error('the model is down')
    expect((await ask('carol')).status).toBe(502)

    const { totals, days } = await overview('2026-11-08', '2026-11-08')
    expect(totals).toMatchObject({ calls: 3, failedCalls: 2, cancelledCalls: 1 })
    expect(days[0]).toMatchObject({ day: '2026-11-08', calls: 3, failedCalls: 2, cancelledCalls: 1 })
  })

  it('[UC-COFUN-ADMIN-002-S02] an operator sees the accounts of a period, the biggest spender first, with the balance their own record shows', async () => {
    await threeDays()
    // Dave is only granted credits, and bob's calls cost 40 credits and more beyond his week, which are forgiven.
    await grant('dave', 20, 30)
    repliesCost(240)
    await asks('bob')

    const listed = await accounts('2026-11-08', '2026-11-10')
    expect(listed).toEqual({
      period: { from: Date.parse('2026-11-08T00:00:00Z'), to: Date.parse('2026-11-11T00:00:00Z'), utcOffset: 0 },
      at: clock.getTime(),
      more: false,
      accounts: [
        {
          userId: 'user_bob',
          granted: 200 * CREDIT,
          spent: 240 * CREDIT + 2 * FAKE_COST,
          forgiven: 40 * CREDIT + 2 * FAKE_COST,
          calls: 3,
          ...NO_RENDERS,
          balance: 0,
        },
        {
          userId: 'user_carol',
          granted: 300 * CREDIT,
          spent: CACHED_COST,
          forgiven: 0,
          calls: 1,
          ...NO_RENDERS,
          balance: 300 * CREDIT - CACHED_COST,
        },
        // The call that failed is a call, and cost nothing.
        {
          userId: 'user_alice',
          granted: 200 * CREDIT,
          spent: FAKE_COST,
          forgiven: 0,
          calls: 2,
          ...NO_RENDERS,
          balance: 200 * CREDIT - FAKE_COST,
        },
        {
          userId: 'user_dave',
          granted: 20 * CREDIT,
          spent: 0,
          forgiven: 0,
          calls: 0,
          ...NO_RENDERS,
          balance: 20 * CREDIT,
        },
      ],
    })

    const agreesWithLookups = async (list: { accounts: { userId: string; balance: number }[] }) => {
      for (const account of list.accounts) {
        expect([account.userId, account.balance]).toEqual([account.userId, (await lookUp(account.userId)).balance])
      }
    }
    await agreesWithLookups(listed)

    // What was granted and spent is the period's; the balance is always now's. On Nov 9 alone bob
    // did nothing, and alice's only call failed.
    expect((await accounts('2026-11-09', '2026-11-09')).accounts).toEqual([
      {
        userId: 'user_carol',
        granted: 300 * CREDIT,
        spent: CACHED_COST,
        forgiven: 0,
        calls: 1,
        ...NO_RENDERS,
        balance: 300 * CREDIT - CACHED_COST,
      },
      {
        userId: 'user_alice',
        granted: 0,
        spent: 0,
        forgiven: 0,
        calls: 1,
        ...NO_RENDERS,
        balance: 200 * CREDIT - FAKE_COST,
      },
    ])

    // Once the free weeks have expired the period reads the same, and the balances are the new ones.
    later(8 * DAY_MS)
    const afterwards = await accounts('2026-11-08', '2026-11-10')
    expect(afterwards.accounts.map((a: any) => [a.userId, a.granted, a.spent])).toEqual(
      listed.accounts.map((a: any) => [a.userId, a.granted, a.spent]),
    )
    expect(afterwards.accounts.map((a: any) => [a.userId, a.balance])).toEqual([
      ['user_bob', 0],
      ['user_carol', 100 * CREDIT],
      ['user_alice', 0],
      ['user_dave', 20 * CREDIT],
    ])
    await agreesWithLookups(afterwards)
  })

  it('[UC-COFUN-ADMIN-002-S03] someone who is not an operator is refused the overview and the accounts', async () => {
    await threeDays()
    const strangers = [
      await clerk.sessionToken({ userId: 'user_alice', azp: EXT }),
      await clerk.sessionToken({ userId: 'user_eve', azp: WORKER, claims: { role: 'member' } }),
      await clerk.sessionToken({ userId: 'user_eve', azp: WORKER }),
      // An admin's session, but not one issued to the admin page.
      await clerk.sessionToken({ userId: 'user_root', azp: EXT, claims: { role: 'admin' } }),
      await clerk.sessionToken({ userId: 'user_root', claims: { role: 'admin' } }),
    ]
    for (const stranger of strangers) {
      const answers = [
        await getOverview(period('2026-11-08', '2026-11-10'), stranger),
        await getAccounts(period('2026-11-08', '2026-11-10'), stranger),
        // What is wrong with the request is not told either.
        await getOverview('', stranger),
        await getAccounts(period('2026-11-08', '2026-11-10', { limit: 0 }), stranger),
      ]
      for (const res of answers) {
        expect(res.status).toBe(403)
        expect(await json(res)).toEqual({ error: { code: 'forbidden', message: 'This account is not an admin.' } })
      }
    }
  })

  it('[UC-COFUN-ADMIN-002-S03] without a session nothing is shown', async () => {
    expect((await getOverview(period('2026-11-08', '2026-11-10'), '')).status).toBe(401)
    expect((await getAccounts(period('2026-11-08', '2026-11-10'), '')).status).toBe(401)
  })

  it('[UC-COFUN-ADMIN-002-S04] the first and last day of a period count in full, and nothing outside it', async () => {
    // Each user's first question also starts their free week, so grants and calls sit on the same edges.
    at('2026-11-08T23:59:59.999Z')
    await asks('early')
    at('2026-11-09T00:00:00.000Z')
    await asks('first')
    at('2026-11-10T23:59:59.999Z')
    await asks('last')
    at('2026-11-11T00:00:00.000Z')
    await asks('late')

    const one = { ...NOTHING, granted: { free: 200 * CREDIT, manual: 0, purchase: 0 }, spent: FAKE_COST, calls: 1, promptTokens: 12, completionTokens: 5 } // prettier-ignore
    const { totals, days } = await overview('2026-11-09', '2026-11-10')
    expect(days).toEqual([
      { day: '2026-11-09', ...one },
      { day: '2026-11-10', ...one },
    ])
    expect(totals).toMatchObject({
      granted: { free: 400 * CREDIT, manual: 0, purchase: 0 },
      spent: 2 * FAKE_COST,
      calls: 2,
    })
    expect((await accounts('2026-11-09', '2026-11-10')).accounts.map((a: any) => a.userId)).toEqual([
      'user_first',
      'user_last',
    ])

    // The days on either side hold the rest.
    expect((await overview('2026-11-08', '2026-11-08')).totals.calls).toBe(1)
    expect((await overview('2026-11-11', '2026-11-11')).totals.calls).toBe(1)
    expect((await overview('2026-11-08', '2026-11-11')).totals.calls).toBe(4)
  })

  it('[UC-COFUN-ADMIN-002-S05] a grant or a call counts on the day it happened on the operator’s clock', async () => {
    at('2026-11-08T05:00:00Z')
    await asks('alice')
    at('2026-11-08T18:00:00Z')
    await asks('bob')

    const callsPerDay = async (utcOffset?: number) => {
      const { days } = await overview('2026-11-07', '2026-11-09', utcOffset === undefined ? {} : { utcOffset })
      return days.map((d: any) => [d.day, d.calls, d.granted.free / CREDIT])
    }
    // In UTC both happened on Nov 8.
    const utc = [
      ['2026-11-07', 0, 0],
      ['2026-11-08', 2, 400],
      ['2026-11-09', 0, 0],
    ]
    expect(await callsPerDay()).toEqual(utc)
    expect(await callsPerDay(0)).toEqual(utc)
    // Eight hours ahead of UTC, 18:00 UTC is 02:00 the next day.
    expect(await callsPerDay(480)).toEqual([
      ['2026-11-07', 0, 0],
      ['2026-11-08', 1, 200],
      ['2026-11-09', 1, 200],
    ])
    // Ten hours behind UTC, 05:00 UTC is 19:00 the day before.
    expect(await callsPerDay(-600)).toEqual([
      ['2026-11-07', 1, 200],
      ['2026-11-08', 1, 200],
      ['2026-11-09', 0, 0],
    ])

    // The accounts of a day are the accounts of that same day.
    const on = async (day: string, utcOffset: number) =>
      (await accounts(day, day, { utcOffset })).accounts.map((a: any) => a.userId)
    expect(await on('2026-11-09', 480)).toEqual(['user_bob'])
    expect(await on('2026-11-08', 480)).toEqual(['user_alice'])
    expect(await on('2026-11-07', -600)).toEqual(['user_alice'])
    expect((await accounts('2026-11-09', '2026-11-09', { utcOffset: 480 })).period).toEqual({
      from: Date.parse('2026-11-08T16:00:00Z'),
      to: Date.parse('2026-11-09T16:00:00Z'),
      utcOffset: 480,
    })
  })

  it('[UC-COFUN-ADMIN-002-S06] a period with more accounts than the list shows gives the biggest spenders, and says there are more', async () => {
    for (const [name, cost] of [
      ['ann', 3],
      ['ben', 40],
      ['cat', 7],
      ['dan', 15],
    ] as const) {
      repliesCost(cost)
      await asks(name)
    }
    const top = await accounts('2026-11-08', '2026-11-08', { limit: 3 })
    expect(top.accounts.map((a: any) => [a.userId, Math.round(a.spent / CREDIT)])).toEqual([
      ['user_ben', 40],
      ['user_dan', 15],
      ['user_cat', 7],
    ])
    expect(top.more).toBe(true)

    const all = await accounts('2026-11-08', '2026-11-08', { limit: 4 })
    expect(all.accounts.map((a: any) => a.userId)).toEqual(['user_ben', 'user_dan', 'user_cat', 'user_ann'])
    expect(all.more).toBe(false)
  })

  it('[UC-COFUN-ADMIN-002-S07] a period that is too long, ends before it starts, or is not a period is refused', async () => {
    const cases: [string, string][] = [
      // 93 days.
      [period('2026-08-10', '2026-11-10'), 'the period must be at most 92 days'],
      [period('2025-01-01', '2026-11-10'), 'the period must be at most 92 days'],
      [period('2026-11-10', '2026-11-09'), 'to must not be before from'],
      ['', 'from must be a date like 2026-11-12'],
      ['?from=2026-11-08', 'to must be a date like 2026-11-12'],
      ['?to=2026-11-08', 'from must be a date like 2026-11-12'],
      [period('2026-11-8', '2026-11-10'), 'from must be a date like 2026-11-12'],
      [period('2026-02-30', '2026-03-10'), 'from must be a date like 2026-11-12'],
      [period('2026-11-08', '2026-11-31'), 'to must be a date like 2026-11-12'],
      [period('2026-11-08', '2026-13-01'), 'to must be a date like 2026-11-12'],
      [period('2026-11-08', 'tomorrow'), 'to must be a date like 2026-11-12'],
      [period('1999-11-08', '1999-11-10'), 'from must be a date like 2026-11-12'],
      [period('1762560000000', '2026-11-10'), 'from must be a date like 2026-11-12'],
      [period('2026-11-08', '2026-11-10', { utcOffset: 841 }), 'utcOffset must be a whole number of minutes from -840 to 840'], // prettier-ignore
      [period('2026-11-08', '2026-11-10', { utcOffset: -841 }), 'utcOffset must be a whole number of minutes from -840 to 840'], // prettier-ignore
      [period('2026-11-08', '2026-11-10', { utcOffset: '8h' }), 'utcOffset must be a whole number of minutes from -840 to 840'], // prettier-ignore
      [period('2026-11-08', '2026-11-10', { utcOffset: 1.5 }), 'utcOffset must be a whole number of minutes from -840 to 840'], // prettier-ignore
      [period('2026-11-08', '2026-11-10', { utcOffset: '' }), 'utcOffset must be a whole number of minutes from -840 to 840'], // prettier-ignore
    ]
    for (const [query, message] of cases) {
      for (const res of [await getOverview(query), await getAccounts(query)]) {
        expect([query, res.status]).toEqual([query, 400])
        expect(await json(res)).toEqual({ error: { code: 'bad_request', message } })
      }
    }

    // The limits themselves are allowed: 92 days, a single day, and the furthest clocks.
    expect((await overview('2026-08-11', '2026-11-10')).days).toHaveLength(92)
    expect((await overview('2026-11-10', '2026-11-10')).days).toHaveLength(1)
    expect((await overview('2026-11-10', '2026-11-10', { utcOffset: 840 })).days).toHaveLength(1)
    expect((await overview('2026-11-10', '2026-11-10', { utcOffset: -840 })).days).toHaveLength(1)
    expect((await getAccounts(period('2026-08-11', '2026-11-10'))).status).toBe(200)
  })

  it('[UC-COFUN-ADMIN-002-S08] looking at the overview and the accounts changes no account and starts no free week', async () => {
    // Alice's free week has run out, and carol has only credits granted by hand.
    await asks('alice')
    await grant('carol', 50, 30)
    later(8 * DAY_MS)
    const before = JSON.stringify([db.rows('grants'), db.rows('model_calls')])

    await overview('2026-11-08', '2026-11-16')
    expect((await accounts('2026-11-08', '2026-11-16')).accounts).toEqual([
      {
        userId: 'user_alice',
        granted: 200 * CREDIT,
        spent: FAKE_COST,
        forgiven: 0,
        calls: 1,
        ...NO_RENDERS,
        balance: 0,
      },
      {
        userId: 'user_carol',
        granted: 50 * CREDIT,
        spent: 0,
        forgiven: 0,
        calls: 0,
        ...NO_RENDERS,
        balance: 50 * CREDIT,
      },
    ])
    expect(JSON.stringify([db.rows('grants'), db.rows('model_calls')])).toBe(before)

    // Each free week still starts, in full, with the user's own next question.
    await asks('alice')
    await asks('carol')
    for (const name of ['alice', 'carol']) {
      const { grants } = await lookUp(`user_${name}`)
      expect(grants.at(-1)).toEqual({
        source: 'free',
        amount: 200 * CREDIT,
        left: 200 * CREDIT - FAKE_COST,
        grantedAt: clock.getTime(),
        expiresAt: clock.getTime() + 7 * DAY_MS,
      })
    }
  })
})

/** The database, remembering every statement the worker prepared on it. */
class RecordingDatabase implements Database {
  readonly queries: string[] = []
  constructor(private readonly inner: FakeD1Database) {}

  prepare(query: string): Statement {
    this.queries.push(query)
    return this.inner.prepare(query)
  }

  batch(statements: Statement[]) {
    return this.inner.batch(statements)
  }
}

// Standalone tests: implementation behavior worth guarding, not product contract (see docs/bdd.md).
describe('admin overview API', () => {
  it('[@no-uc:money] every query reads only the period’s rows, through the time indexes, and no whole table', async () => {
    await threeDays()
    const recording = new RecordingDatabase(db)
    env.DB = recording
    await overview('2026-11-08', '2026-11-10', { utcOffset: 480 })
    await accounts('2026-11-08', '2026-11-10', { utcOffset: 480 })
    expect(recording.queries).toHaveLength(4)

    const plans = recording.queries.map((query) =>
      db.sqlite
        .prepare(`EXPLAIN QUERY PLAN ${query}`)
        .all(...[1, 2, 3, 4].filter((n) => query.includes(`?${n}`)))
        .map((step) => String(step.detail)),
    )
    for (const plan of plans) {
      // A scan of a CTE's own result is fine; a scan of a table is not.
      expect(
        plan.filter((step) =>
          /^SCAN (grants|spends|spend_grants|model_calls|web_renders|web_searches|grant_revocations)\b/.test(step),
        ),
      ).toEqual([])
    }
    const [granted, spent, byProduct, listed] = plans
    const bySpendTime = 'SEARCH s USING INDEX spends_by_time (created_at>? AND created_at<?)'
    // A spend's detail row is found by the spend, through the index of its unique spend_id.
    const callOfSpend =
      /^SEARCH [mrw] USING (COVERING )?INDEX sqlite_autoindex_(model_calls|web_renders|web_searches)_\d \(spend_id=\?\)/
    expect(granted).toContain('SEARCH grants USING INDEX grants_by_time (granted_at>? AND granted_at<?)')
    expect(spent).toContain(bySpendTime)
    expect(spent.some((step) => callOfSpend.test(step))).toBe(true)
    expect(byProduct).toContain(bySpendTime)
    expect(byProduct.some((step) => callOfSpend.test(step))).toBe(true)
    expect(listed).toContain('SEARCH grants USING INDEX grants_by_time (granted_at>? AND granted_at<?)')
    expect(listed).toContain(bySpendTime)
    // Every other read of the tables is one account's balance: its grants through an index that starts
    // with the user, and what was spent from each grant or whether it was taken back, by the grant.
    const others = listed.filter(
      (step) =>
        /^SEARCH \w+ USING/.test(step) &&
        !step.includes('_by_time') &&
        !callOfSpend.test(step) &&
        !step.includes('sqlite_autoindex_spend_grants_'),
    )
    expect(others.length).toBeGreaterThan(0)
    for (const step of others) expect(step).toMatch(/USING (COVERING )?INDEX \w+ \((user_id|grant_id)=\?/)
    // What a spend took from the grants, for what was forgiven, is found by the spend.
    for (const plan of [spent, listed])
      expect(plan).toContain('SEARCH sg USING INDEX sqlite_autoindex_spend_grants_1 (spend_id=?)')
  })

  it('[@no-uc:privacy] looking at the overview logs nothing', async () => {
    await threeDays()
    logged = []
    await overview('2026-11-08', '2026-11-10')
    await accounts('2026-11-08', '2026-11-10')
    expect(adminLog.filter((line) => !line.startsWith('manual grant:'))).toEqual([])
    expect(logged).toEqual([])
  })

  it('[@no-uc:money] an unreachable database refuses the overview and the accounts', async () => {
    db.failWith = new Error('D1_ERROR: Network connection lost.')
    for (const res of [
      await getOverview(period('2026-11-08', '2026-11-10')),
      await getAccounts(period('2026-11-08', '2026-11-10')),
    ]) {
      expect(res.status).toBe(503)
      expect(await json(res)).toEqual({
        error: { code: 'credits_unavailable', message: 'Credits are unavailable, try again in a moment.' },
      })
    }
    expect(logged).toEqual([
      'admin overview failed: Error: D1_ERROR: Network connection lost.',
      'admin overview failed: Error: D1_ERROR: Network connection lost.',
    ])
  })
})
