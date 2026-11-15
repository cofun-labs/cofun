// Loads the built extension (extensions/notico/dist) into Chromium and checks that it still works there.
// Nothing leaves the machine: Notion, the other site, Clerk's Frontend API, and (signed in) the worker
// and its model are answered from fixtures/ and fakes.ts, usage events are taken and dropped, and any other request fails the test. The extension's own code and its bundled
// dependencies run unchanged.
import {
  chromium,
  expect,
  test as base,
  type BrowserContext,
  type Page,
  type Request,
  type Worker,
} from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PAGE, PAGE_TITLE, PAGE_URL, USER, completionStream, notionAnswer, type NotionRequest } from './fakes'

const DIST = path.resolve(import.meta.dirname, '../../extensions/notico/dist')
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures')

const NOTION_URLS = ['https://www.notion.so/Smoke-Test-Page', 'https://app.notion.com/p/smoke-test-page']
const OTHER_URL = 'https://example.com/'
const NOTION_HOSTS = NOTION_URLS.map((url) => new URL(url).hostname)
const PAGE_HOSTS = [...NOTION_URLS, OTHER_URL].map((url) => new URL(url).hostname)

// What Clerk asks its Frontend API for while loading, answered as a signed-out client would be
// (signed in, /v1/client is answered from SIGNED_IN_CLIENT instead).
const CLERK_FIXTURES: Record<string, string> = {
  '/v1/environment': 'clerk-environment.json',
  '/v1/client': 'clerk-client.json',
}

/**
 * Signed in, Clerk's Sync Host finds this client cookie, and the bundled Clerk sends it to the
 * Frontend API as a bearer token; /v1/client then answers with the fixture's active session.
 */
const CLIENT_JWT = 'client_smoke_jwt'
const SIGNED_IN_CLIENT = 'clerk-client-signed-in.json'
/** The session token the signed-in fixture hands out: what the panel must send the worker. */
const SESSION_TOKEN = (
  JSON.parse(readFileSync(path.join(FIXTURES, SIGNED_IN_CLIENT), 'utf8')) as {
    response: { sessions: { last_active_token: { jwt: string } }[] }
  }
).response.sessions[0]!.last_active_token.jwt

// What the signed-in panel asks the worker for while loading.
const WORKER_FIXTURES: Record<string, string> = {
  '/v1/credits': 'worker-credits.json',
  '/v1/me': 'worker-me.json',
}

/** What the model says, one entry per model call, in order (see completionStream). */
type Reply = Parameters<typeof completionStream>[0]

/** Hosts the extension's pages may fetch from, as its content security policy lists them. The worker is one. */
function connectHosts(): string[] {
  const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8')) as {
    content_security_policy: { extension_pages: string }
  }
  const connect = manifest.content_security_policy.extension_pages
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .find(([name]) => name === 'connect-src')
  return (connect ?? []).filter((source) => source.startsWith('https://')).map((source) => new URL(source).hostname)
}

/**
 * Hosts the built extension may call besides Notion: Clerk's Frontend API and the sign-in page,
 * as its manifest lists them. Clerk's fixtures answer only there, so a request for the same
 * path on any other host is blocked like the rest.
 */
function apiHosts(): string[] {
  const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8')) as { host_permissions: string[] }
  return manifest.host_permissions
    .map((pattern) => new URL(pattern.replace('*.', '')).hostname)
    .filter((host) => !PAGE_HOSTS.includes(host))
}

function corsHeaders(request: Request): Record<string, string> {
  return {
    'access-control-allow-origin': request.headers().origin ?? '*',
    'access-control-allow-credentials': 'true',
  }
}

interface Fixtures {
  /** Whether Clerk's Sync Host finds a signed-in client: the client cookie is set, and /v1/client answers with a session. */
  signedIn: boolean
  context: BrowserContext
  /** The extension's service worker (background.ts). */
  background: Worker
  /** Requests the worker fixtures answered: the path, and the session token they carried. */
  worker: { path: string; token: string | undefined }[]
  /** The model's replies still to come, which a test sets before it asks; a model call past the last is blocked. */
  replies: Reply[]
  /** The Notion requests the Notion tab sent, which the fake answered. */
  notion: NotionRequest[]
  /** Requests the fixtures don't answer. They are blocked, and a test expects none. */
  blocked: string[]
  /**
   * What the service worker logged with console.error, which is how background.ts reports
   * failures. Collected by the background fixture, from as early as Playwright sees the worker.
   */
  backgroundErrors: string[]
}

const test = base.extend<Fixtures>({
  signedIn: [false, { option: true }],
  // Playwright reads a fixture's dependencies from this destructuring pattern, so it can't be `_`.
  // oxlint-disable-next-line no-empty-pattern
  blocked: async ({}, use) => {
    await use([])
  },
  // Playwright reads a fixture's dependencies from this destructuring pattern, so it can't be `_`.
  // oxlint-disable-next-line no-empty-pattern
  worker: async ({}, use) => {
    await use([])
  },
  // Playwright reads a fixture's dependencies from this destructuring pattern, so it can't be `_`.
  // oxlint-disable-next-line no-empty-pattern
  replies: async ({}, use) => {
    await use([])
  },
  // Playwright reads a fixture's dependencies from this destructuring pattern, so it can't be `_`.
  // oxlint-disable-next-line no-empty-pattern
  notion: async ({}, use) => {
    await use([])
  },
  context: async ({ blocked, signedIn, worker, replies, notion }, use) => {
    if (!existsSync(path.join(DIST, 'manifest.json'))) {
      throw new Error(`No built extension at ${DIST}. Run pnpm build first.`)
    }
    // Extensions need a persistent context, and Playwright's own Chromium: Chrome and Edge
    // no longer take --load-extension.
    const clerkHosts = apiHosts()
    const workerHosts = connectHosts()
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    })
    if (signedIn) {
      await context.addCookies(
        clerkHosts.map((host) => ({
          name: '__client',
          value: CLIENT_JWT,
          domain: host,
          path: '/',
          secure: true,
          httpOnly: true,
        })),
      )
    }
    await context.route('**/*', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.protocol === 'chrome-extension:') return route.continue()
      if (signedIn && NOTION_HOSTS.includes(url.hostname) && url.pathname.startsWith('/api/v3/')) {
        const sent: NotionRequest = { endpoint: url.pathname.slice('/api/v3/'.length), body: request.postDataJSON() }
        const answer = request.method() === 'POST' ? notionAnswer(sent) : undefined
        if (answer !== undefined) {
          notion.push(sent)
          return route.fulfill({ json: answer })
        }
      } else if (PAGE_HOSTS.includes(url.hostname)) {
        return route.fulfill({ path: path.join(FIXTURES, 'page.html') })
      }
      let clerkFixture =
        request.method() === 'GET' && clerkHosts.includes(url.hostname) ? CLERK_FIXTURES[url.pathname] : undefined
      if (clerkFixture === 'clerk-client.json' && request.headers().authorization === `Bearer ${CLIENT_JWT}`) {
        clerkFixture = SIGNED_IN_CLIENT
      }
      if (clerkFixture) {
        return route.fulfill({ path: path.join(FIXTURES, clerkFixture), headers: corsHeaders(request) })
      }
      const workerFixture =
        signedIn && request.method() === 'GET' && workerHosts.includes(url.hostname)
          ? WORKER_FIXTURES[url.pathname]
          : undefined
      const reply =
        signedIn &&
        request.method() === 'POST' &&
        workerHosts.includes(url.hostname) &&
        url.pathname === '/v1/chat/completions'
          ? replies.shift()
          : undefined
      if (reply) {
        worker.push({ path: url.pathname, token: request.headers().authorization?.replace(/^Bearer /, '') })
        return route.fulfill({
          body: completionStream(reply),
          headers: { ...corsHeaders(request), 'content-type': 'text/event-stream' },
        })
      }
      if (workerFixture) {
        worker.push({ path: url.pathname, token: request.headers().authorization?.replace(/^Bearer /, '') })
        return route.fulfill({ path: path.join(FIXTURES, workerFixture), headers: corsHeaders(request) })
      }
      // A usage event (src/analytics.ts), when the build has a PostHog key: taken as PostHog takes
      // it, and sent nowhere. Anything else to PostHog (a script, its configuration) is blocked.
      if (request.method() === 'POST' && url.hostname.endsWith('.i.posthog.com') && url.pathname === '/e/') {
        return route.fulfill({ json: { status: 1 }, headers: corsHeaders(request) })
      }
      blocked.push(`${request.method()} ${request.url()}`)
      return route.abort()
    })
    await use(context)
    await context.close()
  },
  // Playwright reads a fixture's dependencies from this destructuring pattern, so it can't be `_`.
  // oxlint-disable-next-line no-empty-pattern
  backgroundErrors: async ({}, use) => {
    await use([])
  },
  background: async ({ context, backgroundErrors }, use) => {
    const background = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
    // Listen from the first moment Playwright has the worker, so failures during start-up are
    // seen too. A message logged before that moment can still be missed; start-up's result is
    // also checked directly (the panel behavior below).
    background.on('console', (message) => {
      if (message.type() === 'error') backgroundErrors.push(message.text())
    })
    // All background.ts does at start-up; wait for it, so a test never looks before it ran.
    await expect
      .poll(() => background.evaluate(() => chrome.sidePanel.getPanelBehavior()))
      .toEqual({ openPanelOnActionClick: true })
    await use(background)
  },
})

/** The side panel options of the tab showing `url`. */
function panelOptions(background: Worker, url: string): Promise<chrome.sidePanel.PanelOptions | undefined> {
  return background.evaluate(async (tabUrl) => {
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find((candidate) => candidate.url === tabUrl)
    return tab?.id === undefined ? undefined : chrome.sidePanel.getOptions({ tabId: tab.id })
  }, url)
}

test('the service worker starts and sets up the side panel', async ({ background, backgroundErrors, blocked }) => {
  // The background fixture has already waited for start-up to finish.
  expect(await background.evaluate(() => chrome.sidePanel.getPanelBehavior())).toEqual({
    openPanelOnActionClick: true,
  })
  expect(backgroundErrors).toEqual([])
  expect(blocked).toEqual([])
})

test('the side panel is enabled on every tab, Notion or not', async ({
  context,
  background,
  backgroundErrors,
  blocked,
}) => {
  for (const url of [...NOTION_URLS, OTHER_URL]) {
    const page = await context.newPage()
    await page.goto(url)
    await expect.poll(() => panelOptions(background, url), url).toMatchObject({ enabled: true, path: 'sidepanel.html' })
  }

  // Leaving Notion in the same tab keeps the panel.
  const notionPage = context.pages().find((candidate) => candidate.url() === NOTION_URLS[0])!
  await notionPage.goto(`${OTHER_URL}next`)
  await expect
    .poll(() => panelOptions(background, `${OTHER_URL}next`))
    .toMatchObject({ enabled: true, path: 'sidepanel.html' })
  expect(backgroundErrors).toEqual([])
  expect(blocked).toEqual([])
})

test('the side panel page shows the signed-out state', async ({ context, background, blocked }) => {
  const errors: string[] = []
  const clerkRequests: string[] = []
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  page.on('requestfinished', (request) => {
    const { pathname } = new URL(request.url())
    if (pathname in CLERK_FIXTURES) clerkRequests.push(pathname)
  })

  await page.goto(`chrome-extension://${new URL(background.url()).host}/sidepanel.html`)

  await expect(page.getByText('Sign in to use Notico.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  // The button alone proves little: it also shows when Clerk fails to load. So check that Clerk
  // itself is ready, with the signed-out client from the fixture, after asking only once.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const clerk = (window as { Clerk?: { status?: string; user?: unknown; client?: { id?: string } } }).Clerk
        return { status: clerk?.status, user: clerk?.user, client: clerk?.client?.id }
      }),
    )
    .toEqual({ status: 'ready', user: null, client: 'client_smoke' })
  expect(clerkRequests.toSorted()).toEqual(Object.keys(CLERK_FIXTURES).toSorted())
  expect(errors).toEqual([])
  expect(blocked).toEqual([])
})

/** Opens the side panel page in a tab of its own, collecting what it reports as errors into `errors`. */
async function openPanel(context: BrowserContext, background: Worker, errors: string[]): Promise<Page> {
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  await page.goto(`chrome-extension://${new URL(background.url()).host}/sidepanel.html`)
  return page
}

async function ask(panel: Page, question: string): Promise<void> {
  await panel.getByRole('textbox', { name: 'Message' }).fill(question)
  await panel.getByRole('button', { name: 'Send' }).click()
}

test.describe('signed in', () => {
  test.use({ signedIn: true })

  test('the side panel shows the chat to a signed-in user', async ({ context, background, blocked, worker }) => {
    const errors: string[] = []
    const panel = await openPanel(context, background, errors)

    await expect(panel.getByRole('button', { name: 'New chat' })).toBeVisible()
    await expect(panel.getByRole('textbox', { name: 'Message' })).toBeVisible()
    // Clerk took the session from the fixture, and the panel asked the worker with its token.
    await expect.poll(() => worker).toContainEqual({ path: '/v1/credits', token: SESSION_TOKEN })
    expect(errors).toEqual([])
    expect(blocked).toEqual([])
  })

  test("a question gets the model's streamed reply", async ({ context, background, blocked, worker, replies }) => {
    const errors: string[] = []
    // The reply, then the chat's title, which the panel asks for once the reply starts.
    replies.push({ text: 'Hello from the smoke test.' }, { text: 'Smoke test greeting' })
    const panel = await openPanel(context, background, errors)

    await ask(panel, 'Say hello')

    await expect(panel.getByText('Hello from the smoke test.')).toBeVisible()
    await expect(panel.getByRole('banner')).toContainText('Smoke test greeting')
    expect(worker).toContainEqual({ path: '/v1/chat/completions', token: SESSION_TOKEN })
    expect(replies).toEqual([])
    expect(errors).toEqual([])
    expect(blocked).toEqual([])
  })

  // The Notion tools' requests run inside the Notion tab, through chrome.scripting: no other test
  // runs that path in Chrome. One question reads the tab's page, then trashes it, which asks first.
  test("tools read and change the Notion tab's page, asking first where they must", async ({
    context,
    background,
    blocked,
    replies,
    notion,
  }) => {
    const errors: string[] = []
    replies.push(
      { call: 'read_page', args: { page: PAGE_URL } },
      { call: 'trash_page', args: { pages: [PAGE] } },
      { text: 'Moved it to the trash.' },
      { text: 'Trashing the smoke test page' },
    )
    const notionTab = await context.newPage()
    await notionTab.goto(PAGE_URL)
    const panel = await openPanel(context, background, errors)
    // The tools use the active tab of the panel's window, which a real side panel sits beside.
    await notionTab.bringToFront()

    await ask(panel, 'Trash this page')

    const allow = panel.getByRole('group', { name: /^Allow this\?/ })
    await expect(allow).toBeVisible()
    // The read ran in the tab before the user was asked, and nothing was changed yet.
    expect(notion.map((request) => request.endpoint)).toContain('loadPageChunk')
    expect(notion.map((request) => request.endpoint)).not.toContain('saveTransactionsFanout')
    await expect(panel.getByText(PAGE_TITLE).first()).toBeVisible()

    await allow.getByRole('button', { name: 'Allow' }).click()

    await expect(panel.getByText('Moved it to the trash.')).toBeVisible()
    // One transaction took the page out of its parent, and it went to the trash, not deleted for good.
    const saved = notion.filter((request) => request.endpoint === 'saveTransactionsFanout')
    expect(saved).toHaveLength(1)
    expect(saved[0]!.body).toMatchObject({
      transactions: [
        {
          operations: expect.arrayContaining([expect.objectContaining({ command: 'removeChild', args: { id: PAGE } })]),
        },
      ],
    })
    expect(notion.find((request) => request.endpoint === 'deleteContentRecords')?.body).toMatchObject({
      records: [{ id: PAGE }],
      permanentlyDelete: false,
    })
    expect(replies).toEqual([])
    expect(errors).toEqual([])
    expect(blocked).toEqual([])
  })
})
