// Web pages read for a signed-in user (/v1/web/read, /v1/web/render), through HTTP, with the
// internet and Browser Run answered by fakes.
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
const clock = new Date('2026-11-14T12:00:00Z')
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
let db: FakeD1Database
let ai: FakeAiBinding
let usage: RecordingUsage
let env: Env
let token: string

beforeAll(async () => {
  clerk = await FakeClerk.create()
})

beforeEach(async () => {
  logged = []
  env = {
    AI: (ai = new FakeAiBinding()),
    DB: (db = new FakeD1Database()),
    USAGE: (usage = new RecordingUsage()),
    CHAT_LIMIT: new FakeRateLimiter(),
    API_LIMIT: new FakeRateLimiter(),
    WEB_LIMIT: new FakeRateLimiter(),
    WEB: (web = new FakeWeb()),
    BROWSER: (browser = new FakeBrowserRun()),
    MODEL,
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

const ARTICLE = `<!doctype html><html><head><title>Tea &amp; history</title><script>track()</script></head>
<body><nav><a href="/">Home</a> <a href="/about">About</a></nav>
<main><h1>Tea</h1><p>Tea was first   drunk in China.</p><ul><li>Green</li><li>Black</li></ul>
<div hidden>secret draft</div></main><footer>© Tea site</footer></body></html>`

/** What the user can spend, in micro-credits: what is left of their grants. */
function balance(): number {
  return db.rows('grants').reduce((sum, g) => sum + Number(g.left), 0)
}

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
      cost: { micro_credits: 0 },
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

  it("[UC-COFUN-WEB-001-S05] a render costs its browser time at list price, is counted with the user's spending, and says what it cost", async () => {
    // 4 seconds of browser time at US$0.09 an hour: 0.1 credit.
    browser.render('https://app.example/board', '# Board', 4000)
    const res = await render('https://app.example/board')
    const body: { cost: { micro_credits: number } } = await res.json()
    expect(body.cost).toEqual({ micro_credits: 100_000 })
    const [call] = db.rows('model_calls')
    expect(call).toMatchObject({
      user_id: 'user_alice',
      model: 'web/render',
      micro_credits: 100_000,
      product: 'notico',
    })
    expect(balance()).toBe(200_000_000 - 100_000)
  })

  it('[UC-COFUN-WEB-001-S06] a user with no credits left is told when the next arrive, and nothing is rendered', async () => {
    ai.usage = usageCosting(201)
    const chat = await app.request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      },
      env,
      new FakeExecutionContext(),
    )
    expect(chat.status).toBe(200)
    await chat.text()
    expect(balance()).toBe(0)
    browser.render('https://app.example/board', '# Board')
    const res = await render('https://app.example/board')
    const body: { error: { code: string; message: string } } = await res.json()
    expect(res.status).toBe(402)
    expect(body.error.code).toBe('out_of_credits')
    expect(body.error.message).toMatch(/2026-11-21 at 12:00 UTC/)
    expect(browser.calls).toEqual([])
  })

  it('[UC-COFUN-WEB-001-S06] a render that fails costs nothing', async () => {
    expect(await refusal(await render('https://app.example/broken'))).toEqual({ status: 422, code: 'render_failed' })
    expect(db.rows('model_calls')).toEqual([])
  })

  it('[UC-COFUN-WEB-001-S07] a user over their limit of pages a minute is told to wait, and nothing is read', async () => {
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

  it('[@no-uc:money] a render whose record fails is not charged, and the page still goes out', async () => {
    browser.render('https://app.example/board', '# Board')
    db.failOn = { sql: 'INSERT INTO model_calls', error: new Error('D1 is down') }
    const res = await render('https://app.example/board')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ cost: { micro_credits: 0 } })
    expect(logged).toEqual(['render record failed: Error: D1 is down'])
  })
})
