// Stands in for DuckDuckGo's HTML search page at the edge, for the side panel's UI tests: it answers
// a search with a page of results shaped as DuckDuckGo's is (each linked through its redirect, an ad
// among them), or with what it answers a client it takes for a bot, or with nothing at all.

export const DUCKDUCKGO = 'https://html.duckduckgo.com'

interface Found {
  url: string
  title: string
  description: string
}

/** What DuckDuckGo answers instead of results. */
type Answer = 'challenge' | 'busy' | 'unknown page' | 'error' | 'unreachable'

export class FakeDuckDuckGo {
  /** The results for each query; a query not here finds nothing. */
  readonly found = new Map<string, Found[]>()
  /** Set to answer every search this way instead. */
  answer?: Answer
  /** The searches it was sent: the query, and whether the request carried cookies. */
  readonly searches: { query: string; credentials: RequestCredentials }[] = []

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/html/') return new Response('Not found', { status: 404 })
    const query = url.searchParams.get('q') ?? ''
    this.searches.push({ query, credentials: request.credentials })
    switch (this.answer) {
      case 'unreachable':
        throw new TypeError('Failed to fetch')
      case 'challenge':
        return html(CHALLENGE, 202)
      case 'busy':
        return html('<p>Too many requests</p>', 429)
      case 'error':
        return html('<p>Something went wrong</p>', 500)
      case 'unknown page':
        return html('<main><p>DuckDuckGo has moved.</p></main>')
      default:
        return html(resultsPage(this.found.get(query) ?? []))
    }
  }
}

const html = (body: string, status = 200) =>
  new Response(`<!DOCTYPE html><html><head><title>DuckDuckGo</title></head><body>${body}</body></html>`, {
    status,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  })

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

/** What DuckDuckGo answers a client it takes for a bot: a challenge to pick the squares with a duck. */
const CHALLENGE = `
  <div class="anomaly-modal__modal">
    <p class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</p>
    <p class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</p>
    <form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html" method="POST">
      <button type="submit" class="anomaly-modal__submit">Submit</button>
    </form>
  </div>`
