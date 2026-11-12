// The side panel's UI tests run the whole panel: the page sidepanel.html loads, with the real agent,
// tools, and session store behind it, and the real worker answering its model calls. Only the edges
// are fakes: chrome.* (with a Notion tab), Clerk (see clerk.tsx), IndexedDB, and the model binding.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { act } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { vi } from 'vitest'
import { createApp, type Env } from '../../worker/src/app'
import { FakeClerk } from '../../worker/test/clerk'
import { FakeAiBinding, FakeD1Database, FakeExecutionContext, FakeUsageDataset, MODEL } from '../../worker/test/fakes'
import type { FakeSession } from './clerk'
import { restoreGlobals, type FakeNotionTab } from './notion-tab'

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
/** When every test starts. Tests move the clock themselves (`vi.setSystemTime`); nothing waits for real time. */
export const START = new Date('2026-11-08T12:00:00Z')

const globals = globalThis as Record<string, unknown>
// jsdom lays nothing out, so it has no scrolling; the panel scrolls its messages to the newest one.
Element.prototype.scrollTo ??= () => {}
const app = createApp()
// One key pair for the whole file: making one takes longer than a test.
let clerk: Promise<FakeClerk> | undefined

/**
 * A browser with the extension installed and one tab: its chrome.* APIs, its IndexedDB, who is
 * signed in to Notico, and the worker the panel talks to. Lives for one test.
 */
export class FakeBrowser {
  /** The model behind the worker; script its replies, and read what it was sent. */
  readonly ai = new FakeAiBinding()
  /** URLs the panel opened in new tabs. */
  readonly openedTabs: string[] = []

  private constructor(
    readonly tab: FakeNotionTab,
    private readonly session: FakeSession | undefined,
  ) {}

  /** Starts a browser on `tab`, signed in to Notico as `signedInAs` or signed out. */
  static async start(tab: FakeNotionTab, options: { signedInAs?: string } = {}): Promise<FakeBrowser> {
    vi.useFakeTimers({ toFake: ['Date'], now: START })
    const issuer = await (clerk ??= FakeClerk.create())
    const userId = options.signedInAs
    const session = userId && { userId, getToken: () => issuer.sessionToken({ userId, azp: EXTENSION }) }
    const browser = new FakeBrowser(tab, session || undefined)

    const env: Env = {
      AI: browser.ai,
      DB: new FakeD1Database(),
      USAGE: new FakeUsageDataset(),
      MODEL,
      CLERK_JWT_KEY: issuer.publicKeyPem,
      CLERK_AUTHORIZED_PARTIES: EXTENSION,
    }
    // The panel calls fetch(); route it into the worker app.
    globals.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
      app.request(new Request(input, init), undefined, env, new FakeExecutionContext())
    // A new browser profile: no saved sessions.
    globals.indexedDB = new IDBFactory()

    tab.install()
    const chrome = globals.chrome as { tabs: Record<string, unknown> } & Record<string, unknown>
    chrome.runtime = { getURL: (path: string) => `${EXTENSION}/${path}` }
    chrome.tabs.create = async ({ url }: { url: string }) => void browser.openedTabs.push(url)
    // Clerk's cookie on the sign-in page, which the panel watches to notice a sign-in or sign-out there.
    chrome.cookies = {
      getAll: async ({ name }: { name: string }) => [{ name, value: session ? '1762603200' : '0' }],
      onChanged: { addListener: () => {} },
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
    const { fakeClerk } = await import('./clerk')
    if (this.session) fakeClerk.signIn(this.session)
    await act(() => import(/* @vite-ignore */ script.getAttribute('src')!))
  }

  /** What the model was sent with its latest call. */
  sentToModel(): { role: string; content?: string }[] {
    return this.ai.calls.at(-1)!.inputs.messages as { role: string; content?: string }[]
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
  restoreGlobals()
  delete globals.indexedDB
  vi.useRealTimers()
}
