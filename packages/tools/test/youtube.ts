// A browser with one tab on YouTube, for the tab tools: chrome.* as the tools use it, and YouTube
// (@cofun/panel-test's FakeYouTube) answering the requests made from inside the tab. Scripts run the
// way Chrome runs them (see FakeYouTubeTab.executeScript).
import type { ToolContext, KeptResult, ResultToKeep } from '@cofun/agent'
import { FakeYouTube, VIDEO_URL } from '@cofun/panel-test/youtube'

export * from '@cofun/panel-test/youtube'

/** One tab, the current one, on a page of YouTube, with the side panel's window around it. */
export class FakeYouTubeTab {
  url: string
  title = 'A video - YouTube'
  /** The sites the user allowed the extension to read, as match patterns. */
  allowed = new Set<string>(['https://www.youtube.com/*'])
  /** The page the tab shows, for pages read as pages: its title and body's HTML. */
  dom?: { title: string; body: string }
  /** YouTube, which the tab's requests go to: what it answers, and what it was sent. */
  readonly youtube = new FakeYouTube()
  /** What the tab sent YouTube. */
  get sent() {
    return this.youtube.sent
  }
  /** What YouTube answers each kind of request with, in order. */
  get answers() {
    return this.youtube.answers
  }
  /** Called as each request is sent: where a test stops the question midway. */
  set onSent(listener: FakeYouTube['onSent']) {
    this.youtube.onSent = listener
  }

  constructor(url = VIDEO_URL) {
    this.url = url
  }

  install(): this {
    const tab = () => ({ id: 7, url: this.url, title: this.title, active: true })
    Object.assign(globalThis, {
      chrome: {
        runtime: { getManifest: () => ({ host_permissions: ['https://api.cofun.test/*'] }) },
        tabs: { query: async () => [tab()], get: async () => tab() },
        permissions: {
          contains: async ({ origins }: { origins: string[] }) => origins.every((o) => this.allowed.has(o)),
          request: async () => false,
        },
        // The browser's run, which a tab added in it was added in (see browserRun in tools/tabs.ts).
        storage: { session: { get: async () => ({ browserRun: 'run-1' }), set: async () => {} } },
        scripting: { executeScript: (injection: Injection) => this.executeScript(injection) },
      },
    })
    return this
  }

  /**
   * Runs an injected script as Chrome does: rebuilt from its source, so it can only use its own
   * body, with its arguments copied, and with the tab's `location`, `document`, and `fetch` in
   * place of the globals.
   */
  private async executeScript({ target, world, func, args = [] }: Injection) {
    if (target.tabId !== 7 || world !== 'ISOLATED') throw new Error(`Unexpected injection into tab ${target.tabId}`)
    const location = new URL(this.url)
    if (!this.allowed.has(`${location.origin}/*`))
      throw new Error('Cannot access contents of the page. Extension manifest must request permission.')
    const document = this.document(location)
    const fetch = (input: string, init: RequestInit = {}) => this.youtube.fetch(new URL(input, location), init)
    const rebuilt = new Function('location', 'document', 'fetch', `return (${func.toString()})`)(
      location,
      document,
      fetch,
    ) as (...args: unknown[]) => unknown
    return [{ frameId: 0, result: structuredClone(await rebuilt(...structuredClone(args))) }]
  }

  /** The page's DOM, for the generic reader: the test's, else an empty page. */
  private document(location: URL) {
    const { title, body } = this.dom ?? { title: this.title, body: '' }
    const html = `<!DOCTYPE html><html><head><title>${title}</title><base href="${location.href}"></head><body>${body}</body></html>`
    return new DOMParser().parseFromString(html, 'text/html')
  }
}

interface Injection {
  target: { tabId: number }
  world?: string
  func: { toString(): string }
  args?: unknown[]
}

/** What the agent gives a call: long results are kept in memory. */
export function toolContext(): ToolContext<undefined> & { keptResults: Map<string, KeptResult> } {
  const keptResults = new Map<string, KeptResult>()
  return {
    userText: 'Summarize this video',
    ask: async () => false,
    readWeb: () => Promise.reject(new Error('no web reads here')),
    searchWeb: () => Promise.reject(new Error('no web searches here')),
    keep: async (result: ResultToKeep) => {
      const id = `r_${String(keptResults.size + 1).padStart(16, '0')}`
      keptResults.set(id, { ...result, id, keptAt: 0 })
      return id
    },
    kept: async (id: string) => keptResults.get(id) ?? 'unknown',
    memory: undefined,
    keptResults,
  }
}
