// Browser smoke tests load the built extension into Chromium. The test site, Clerk, and the
// Worker are answered from fixtures. Usage events are dropped and unexpected requests fail the test.
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
import { completionStream } from './fakes'

const DIST = path.resolve(import.meta.dirname, '../dist')
const FIXTURES = path.resolve(import.meta.dirname, 'fixtures')

const OTHER_URL = 'https://example.com/'
const PAGE_HOST = new URL(OTHER_URL).hostname

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
 * Hosts the built extension may call: Clerk's Frontend API and the sign-in page,
 * as its manifest lists them. Clerk's fixtures answer only there, so a request for the same
 * path on any other host is blocked like the rest.
 */
function apiHosts(): string[] {
  const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8')) as { host_permissions: string[] }
  return manifest.host_permissions
    .map((pattern) => new URL(pattern.replace('*.', '')).hostname)
    .filter((host) => host !== PAGE_HOST)
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
  worker: { host: string; path: string; token: string | undefined; client?: string }[]
  /** The model's replies still to come, which a test sets before it asks; a model call past the last is blocked. */
  replies: Reply[]
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
  context: async ({ blocked, signedIn, worker, replies }, use) => {
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
      if (url.hostname === PAGE_HOST) {
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
        worker.push({
          host: url.hostname,
          path: url.pathname,
          token: request.headers().authorization?.replace(/^Bearer /, ''),
          client: request.headers()['x-cofun-client'],
        })
        return route.fulfill({
          body: completionStream(reply),
          headers: { ...corsHeaders(request), 'content-type': 'text/event-stream' },
        })
      }
      if (workerFixture) {
        worker.push({
          host: url.hostname,
          path: url.pathname,
          token: request.headers().authorization?.replace(/^Bearer /, ''),
        })
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

test('the side panel is enabled on every tab', async ({ context, background, backgroundErrors, blocked }) => {
  for (const url of [OTHER_URL, `${OTHER_URL}next`]) {
    const page = await context.newPage()
    await page.goto(url)
    await expect.poll(() => panelOptions(background, url), url).toMatchObject({ enabled: true, path: 'sidepanel.html' })
  }

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

  await expect(page.getByText('Sign in to use Confluco.')).toBeVisible()
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
    await expect.poll(() => worker).toContainEqual({ host: 'api.cofun.cc', path: '/v1/credits', token: SESSION_TOKEN })
    expect(errors).toEqual([])
    expect(blocked).toEqual([])
  })

  test("a question gets the model's streamed reply", async ({ context, background, blocked, worker, replies }) => {
    const errors: string[] = []
    // The reply, then the chat's title, which the panel asks for once the reply is in.
    replies.push({ text: 'Hello from the smoke test.' }, { text: 'Smoke test greeting' })
    const panel = await openPanel(context, background, errors)

    await ask(panel, 'Say hello')

    await expect(panel.getByText('Hello from the smoke test.')).toBeVisible()
    await expect(panel.getByRole('banner')).toContainText('Smoke test greeting')
    expect(worker).toContainEqual({
      host: 'api.cofun.cc',
      path: '/v1/chat/completions',
      token: SESSION_TOKEN,
      client: expect.stringMatching(/^confluco\/\d+\.\d+\.\d+$/),
    })
    expect(replies).toEqual([])
    expect(errors).toEqual([])
    expect(blocked).toEqual([])
  })
})
