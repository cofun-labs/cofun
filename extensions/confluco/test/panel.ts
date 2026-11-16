// Runs the real panel and Worker with local fakes for the browser, Clerk, and model.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { act } from '@testing-library/react'
import { vi } from 'vitest'
import { createApp, type Env } from '../../../worker/src/app'
import { FakeClerk } from '../../../worker/test/clerk'
import {
  FakeAiBinding,
  FakeD1Database,
  FakeExecutionContext,
  FakeRateLimiter,
  FakeUsageDataset,
  MODEL,
} from '../../../worker/test/fakes'
import type { FakeSession } from './clerk'

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
/** When every test starts. Tests move the clock themselves (`vi.setSystemTime`); nothing waits for real time. */
const START = new Date('2026-11-08T12:00:00Z')

const globals = globalThis as Record<string, unknown>
const realFetch = globalThis.fetch
const WORKER_ORIGIN = 'https://api.copilot.test'
export const SITE = 'https://wiki.example.test/kb'
const PAGE_URL = `${SITE}/pages/viewpage.action?pageId=42`
type TestTab = {
  id?: number
  title?: string
  url?: string
}
type Injection = { target: { tabId: number }; func: (...args: never[]) => unknown; args: unknown[] }
// jsdom lays nothing out, so it has no scrolling; the panel scrolls its messages to the newest one.
Element.prototype.scrollTo ??= () => {}
const app = createApp()
// One key pair for the whole file: making one takes longer than a test.
let clerk: Promise<FakeClerk> | undefined

/**
 * A browser with the extension installed and one active tab, a Cofun account, and the Worker
 * the panel talks to. Lives for one test.
 */
export class FakeBrowser {
  /** The model behind the worker; script its replies, and read what it was sent. */
  readonly ai = new FakeAiBinding()
  /** URLs the panel opened in new tabs. */
  readonly openedTabs: string[] = []

  readonly workspaceRequests: { url: string; init?: RequestInit }[] = []
  readonly requestedOrigins: string[] = []
  confluenceResponse: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
    new Response(null, { status: 404 })
  private readonly sites = new Set<string>()
  private readonly settings: Record<string, unknown> = {}
  private readonly tabs = new Map<number, TestTab>()
  private readonly worlds = new Map<number, Record<string, unknown>>()
  private active?: TestTab

  private constructor(private readonly session: FakeSession) {}

  selectTab(tab: TestTab) {
    this.tabs.set(tab.id ?? 1, tab)
    this.active = tab
  }

  private async executeScript({ target, func, args }: Injection) {
    const tab = this.tabs.get(target.tabId)
    if (!tab?.url) throw new Error('No such tab')
    const world = this.worlds.get(target.tabId) ?? {}
    this.worlds.set(target.tabId, world)
    const page = new DOMParser().parseFromString('<meta name="ajs-content-type" content="page">', 'text/html')
    Object.assign(world, {
      location: new URL(tab.url),
      document: page,
      URL,
      URLSearchParams,
      AbortSignal,
      AbortController,
      TextDecoder,
      fetch: async (url: string, init?: RequestInit) => {
        this.workspaceRequests.push({ url, init })
        return this.confluenceResponse(url, init)
      },
    })
    // Chrome's extension API argument serializer drops null dictionary properties.
    const injectedArgs: unknown = JSON.parse(
      JSON.stringify(args, (_key, value) => (value === null ? undefined : value)),
    )
    const result: unknown = await runInNewContext(
      `(${func.toString()})(...args)`,
      Object.assign(world, { args: injectedArgs }),
    )
    return [{ result }]
  }

  static async start(): Promise<FakeBrowser> {
    vi.useFakeTimers({ toFake: ['Date'], now: START })
    const issuer = await (clerk ??= FakeClerk.create())
    const browser = new FakeBrowser({
      userId: 'user_fixture',
      name: 'Fixture User',
      email: 'fixture@example.test',
      getToken: () => issuer.sessionToken({ userId: 'user_fixture', azp: EXTENSION }),
    })
    const env: Env = {
      AI: browser.ai,
      DB: new FakeD1Database(),
      USAGE: new FakeUsageDataset(),
      CHAT_LIMIT: new FakeRateLimiter(),
      API_LIMIT: new FakeRateLimiter(),
      WEB_LIMIT: new FakeRateLimiter(),
      RENDER_LIMIT: new FakeRateLimiter(),
      SEARCH_LIMIT: new FakeRateLimiter(),
      MODEL,
      CLERK_JWT_KEY: issuer.publicKeyPem,
      CLERK_AUTHORIZED_PARTIES: EXTENSION,
    }
    globals.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (new URL(request.url).origin !== WORKER_ORIGIN) throw new Error('Unexpected host')
      return app.request(request, undefined, env, new FakeExecutionContext())
    }
    let lockQueue = Promise.resolve()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: <T>(_name: string, action: () => Promise<T>) => {
          const result = lockQueue.then(action)
          lockQueue = result.then(
            () => {},
            () => {},
          )
          return result
        },
      },
    })

    browser.selectTab({ url: PAGE_URL, title: 'Fixture page' })
    globals.chrome = {
      runtime: { getURL: (path: string) => `${EXTENSION}/${path}`, getManifest: () => ({ version: '0.0.1' }) },
      tabs: {
        query: async () => (browser.active ? [{ id: 1, ...browser.active }] : []),
        create: async ({ url }: { url: string }) => void browser.openedTabs.push(url),
      },
      storage: {
        local: {
          get: async (key: string | null) =>
            key === null ? { ...browser.settings } : { [key]: browser.settings[key] },
          set: async (items: Record<string, unknown>) => Object.assign(browser.settings, items),
          remove: async (key: string) => {
            delete browser.settings[key]
          },
        },
      },
      permissions: {
        request: async ({ origins }: { origins: string[] }) => {
          browser.requestedOrigins.push(...origins)
          origins.forEach((origin) => browser.sites.add(origin))
          return true
        },
        contains: async ({ origins }: { origins: string[] }) => origins.every((origin) => browser.sites.has(origin)),
        remove: async ({ origins }: { origins: string[] }) => origins.every((origin) => browser.sites.delete(origin)),
      },
      scripting: { executeScript: (details: Injection) => browser.executeScript(details) },
      // The sign-in cookie the panel watches for a change in session state.
      cookies: {
        getAll: async ({ name }: { name: string }) => [{ name, value: '0' }],
        onChanged: { addListener: () => {} },
      },
    }
    return browser
  }

  /**
   * Opens the side panel: loads sidepanel.html into the document and runs the script it names, so
   * the panel starts as it does in Chrome. Opening it again closes the one before: a new document with new modules;
   * what the browser keeps (IndexedDB, chrome.storage, the sign-in) stays.
   */
  async openPanel(): Promise<void> {
    await closePanel()
    vi.resetModules()
    const page = new DOMParser().parseFromString(
      readFileSync(fileURLToPath(import.meta.resolve('../sidepanel.html')), 'utf8'),
      'text/html',
    )
    const script = page.querySelector('script[type="module"]')!
    script.remove()
    document.body.innerHTML = page.body.innerHTML
    await act(() => import(/* @vite-ignore */ script.getAttribute('src')!))
  }

  async signIn(): Promise<void> {
    const { fakeClerk } = await import('./clerk')
    await act(async () => fakeClerk.signIn(this.session))
  }
}

/** Closes the open panel, if there is one, as Chrome does when its page goes away. */
async function closePanel(): Promise<void> {
  await act(async () => void window.dispatchEvent(new Event('pagehide')))
  document.body.innerHTML = ''
}

/** Closes the panel and puts back what a FakeBrowser replaced. Call it after each test. */
export async function closeBrowser(): Promise<void> {
  await closePanel()
  globals.fetch = realFetch
  delete globals.chrome
  Reflect.deleteProperty(navigator, 'locks')
  vi.useRealTimers()
}
