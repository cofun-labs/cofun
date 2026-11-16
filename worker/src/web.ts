// Reads a public web page for a signed-in user: fetched plainly (fetchPage), or rendered in
// Cloudflare's Browser Run for a page drawn by scripts (renderPage). The worker reads only what the
// address gives to anyone: it sends no cookie and no credential, and refuses addresses on our own
// domain, on a local network name, or written as an IP address. Which addresses to read is the
// extension's choice: the worker knows nothing of the conversation.
import { Parser } from 'htmlparser2'
import * as z from './zod'

/** A page as read: the address it ended at, its title (or empty), and its text, clipped. */
export interface WebPage {
  url: string
  title: string
  text: string
  /** The characters of the whole text, before it was clipped. */
  chars: number
  /** The page showed little text and runs scripts: what it shows may be drawn by them. */
  scripted: boolean
}

/**
 * Why a page could not be read, as a code the extension tells the model about, and a message for
 * whoever reads the response. The codes are a contract with the extension (`packages/base/src/agent/worker.ts`).
 */
export class PageError extends Error {
  constructor(
    readonly code: PageErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export type PageErrorCode =
  | 'not_allowed'
  | 'unreachable'
  | 'timeout'
  | 'too_many_redirects'
  | 'no_access'
  | 'bot_check'
  | 'not_found'
  | 'site_busy'
  | 'site_error'
  | 'unsupported_type'
  | 'no_text'
  | 'render_busy'
  | 'render_failed'

/** The slice of a fetcher the worker reads pages with: the global `fetch` deployed, a fake in tests. */
export interface WebFetcher {
  fetch(request: Request): Promise<Response>
}

/** The slice of the Browser Run binding (`browser` in wrangler.jsonc) the worker uses. */
export interface BrowserBinding {
  quickAction(action: 'markdown', options: Record<string, unknown>): Promise<Response>
}

/** Redirects followed before giving up; each one's address is checked like the first. */
const MAX_REDIRECTS = 5
/** How long a plain fetch may take, from the first request to the last byte read. */
const FETCH_TIMEOUT_MS = 10_000
/** How long Browser Run may wait for a page to load. */
const RENDER_TIMEOUT_MS = 30_000
/** Bytes of a page read at most; what follows is not read, and the text is of what came before. */
const MAX_BYTES = 2 * 1024 * 1024
/** Characters of a title kept. */
const TITLE_CHARS = 300
/** Below this many characters of text, a page that runs scripts is said to be maybe drawn by them. */
const FEW_CHARS = 200

/** Honest about who asks: some sites refuse a client that names none. */
const USER_AGENT = 'Mozilla/5.0 (compatible; Cofun/1.0; +https://cofun.cc)'

/**
 * Hosts the worker never reads, whatever they resolve to: our own domain (the worker would be
 * asking itself, or the sign-in), and names that only mean something on a local network.
 */
const REFUSED_HOSTS = [/(^|\.)cofun\.cc$/, /(^|\.)localhost$/, /\.(local|internal|lan|home|arpa)$/]

/**
 * The address as the worker reads it, or why not. Only http and https on their own ports, with a
 * host name (not an IP address) that has a dot and is not refused, and no user name or password.
 */
export function checkAddress(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new PageError('not_allowed', 'not a URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new PageError('not_allowed', 'only http and https addresses can be read')
  if (url.username || url.password) throw new PageError('not_allowed', 'an address with a user name is not read')
  if (url.port) throw new PageError('not_allowed', 'only addresses on the default port are read')
  // A host is checked in its usual form: one trailing dot (the fully qualified form) is dropped,
  // and a host with an empty label anywhere is not read, so each name has one form to match.
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host.split('.').includes('')) throw new PageError('not_allowed', 'this host is not read')
  // The URL parser writes every IPv4 form (decimal, hex, short) as dotted digits, and IPv6 in brackets.
  if (/^[\d.]+$/.test(host) || host.startsWith('['))
    throw new PageError('not_allowed', 'an address given as an IP address is not read')
  if (!host.includes('.') || REFUSED_HOSTS.some((refused) => refused.test(host)))
    throw new PageError('not_allowed', 'this host is not read')
  url.hash = ''
  return url
}

/**
 * Fetches the page at `url` plainly, following redirects one at a time, and gives its text clipped
 * to `maxChars`. HTML and plain text only.
 */
export async function fetchPage(web: WebFetcher, url: URL, maxChars: number): Promise<WebPage> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  let at = url
  for (let hop = 0; ; hop++) {
    const res = await reach(
      web.fetch(
        new Request(at, {
          redirect: 'manual',
          signal,
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
          },
        }),
      ),
    )
    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      await res.body?.cancel()
      if (hop >= MAX_REDIRECTS) throw new PageError('too_many_redirects', 'the page redirects too many times')
      // The address checkAddress gets is what URL makes of it: one that isn't a URL is refused there.
      at = checkAddress(URL.parse(res.headers.get('location') ?? '', at)?.href ?? '')
      continue
    }
    return await pageOf(res, at, maxChars)
  }
}

/**
 * Waits for a request to the site, or for its body: a failure there is the site's, said as a
 * PageError. Only these are wrapped, so a bug in the worker's own reading still fails as one.
 */
async function reach<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
      throw new PageError('timeout', 'the site took too long to answer')
    throw new PageError('unreachable', 'the site could not be reached')
  }
}

/** The page a final response gives, or why it gives none. */
async function pageOf(res: Response, url: URL, maxChars: number): Promise<WebPage> {
  if (!res.ok) {
    await res.body?.cancel()
    throw statusError(res)
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const html = type === 'text/html' || type === 'application/xhtml+xml'
  if (!html && type !== 'text/plain' && type !== 'text/markdown') {
    await res.body?.cancel()
    throw new PageError('unsupported_type', `the page is ${type || 'of no stated type'}, not HTML or text`)
  }
  const bytes = await reach(readBytes(res, MAX_BYTES))
  const decoded = decode(bytes, res.headers.get('content-type'), html)
  const page = html ? htmlText(decoded) : { title: '', text: tidy(decoded), scripted: false }
  if (!page.text) throw new PageError('no_text', 'the page shows no text without running its scripts')
  return {
    url: url.href,
    title: page.title,
    text: page.text.slice(0, maxChars),
    chars: page.text.length,
    scripted: page.scripted && page.text.length < FEW_CHARS,
  }
}

/** What a status that is not a page means, for the model. */
function statusError(res: Response): PageError {
  // Cloudflare's own challenge, and the usual answers of other bot checks.
  if (res.headers.get('cf-mitigated') === 'challenge')
    return new PageError('bot_check', 'the site asked for a bot check')
  if (res.status === 401 || res.status === 403 || res.status === 407)
    return new PageError('no_access', 'the site refused to show the page: it may need a sign-in')
  if (res.status === 404 || res.status === 410) return new PageError('not_found', 'the site has no such page')
  if (res.status === 429) return new PageError('site_busy', 'the site turned the request away for coming too often')
  return new PageError('site_error', `the site answered with HTTP ${res.status}`)
}

/** Up to `max` bytes of the body; the rest is not read. */
async function readBytes(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  while (size < max) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    size += value.length
  }
  await reader.cancel().catch(() => {})
  const out = new Uint8Array(Math.min(size, max))
  let at = 0
  for (const part of parts) {
    const take = part.subarray(0, out.length - at)
    out.set(take, at)
    at += take.length
    if (at >= out.length) break
  }
  return out
}

/**
 * The text of the bytes, in the charset the response names, or else, for HTML, the one a `meta`
 * tag near its start names; UTF-8 when neither does, or names one that is not known.
 */
function decode(bytes: Uint8Array, contentType: string | null, html: boolean): string {
  const named = /charset\s*=\s*"?([\w-]+)/i.exec(contentType ?? '')?.[1]
  const meta = html
    ? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(String.fromCharCode(...bytes.subarray(0, 2048)))?.[1]
    : undefined
  for (const charset of [named, meta, 'utf-8']) {
    if (!charset) continue
    try {
      return new TextDecoder(charset).decode(bytes)
    } catch {
      // Not a charset this runtime knows: try the next.
    }
  }
  return new TextDecoder().decode(bytes)
}

/** Elements whose text is not the page's: code, styles, menus, forms, and what is hidden. */
const SKIPPED = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'canvas',
  'iframe',
  'object',
  'head',
  'nav',
  'aside',
  'footer',
  'form',
  'button',
  'select',
  'dialog',
])

/** Elements that start a line of their own. */
const BLOCKS = new Set([
  'address',
  'article',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tr',
  'ul',
])

/**
 * The text of an HTML page: its main element (or main landmark), else its first article, else its
 * whole body, with headings marked `#` and list items `-`, as Markdown would. Also its title, and
 * whether it runs scripts (a page that shows little text may be drawn by them).
 */
function htmlText(html: string): { title: string; text: string; scripted: boolean } {
  /** An open element: its name, and whether it is skipped, the main element, or an article. */
  const open: { name: string; skip: boolean; main: boolean; article: boolean }[] = []
  let skipping = 0
  let inMain = 0
  let inArticle = 0
  let articles = 0
  let inPre = 0
  let title = ''
  let inTitle = false
  let scripted = false
  const out = { main: '', article: '', body: '' }
  const add = (text: string) => {
    if (inMain) out.main += text
    // Only the first article stands in for the main text.
    if (inArticle && articles === 1) out.article += text
    out.body += text
  }
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === 'script' && attrs.type !== 'application/ld+json') scripted = true
        if (name === 'title' && !title) inTitle = true
        const hidden = 'hidden' in attrs || attrs['aria-hidden'] === 'true'
        const skip = SKIPPED.has(name) || hidden
        const main = name === 'main' || attrs.role === 'main'
        const article = name === 'article'
        open.push({ name, skip, main, article })
        if (skip) skipping++
        if (main) inMain++
        if (article && ++articles === 1) inArticle++
        if (name === 'pre') inPre++
        if (skipping) return
        if (BLOCKS.has(name)) add('\n')
        if (/^h[1-6]$/.test(name)) add(`${'#'.repeat(Number(name[1]))} `)
        else if (name === 'li') add('- ')
        else if (name === 'td' || name === 'th') add(' ')
      },
      ontext(text) {
        if (inTitle) title += text
        if (skipping) return
        add(inPre ? text : text.replace(/\s+/g, ' '))
      },
      onclosetag(name) {
        if (name === 'title') inTitle = false
        // Close up to the element that ends, as browsers do for elements left open inside it.
        const at = open.findLastIndex((el) => el.name === name)
        if (at < 0) return
        for (const el of open.splice(at).reverse()) {
          if (el.skip) skipping--
          if (el.main) inMain--
          if (el.article && inArticle) inArticle--
          if (el.name === 'pre') inPre--
          // A list item's line ends where the next starts: no empty line between items.
          if (!skipping && BLOCKS.has(el.name) && el.name !== 'li') add('\n')
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  )
  parser.end(html)
  const text = tidy(out.main) || tidy(out.article) || tidy(out.body)
  return { title: title.replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS), text, scripted }
}

/** Text with the spaces around each line trimmed, and no more than one empty line in a row. */
function tidy(text: string): string {
  return (
    text
      .split('\n')
      // One space at a line's start is left from joining the text around a tag; more is a `pre`'s indent.
      .map((line) => line.trimEnd().replace(/^ (?=\S)/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/** What Browser Run's markdown action answers when it rendered the page, as far as the worker reads it. */
const RenderAnswer = z.object({ success: z.literal(true), result: z.string() })

/**
 * How a render ended: it gave a page, the page showed no text, Browser Run turned it away for
 * coming too often (`render_busy`), or it could not be rendered.
 */
export type RenderOutcome = 'ok' | 'no_text' | 'render_busy' | 'render_failed'

/**
 * A render, however it ended: the page, or why there is none, and the browser time Browser Run
 * reported for it (`X-Browser-Ms-Used`), which is what it bills; 0 when it reported none, or no
 * response came back.
 */
export type Render = { browserMs: number } & (
  | { outcome: 'ok'; page: WebPage }
  | { outcome: Exclude<RenderOutcome, 'ok'>; error: PageError }
)

/** The browser time a Browser Run response reports, or 0 when it reports none it can be read as. */
function browserTimeOf(res: Response): number {
  const used = res.headers.get('x-browser-ms-used')?.trim() ?? ''
  const ms = /^\d+$/.test(used) ? Number(used) : NaN
  return Number.isSafeInteger(ms) ? ms : 0
}

/**
 * Renders the page at `url` in Browser Run, which runs its scripts, and gives its text as Markdown,
 * clipped to `maxChars`, with the browser time it used. Never throws a PageError: a page that could
 * not be rendered is the result. Nothing is retried.
 */
export async function renderPage(browser: BrowserBinding, url: URL, maxChars: number): Promise<Render> {
  const failed = (browserMs: number) =>
    ({
      outcome: 'render_failed',
      error: new PageError('render_failed', 'the page could not be rendered'),
      browserMs,
    }) as const
  let res: Response
  try {
    res = await browser.quickAction('markdown', {
      url: url.href,
      userAgent: USER_AGENT,
      gotoOptions: { waitUntil: 'networkidle2', timeout: RENDER_TIMEOUT_MS },
    })
  } catch {
    return failed(0)
  }
  const answer = RenderAnswer.safeParse(await res.json().catch(() => undefined))
  const browserMs = browserTimeOf(res)
  // Browser Run's limits on the account (renders at once, or a minute): another render now would be
  // turned away too, so it is a code of its own, which stops the question.
  if (res.status === 429) {
    const error = new PageError('render_busy', 'the browser that renders pages is busy')
    return { outcome: 'render_busy', error, browserMs }
  }
  if (!res.ok || !answer.success) return failed(browserMs)
  const text = tidy(answer.data.result)
  if (!text) {
    const error = new PageError('no_text', 'the page shows no text, even rendered')
    return { outcome: 'no_text', error, browserMs }
  }
  const page: WebPage = {
    url: url.href,
    title: /^#\s+(.+)$/m.exec(text)?.[1].trim().slice(0, TITLE_CHARS) ?? '',
    text: text.slice(0, maxChars),
    chars: text.length,
    scripted: false,
  }
  return { outcome: 'ok', page, browserMs }
}
