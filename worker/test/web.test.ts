// Web pages read for a signed-in user (/v1/web/read, /v1/web/render) and web searches
// (/v1/web/search), through HTTP, with the internet, Browser Run, and AI Gateway answered by fakes.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type Env } from '../src/app'
import type { UsageDataset } from '../src/usage'
import { FakeClerk } from './clerk'
import {
  FakeAiBinding,
  FakeBrowserRun,
  FakeD1Database,
  FakeExecutionContext,
  FakeRateLimiter,
  FakeWeb,
  MODEL,
  usageCosting,
} from './fakes'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const START = new Date('2026-11-14T12:00:00Z')
let clock = START
let logged: string[] = []
const app = createApp({ now: () => clock, logError: (line) => logged.push(line) })

/** Keeps every usage record written, to check what they hold. */
class RecordingUsage implements UsageDataset {
  points: { indexes?: string[]; blobs?: string[]; doubles?: number[] }[] = []
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }) {
    this.points.push(point)
  }
}

let clerk: FakeClerk
let web: FakeWeb
let browser: FakeBrowserRun
let ai: FakeAiBinding
let db: FakeD1Database
let usage: RecordingUsage
let env: Env
let token: string

beforeAll(async () => {
  clerk = await FakeClerk.create()
})

beforeEach(async () => {
  clock = START
  logged = []
  env = {
    AI: (ai = new FakeAiBinding()),
    DB: (db = new FakeD1Database()),
    USAGE: (usage = new RecordingUsage()),
    CHAT_LIMIT: new FakeRateLimiter(),
    API_LIMIT: new FakeRateLimiter(),
    WEB_LIMIT: new FakeRateLimiter(),
    RENDER_LIMIT: new FakeRateLimiter(),
    SEARCH_LIMIT: new FakeRateLimiter(),
    WEB: (web = new FakeWeb()),
    BROWSER: (browser = new FakeBrowserRun()),
    MODEL,
    AI_GATEWAY_ID: 'gw-test',
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: EXT,
  }
  token = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
})

function post(path: string, body: unknown) {
  return app.request(
    path,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-cofun-client': 'notico/0.4.0',
      },
      body: JSON.stringify(body),
    },
    env,
    new FakeExecutionContext(),
  )
}

const read = (url: string, max_chars = 20_000) => post('/v1/web/read', { url, max_chars })
const render = (url: string, max_chars = 20_000) => post('/v1/web/render', { url, max_chars })

/** The error a refused request carries, with its status. */
async function refusal(res: Response) {
  const body: { error: { code: string; message: string } } = await res.json()
  return { status: res.status, code: body.error.code }
}

const CREDIT = 1_000_000
/** What a render of 4 s of browser time costs, in micro-credits: 25 a ms. */
const RENDER_COST = 100_000

const ARTICLE = `<!doctype html><html><head><title>Tea &amp; history</title><script>track()</script></head>
<body><nav><a href="/">Home</a> <a href="/about">About</a></nav>
<main><h1>Tea</h1><p>Tea was first   drunk in China.</p><ul><li>Green</li><li>Black</li></ul>
<div hidden>secret draft</div></main><footer>© Tea site</footer></body></html>`

describe('reading a web page', () => {
  it("[UC-COFUN-WEB-001-S01] gives the page's title and main text, without menus, footers, scripts, or hidden text, at no cost", async () => {
    web.serve('https://tea.example/history', ARTICLE)
    const res = await read('https://tea.example/history#origins')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      url: 'https://tea.example/history',
      title: 'Tea & history',
      text: '# Tea\n\nTea was first drunk in China.\n\n- Green\n- Black',
      chars: 53,
      // Short, and it runs a script: the client is told the page may show more once rendered.
      scripted: true,
    })
    // Nothing is recorded as spent.
    expect(db.rows('model_calls')).toEqual([])
  })

  it('[UC-COFUN-WEB-001-S01] clips the text to what the client asks for, and says how long it all is', async () => {
    web.serve('https://tea.example/long', `<p>${'tea '.repeat(1000)}</p>`)
    const body: { text: string; chars: number } = await (await read('https://tea.example/long', 100)).json()
    expect(body.text).toHaveLength(100)
    expect(body.chars).toBe(3999)
  })

  it('[UC-COFUN-WEB-001-S01] reads plain text, and follows a redirect', async () => {
    web.serve('https://tea.example/notes', { status: 301, headers: { location: '/notes.txt' } })
    web.serve('https://tea.example/notes.txt', { body: 'Oolong\n\n\n\nPu-erh  ', type: 'text/plain' })
    const res = await read('https://tea.example/notes')
    expect(await res.json()).toMatchObject({ url: 'https://tea.example/notes.txt', text: 'Oolong\n\nPu-erh' })
  })

  it('[@no-uc:privacy] sends the site no cookie or credential, and names itself', async () => {
    web.serve('https://tea.example/history', ARTICLE)
    await read('https://tea.example/history')
    const [request] = web.requests
    expect(request.headers.get('cookie')).toBeNull()
    expect(request.headers.get('authorization')).toBeNull()
    expect(request.headers.get('user-agent')).toMatch(/Cofun/)
  })

  it.each([
    ['our own domain', 'https://api.cofun.cc/v1/me'],
    ['a sub-domain of it', 'https://static.cofun.cc/x'],
    ['localhost', 'http://localhost/admin'],
    ['a local network name', 'http://printer.local/'],
    ['a name with no dot', 'http://intranet/'],
    ['an IPv4 address', 'http://127.0.0.1/'],
    ['an IPv4 address in decimal', 'http://2130706433/'],
    ['an IPv6 address', 'http://[::1]/'],
    ['another port', 'https://tea.example:8443/'],
    ['a user name', 'https://admin@tea.example/'],
    ['another scheme', 'ftp://tea.example/file'],
    ['no URL at all', 'tea'],
  ])('[UC-COFUN-WEB-001-S02] refuses %s, and reaches nothing', async (_, url) => {
    expect(await refusal(await read(url))).toEqual({ status: 422, code: 'not_allowed' })
    expect(await refusal(await render(url))).toEqual({ status: 422, code: 'not_allowed' })
    expect(web.asked).toEqual([])
    expect(browser.calls).toEqual([])
  })

  it('[UC-COFUN-WEB-001-S02] refuses a redirect to an address it never reads, without following it', async () => {
    web.serve('https://tea.example/go', {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data' },
    })
    expect(await refusal(await read('https://tea.example/go'))).toEqual({ status: 422, code: 'not_allowed' })
    expect(web.asked).toEqual(['https://tea.example/go'])
  })

  it.each([
    ['a page that needs a sign-in', { status: 401 }, 'no_access'],
    ['a page the site refuses', { status: 403 }, 'no_access'],
    ['a bot check', { status: 403, headers: { 'cf-mitigated': 'challenge' } }, 'bot_check'],
    ['a site that is busy', { status: 429 }, 'site_busy'],
    ['a site that fails', { status: 503 }, 'site_error'],
    ['a PDF', { body: '%PDF-1.7', type: 'application/pdf' }, 'unsupported_type'],
    ['an image', { body: 'GIF89a', type: 'image/gif' }, 'unsupported_type'],
  ])('[UC-COFUN-WEB-001-S03] refuses %s with the reason', async (_, page, code) => {
    web.serve('https://tea.example/page', page)
    expect(await refusal(await read('https://tea.example/page'))).toEqual({ status: 422, code })
  })

  it('[UC-COFUN-WEB-001-S03] refuses a page that does not exist, and a site that cannot be reached', async () => {
    expect(await refusal(await read('https://tea.example/nothing'))).toEqual({ status: 422, code: 'not_found' })
    web.failWith = new TypeError('fetch failed')
    expect(await refusal(await read('https://tea.example/nothing'))).toEqual({ status: 422, code: 'unreachable' })
  })

  it('[UC-COFUN-WEB-001-S04] a page drawn by scripts shows no text read plainly, and its text once rendered', async () => {
    const shell =
      '<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
    web.serve('https://app.example/board', shell)
    browser.render('https://app.example/board', '# Board\n\nThree cards: Plan, Build, Ship.')
    expect(await refusal(await read('https://app.example/board'))).toEqual({ status: 422, code: 'no_text' })
    const res = await render('https://app.example/board')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      url: 'https://app.example/board',
      title: 'Board',
      text: '# Board\n\nThree cards: Plan, Build, Ship.',
    })
  })

  it('[UC-COFUN-WEB-001-S04] says a page that runs scripts and shows little text may be drawn by them', async () => {
    web.serve('https://app.example/home', '<body><p>Loading…</p><script src="/app.js"></script></body>')
    expect(await (await read('https://app.example/home')).json()).toMatchObject({ text: 'Loading…', scripted: true })
  })

  it('[UC-COFUN-WEB-001-S05] a render costs the browser time it used, and a user can have only a few pages rendered a minute', async () => {
    env.RENDER_LIMIT = new FakeRateLimiter(2)
    browser.render('https://app.example/board', '# Board', 4000)
    const res = await render('https://app.example/board')
    expect(res.status).toBe(200)
    // 4 s of browser time at US$0.09 an hour: 0.1 credit.
    expect(await res.json()).toMatchObject({ title: 'Board', cost: { micro_credits: RENDER_COST } })
    expect((await render('https://app.example/board')).status).toBe(200)
    expect(await refusal(await render('https://app.example/board'))).toEqual({ status: 429, code: 'rate_limited' })
    expect(browser.calls).toHaveLength(2)
    // Each render is a spend of its own, taken from the free grant the first one started.
    const charged = {
      user_id: 'user_alice',
      product: 'notico',
      kind: 'web_render',
      micro_credits: RENDER_COST,
      outcome: 'ok',
      browser_ms: 4000,
    }
    expect(db.renders()).toEqual([
      { ...charged, created_at: clock.getTime() },
      { ...charged, created_at: clock.getTime() },
    ])
    expect(db.grants()).toMatchObject([{ source: 'free', left: 200 * CREDIT - 2 * RENDER_COST }])
    expect(db.rows('model_calls')).toEqual([])
    // Reads are not held by the limit, and cost nothing.
    web.serve('https://tea.example/history', ARTICLE)
    expect((await read('https://tea.example/history')).status).toBe(200)
    expect(db.rows('spends')).toHaveLength(2)
  })

  it('[UC-COFUN-WEB-001-S07] a user with no credits left is refused a render, and nothing is rendered', async () => {
    // A reply that costs all 200 free credits.
    ai.usage = usageCosting(200)
    expect((await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] })).status).toBe(200)
    browser.render('https://app.example/board', '# Board')
    const res = await render('https://app.example/board')
    expect(res.status).toBe(402)
    const { error }: { error: { code: string; message: string } } = await res.json()
    expect(error.code).toBe('out_of_credits')
    expect(error.message).toContain('free credits arrive on 2026-11-21 at 12:00 UTC')
    expect(browser.calls).toEqual([])
    expect(db.renders()).toEqual([])
    // A plain read is free, so it still goes ahead.
    web.serve('https://tea.example/history', ARTICLE)
    expect((await read('https://tea.example/history')).status).toBe(200)
  })

  it('[UC-COFUN-WEB-001-S08] a render that gives no page still costs the browser time it used', async () => {
    browser.render('https://app.example/blank', '  \n ', 2000)
    browser.failedMs = 1500
    expect(await refusal(await render('https://app.example/blank'))).toEqual({ status: 422, code: 'no_text' })
    const broken = await render('https://app.example/broken')
    // The refusal says what the render cost, as a page's answer does.
    expect(await broken.clone().json()).toMatchObject({ cost: { micro_credits: 1500 * 25 } })
    expect(await refusal(broken)).toEqual({ status: 422, code: 'render_failed' })
    expect(db.renders()).toMatchObject([
      { kind: 'web_render', outcome: 'no_text', browser_ms: 2000, micro_credits: 2000 * 25 },
      { kind: 'web_render', outcome: 'render_failed', browser_ms: 1500, micro_credits: 1500 * 25 },
    ])
  })

  it('[@no-uc:money] a render Browser Run reports no time for costs the time it took, and one with no response costs nothing', async () => {
    browser.render('https://app.example/board', '# Board')
    browser.during = () => {
      clock = new Date(clock.getTime() + 3000)
    }
    browser.reportsTime = false
    expect((await render('https://app.example/board')).status).toBe(200)
    // No response at all: what Browser Run billed is not known, so the user is not charged a guess.
    browser.failWith = new Error('binding failed')
    expect(await refusal(await render('https://app.example/board'))).toEqual({ status: 422, code: 'render_failed' })
    expect(db.renders()).toMatchObject([
      { outcome: 'ok', browser_ms: 3000, micro_credits: 3000 * 25 },
      { outcome: 'render_failed', browser_ms: 3000, micro_credits: 0 },
    ])
  })

  it('[@no-uc:money] a render is refused when the credits cannot be read, and one whose record fails still gives the page', async () => {
    browser.render('https://app.example/board', '# Board')
    db.failWith = new Error('D1 is down')
    expect(await refusal(await render('https://app.example/board'))).toEqual({
      status: 503,
      code: 'credits_unavailable',
    })
    expect(browser.calls).toEqual([])
    db.failWith = undefined
    db.failOn = { sql: 'INSERT INTO web_renders', error: new Error('D1 write failed') }
    const res = await render('https://app.example/board')
    expect(res.status).toBe(200)
    // Nothing was charged, so the answer says no cost.
    const page: Record<string, unknown> = await res.json()
    expect(page).toMatchObject({ title: 'Board' })
    expect(page).not.toHaveProperty('cost')
    expect(db.rows('spends')).toEqual([])
    expect(logged.some((line) => line.startsWith('web render record failed'))).toBe(true)
  })

  it('[UC-COFUN-WEB-001-S04] a page Browser Run could not render is refused with the reason', async () => {
    expect(await refusal(await render('https://app.example/broken'))).toEqual({ status: 422, code: 'render_failed' })
  })

  it('[UC-COFUN-WEB-001-S06] a user over their limit of pages a minute is told to wait, and nothing is read', async () => {
    env.WEB_LIMIT = new FakeRateLimiter(1)
    web.serve('https://tea.example/history', ARTICLE)
    expect((await read('https://tea.example/history')).status).toBe(200)
    expect(await refusal(await read('https://tea.example/history'))).toEqual({ status: 429, code: 'rate_limited' })
    expect(await refusal(await render('https://tea.example/history'))).toEqual({ status: 429, code: 'rate_limited' })
    expect(web.asked).toHaveLength(1)
    expect(browser.calls).toEqual([])
  })

  it('[@no-uc:privacy] usage records and logs hold neither the address nor the page', async () => {
    web.serve('https://tea.example/history', ARTICLE)
    browser.render('https://app.example/board', '# Board')
    await read('https://tea.example/history')
    await read('https://tea.example/missing')
    await render('https://app.example/board')
    await render('https://app.example/broken')
    const written = JSON.stringify([usage.points, logged])
    expect(usage.points.map((p) => p.blobs?.slice(0, 2))).toEqual([
      ['web/fetch', 'ok'],
      ['web/fetch', 'not_found'],
      ['web/render', 'ok'],
      ['web/render', 'render_failed'],
    ])
    for (const leak of ['tea.example', 'app.example', 'Tea', 'Board']) expect(written).not.toContain(leak)
  })
})

const search = (query: string, limit = 10) => post('/v1/web/search', { query, limit })

const TEA_RESULTS = [
  { url: 'https://tea.example/history', title: 'Tea history', description: 'Tea was first drunk in China.' },
  { url: 'https://leaves.example/green', title: ' Green tea ', description: `${'Steamed leaves. '.repeat(200)}` },
  { url: 'https://cups.example/', title: 'Cups', description: 'Cups for tea.' },
]

describe('searching the web', () => {
  it("[UC-COFUN-WEB-002-S01] gives each result's address, title, and description, as many as asked for, at no cost", async () => {
    ai.found.set('tea history', TEA_RESULTS)
    const res = await search('  tea history ', 2)
    expect(res.status).toBe(200)
    const { results }: { results: { url: string; title: string; description: string }[] } = await res.json()
    expect(results.map((r) => [r.url, r.title])).toEqual([
      ['https://tea.example/history', 'Tea history'],
      ['https://leaves.example/green', 'Green tea'],
    ])
    expect(results[0].description).toBe('Tea was first drunk in China.')
    // A long description is clipped.
    expect(results[1].description).toHaveLength(1000)
    expect(results[1].description.endsWith('…')).toBe(true)
    // One search, through the gateway, with the fixed provider.
    expect(ai.searches).toEqual([{ gatewayId: 'gw-test', query: 'tea history', provider: 'ceramic', limit: 2 }])
    expect(db.rows('model_calls')).toEqual([])
    expect(db.rows('grants')).toEqual([])
  })

  it('[UC-COFUN-WEB-002-S01] a result whose address is too long to hand on uncut is left out', async () => {
    ai.found.set('tea', [
      { url: `https://tea.example/${'a'.repeat(2000)}`, title: 'Long', description: '' },
      TEA_RESULTS[0],
    ])
    const { results }: { results: { url: string }[] } = await (await search('tea')).json()
    expect(results.map((r) => r.url)).toEqual(['https://tea.example/history'])
  })

  it('[UC-COFUN-WEB-002-S01] a search that finds nothing gives no results', async () => {
    const res = await search('nothing at all')
    expect(await res.json()).toEqual({ results: [] })
  })

  it('[UC-COFUN-WEB-002-S02] a user over their limit of searches a minute is told to wait, and nothing is searched', async () => {
    env.SEARCH_LIMIT = new FakeRateLimiter(1)
    expect((await search('tea')).status).toBe(200)
    expect(await refusal(await search('tea'))).toEqual({ status: 429, code: 'rate_limited' })
    expect(ai.searches).toHaveLength(1)
    // Pages can still be read.
    web.serve('https://tea.example/history', ARTICLE)
    expect((await read('https://tea.example/history')).status).toBe(200)
  })

  const gatewayRefusal = (status: number, code: string) => () =>
    Response.json(
      { ok: false, error: { category: 'gateway', code, status, retryable: false, message: 'no' } },
      { status },
    )

  it.each([
    [
      'the gateway has no credits to pay for it',
      gatewayRefusal(402, 'web_search_payment_required'),
      503,
      'search_unavailable',
    ],
    ['the provider is busy', gatewayRefusal(429, 'rate_limited'), 503, 'search_busy'],
    ['the gateway fails', gatewayRefusal(500, 'internal_error'), 502, 'search_failed'],
    ['the answer is not JSON', () => new Response('<html>oops</html>'), 502, 'search_failed'],
    ['the answer has another shape', () => Response.json({ results: [] }), 502, 'search_failed'],
    [
      'the binding throws',
      () => {
        throw new Error('boom')
      },
      502,
      'search_failed',
    ],
  ])('[UC-COFUN-WEB-002-S03] a search is refused when %s, and not tried again', async (_, reply, status, code) => {
    ai.searchReply = reply
    expect(await refusal(await search('tea'))).toEqual({ status, code })
    expect(ai.searches).toHaveLength(1)
  })

  it('[@no-uc:privacy] usage records and logs hold neither the query nor the results', async () => {
    ai.found.set('oolong secrets', TEA_RESULTS)
    await search('oolong secrets')
    ai.searchReply = gatewayRefusal(402, 'web_search_payment_required')
    await search('oolong secrets')
    ai.searchReply = () => {
      throw new Error('failed for oolong secrets')
    }
    await search('oolong secrets')
    expect(usage.points.map((p) => p.blobs?.slice(0, 2))).toEqual([
      ['web/search', 'ok'],
      ['web/search', 'search_unavailable'],
      ['web/search', 'search_failed'],
    ])
    expect(logged).toEqual(['web search failed: 402 web_search_payment_required', 'web search failed: threw Error'])
    const written = JSON.stringify([usage.points, logged])
    for (const leak of ['oolong', 'tea.example', 'Tea history', 'China']) expect(written).not.toContain(leak)
  })
})
