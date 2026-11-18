// The client's web reads and searches against the real worker app (createApp() behind fetch), for
// what the two must agree on: what a render and a search cost, and which refusals turn the client away.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type Env } from '../../../worker/src/app'
import { FakeClerk } from '../../../worker/test/clerk'
import {
  FakeAiBinding,
  FakeBrowserRun,
  FakeD1Database,
  FakeExecutionContext,
  FakeRateLimiter,
  FakeUsageDataset,
  MODEL,
} from '../../../worker/test/fakes'
import { WorkerClient, WorkerError } from '../src'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const app = createApp({ now: () => new Date('2026-11-08T12:00:00Z') })
let clerk: FakeClerk
let env: Env
let ai: FakeAiBinding
let browser: FakeBrowserRun
let token: string

const realFetch = globalThis.fetch

beforeAll(async () => {
  clerk = await FakeClerk.create()
  // The client calls fetch(); route it into the worker app.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(new Request(input, init), undefined, env, new FakeExecutionContext())) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

beforeEach(async () => {
  env = {
    AI: (ai = new FakeAiBinding('Hello')),
    BROWSER: (browser = new FakeBrowserRun()),
    AI_GATEWAY_ID: 'gw-test',
    DB: new FakeD1Database(),
    USAGE: new FakeUsageDataset(),
    CHAT_LIMIT: new FakeRateLimiter(),
    API_LIMIT: new FakeRateLimiter(),
    WEB_LIMIT: new FakeRateLimiter(),
    RENDER_LIMIT: new FakeRateLimiter(),
    SEARCH_LIMIT: new FakeRateLimiter(),
    MODEL,
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: EXT,
  }
  token = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
})

describe('web reads and searches', () => {
  const worker = new WorkerClient({
    apiUrl: 'https://nk.example.dev/v1/',
    getToken: async () => token,
    clientName: 'notico/1.2.3',
    product: 'Notico',
  })
  /** What a read, a render, or a search gave the client: its result or its WorkerError, and what it was told it cost. */
  async function outcome<T>(call: (charged: (microCredits: number | undefined) => void) => Promise<T>) {
    const costs: (number | undefined)[] = []
    try {
      return { result: await call((cost) => costs.push(cost)), costs }
    } catch (err) {
      if (!(err instanceof WorkerError)) throw err
      return { error: { code: err.code, turnedAway: !!err.turnedAway, charged: err.charged }, costs }
    }
  }
  const render = (url: string) => outcome((charged) => worker.readWebPage(url, 1000, true, { charged }))
  const search = () => outcome((charged) => worker.searchWeb('tea', 5, { charged }))

  it('[@no-uc:contract] a render and a search say what they cost; failed ones cost nothing, and a busy one is turned away', async () => {
    browser.render('https://app.example/board', '# Board', 4000)
    expect(await render('https://app.example/board')).toMatchObject({ result: { title: 'Board' }, costs: [100_000] })
    const failed = { error: { code: 'render_failed', turnedAway: false, charged: false }, costs: [0] }
    expect(await render('https://app.example/broken')).toEqual(failed)
    browser.reply = () => Response.json({ success: false }, { status: 429 })
    const busy = { error: { code: 'render_busy', turnedAway: true, charged: false }, costs: [0] }
    expect(await render('https://app.example/board')).toEqual(busy)

    ai.found.set('tea', [{ url: 'https://tea.example/', title: 'Tea', description: 'About tea.' }])
    expect(await search()).toMatchObject({ result: [{ url: 'https://tea.example/' }], costs: [5_000_000] })
    ai.searchReply = () => Response.json({ results: [] })
    expect(await search()).toEqual({ error: { code: 'search_failed', turnedAway: false, charged: false }, costs: [0] })
  })

  it('[@no-uc:money] a Stop while the answer of a render is read throws the Stop, not an answer that could not be read', async () => {
    browser.render('https://app.example/board', '# Board')
    const controller = new AbortController()
    const toWorker = globalThis.fetch
    // As fetch does: once the request is aborted, reading its answer's body throws the abort.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await toWorker(input, init)
      const body = new ReadableStream({
        start(stream) {
          init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason))
          controller.abort()
        },
      })
      return new Response(body, { status: res.status, headers: res.headers })
    }) as typeof fetch
    try {
      const costs: (number | undefined)[] = []
      const read = worker.readWebPage('https://app.example/board', 1000, true, {
        signal: controller.signal,
        charged: (cost) => costs.push(cost),
      })
      await expect(read).rejects.toMatchObject({ name: 'AbortError' })
      expect(costs).toEqual([undefined])
    } finally {
      globalThis.fetch = toWorker
    }
  })
})
