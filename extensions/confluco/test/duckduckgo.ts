// Stands in for DuckDuckGo's HTML results page, for the side panel's UI tests, as the browser shows
// it in a tab the extension opens: chrome.tabs opens and closes those tabs and reports when one has
// loaded, and chrome.scripting runs the extension's script against the page, rebuilt from its source
// as Chrome does. A results page is shaped as DuckDuckGo's is (each result linked through its
// redirect, an ad among them); it can instead show DuckDuckGo's check that a person is searching,
// another page, or Chrome's error page for a site that did not answer.

const DUCKDUCKGO = 'https://html.duckduckgo.com'
const ACCESS = `${DUCKDUCKGO}/*`

interface Found {
  url: string
  title: string
  description: string
}

/** What the tab shows instead of results. */
type Answer = 'challenge' | 'error page' | 'unknown page' | 'redirect' | 'unreachable'

interface FakeTab {
  id: number
  windowId: number
  url: string
  status: 'loading' | 'complete'
  active: boolean
  closed: boolean
}

type UpdatedListener = (tabId: number, change: { status?: string }, tab: FakeTab) => void
type RemovedListener = (tabId: number) => void

export class FakeDuckDuckGo {
  /** The results for each query; a query not here finds nothing. */
  readonly found = new Map<string, Found[]>()
  /** Set to show this in every search's tab instead. */
  answer?: Answer
  /** The searches it was asked for, by query, each in its tab. */
  readonly searches: { query: string; tab: FakeTab }[] = []
  private nextId = 100
  private readonly updated: UpdatedListener[] = []
  private readonly removed: RemovedListener[] = []

  /** The tabs searches opened that are still open. */
  openTabs(): FakeTab[] {
    return this.searches.map((s) => s.tab).filter((t) => !t.closed)
  }

  /**
   * Takes over chrome.tabs and chrome.scripting for tabs on DuckDuckGo, passing everything else to
   * what the browser had; `allowed` are the sites the user allowed, which a script needs.
   */
  install(chrome: Record<string, Record<string, unknown>>, allowed: Set<string>): void {
    const tabs = chrome.tabs as Record<string, unknown> & {
      create: (props: { url: string }) => Promise<unknown>
      get: (id: number) => Promise<unknown>
      onUpdated: { addListener: (l: UpdatedListener) => void; removeListener: (l: UpdatedListener) => void }
    }
    const scripting = chrome.scripting as { executeScript: (injection: Injection) => Promise<unknown> }
    const { create, get, onUpdated } = tabs
    const executeScript = scripting.executeScript
    tabs.create = async (props: { url: string; active?: boolean; windowId?: number }) => {
      if (!props.url.startsWith(`${DUCKDUCKGO}/`)) return create(props)
      const tab: FakeTab = {
        id: this.nextId++,
        windowId: props.windowId ?? 1,
        url: props.url,
        status: 'loading',
        active: props.active ?? true,
        closed: false,
      }
      this.searches.push({ query: new URL(props.url).searchParams.get('q') ?? '', tab })
      // The page loads once the extension has its tab: Chrome reports it then.
      setTimeout(() => {
        if (tab.closed) return
        // Taken to DuckDuckGo's main site, where the extension may run no script.
        if (this.answer === 'redirect') tab.url = `https://duckduckgo.com/?q=${encodeURIComponent(query(tab))}`
        tab.status = 'complete'
        for (const listener of [...this.updated]) listener(tab.id, { status: 'complete' }, { ...tab })
      })
      return { ...tab }
    }
    tabs.get = async (id: number) => {
      const tab = this.tab(id)
      if (!tab) return get(id)
      if (tab.closed) throw new Error(`No tab with id: ${id}.`)
      return { ...tab }
    }
    tabs.remove = async (id: number) => {
      const tab = this.tab(id)
      if (!tab || tab.closed) throw new Error(`No tab with id: ${id}.`)
      tab.closed = true
      for (const listener of [...this.removed]) listener(id)
    }
    tabs.onUpdated = {
      addListener: (listener: UpdatedListener) => {
        onUpdated.addListener(listener)
        this.updated.push(listener)
      },
      removeListener: (listener: UpdatedListener) => {
        onUpdated.removeListener(listener)
        const i = this.updated.indexOf(listener)
        if (i >= 0) this.updated.splice(i, 1)
      },
    }
    tabs.onRemoved = {
      addListener: (listener: RemovedListener) => void this.removed.push(listener),
      removeListener: (listener: RemovedListener) => {
        const i = this.removed.indexOf(listener)
        if (i >= 0) this.removed.splice(i, 1)
      },
    }
    scripting.executeScript = async (injection: Injection) => {
      const tab = this.tab(injection.target.tabId)
      if (!tab) return executeScript(injection)
      if (tab.closed) throw new Error(`No tab with id: ${tab.id}.`)
      if (this.answer === 'unreachable') throw new Error('Frame with ID 0 is showing error page')
      if (!tab.url.startsWith(`${DUCKDUCKGO}/`) || !allowed.has(ACCESS))
        throw new Error(
          'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
        )
      const document = new DOMParser().parseFromString(this.page(query(tab)), 'text/html')
      const location = new URL(tab.url)
      const rebuilt = new Function('location', 'document', `return (${injection.func.toString()})`)(
        location,
        document,
      ) as () => unknown
      return [{ frameId: 0, result: await rebuilt() }]
    }
  }

  private tab(id: number): FakeTab | undefined {
    return this.searches.find((s) => s.tab.id === id)?.tab
  }

  /** The HTML the tab shows for `query`. */
  private page(query: string): string {
    switch (this.answer) {
      case 'challenge':
        return html(CHALLENGE)
      case 'error page':
        return html('<p>Something went wrong. Please try again.</p>')
      case 'unknown page':
        return html('<main><p>DuckDuckGo has moved.</p></main>')
      default:
        return html(resultsPage(this.found.get(query) ?? []))
    }
  }
}

interface Injection {
  target: { tabId: number }
  world?: string
  func: Function
}

/** The query a search's tab was opened for. */
const query = (tab: FakeTab) => new URL(tab.url).searchParams.get('q') ?? ''

const html = (body: string) => `<!DOCTYPE html><html><head><title>DuckDuckGo</title></head><body>${body}</body></html>`

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A results page as DuckDuckGo's HTML page gives one: an ad first, then each result through its redirect. */
function resultsPage(found: Found[]): string {
  const redirect = (url: string) => `//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=0123abcd`
  const ad = `
    <div class="result results_links results_links_deep result--ad">
      <div class="links_main links_deep result__body">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example">Buy tea now</a></h2>
        <a class="result__snippet" href="https://duckduckgo.com/y.js?ad_domain=ads.example">Sponsored</a>
      </div>
    </div>`
  const results = found.map(
    (r) => `
    <div class="result results_links results_links_deep web-result ">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="${redirect(r.url)}">${escape(r.title)}</a>
        </h2>
        <div class="result__extras"><div class="result__extras__url">
          <a class="result__url" href="${redirect(r.url)}">${escape(new URL(r.url).host)}</a>
        </div></div>
        <a class="result__snippet" href="${redirect(r.url)}">${escape(r.description)}</a>
        <div class="clear"></div>
      </div>
    </div>`,
  )
  return `<div id="links" class="results">${found.length ? ad : ''}${results.join('')}</div>`
}

/** What DuckDuckGo shows a browser it takes for a bot: a challenge to pick the squares with a duck. */
const CHALLENGE = `
  <div class="anomaly-modal__modal">
    <p class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</p>
    <p class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</p>
    <form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html" method="POST">
      <button type="submit" class="anomaly-modal__submit">Submit</button>
    </form>
  </div>`
