// The site layer for a page in one of the user's tabs (the current tab, or a tab the user added to
// the conversation): reads its main content, as the tab shows it, in the tab itself
// (chrome.scripting, ISOLATED world). So it reaches what the user sees there, pages behind their
// sign-in and content drawn by scripts included, and sends no request of its own. The extension may
// read a site only once the user allowed it (optional host permissions, one origin at a time), which
// only a click in the side panel can grant. It also reads the text selected in a tab, on any site,
// when the user sends it with the context menu. `product` is the extension's name, as the reasons
// the model is told name it. It is the package's `@cofun/tools/tab`, which imports nothing of the
// agent, so the extension's service worker can read a selection without loading the agent runtime.

import { z } from './zod'
import { pageMarkdown } from './markdown'

/** The match pattern of a site's origin, as host permissions name it. */
const pattern = (origin: string) => `${origin}/*`

/** The Chrome Web Store, where Chrome lets no extension run scripts. */
const STORE = [/^https:\/\/chromewebstore\.google\.com\//, /^https:\/\/chrome\.google\.com\/webstore(\/|$)/]

/**
 * Whether the extension holds the URL's host by install (its required host permissions): the hosts
 * its sign-in uses, and the site its own tools work on (Notion, for Notico), which those tools read
 * and the tab tools leave to them (see `ownSite` in tools/tabs.ts). Such a host needs no grant from
 * the user, so a tab on it is never read here: a sign-in page would hand its contents to the model
 * without the user being asked. The build emits HTTP(S) host patterns, including the wildcard for
 * the sign-in cookie's domain.
 */
function isInstalledHost(url: URL): boolean {
  const permissions = z.array(z.string()).safeParse(chrome.runtime.getManifest().host_permissions).data ?? []
  return permissions.some((permission) => {
    const match = /^(https?):\/\/(\*\.)?([^/]+)\/\*$/.exec(permission)
    if (!match || url.protocol !== `${match[1]}:`) return false
    const host = new URL(`${url.protocol}//${match[3]}`).hostname
    return url.hostname === host || Boolean(match[2] && url.hostname.endsWith(`.${host}`))
  })
}

/**
 * Which tab a reason is about, as the model reads it: the current tab, or a tab the user added to
 * the conversation.
 */
export type TabWhere = 'the current tab' | 'the tab'

const cap = (where: TabWhere) => where[0].toUpperCase() + where.slice(1)

/**
 * The origin of the site a tab shows, when the extension can be allowed to read it; otherwise why not, in
 * words for the model.
 */
export function readableSite(
  url: string,
  product: string,
  where: TabWhere = 'the current tab',
): { origin: string } | { reason: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { reason: `${cap(where)}'s address is not one ${product} can read.` }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    return {
      reason:
        `${cap(where)} shows a ${parsed.protocol.replace(/:$/, '')}: page (a browser or extension page, or a ` +
        `local file), which ${product} can't read: only web pages on http or https.`,
    }
  if (isInstalledHost(parsed))
    return { reason: `${cap(where)} is on a host ${product} uses for sign-in, which the tab tools cannot read.` }
  if (STORE.some((store) => store.test(url)))
    return { reason: `${cap(where)} is the Chrome Web Store: Chrome doesn't let extensions read it.` }
  // Told before the user is asked to allow the site; a PDF at another address shows only once read.
  if (/\.pdf$/i.test(parsed.pathname)) return { reason: pdf(where, product) }
  return { origin: parsed.origin }
}

/** Whether the user allowed the extension to read the site with this origin. */
export async function mayRead(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [pattern(origin)] })
}

/**
 * Asks Chrome to let the extension read the site with this origin, which shows the user Chrome's own
 * prompt. Chrome takes the request only during a user's click or key press: call it in its handler,
 * before anything is awaited. Resolves true once Chrome granted it.
 */
export function allowSite(origin: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [pattern(origin)] })
}

/**
 * allowSite, as a tool call's card answers the call with it: Chrome's yes or no, or, when Chrome could
 * not ask, an error that tells the model nothing was read and not to ask again unless the user asks.
 * Call it in the click's handler, as allowSite.
 */
export function askToRead(origin: string): Promise<boolean | Error> {
  return allowSite(origin).catch((err: unknown) => {
    console.error('Could not ask Chrome for access to the site', err)
    return new Error(
      'Chrome could not request access to the site, so nothing was read. ' +
        'The user can ask again. Do not request access again unless the user asks.',
      { cause: err },
    )
  })
}

const pdf = (where: TabWhere, product: string) =>
  `${cap(where)} shows a PDF in Chrome's viewer, which ${product} can't read.`

/**
 * What the script in the tab returns. The page can reach the DOM it reads (a named element can
 * stand in for `document.title`), so the result is parsed, not trusted. `html`: the page's main
 * content (see pageHtml), `cut` when it was cut short; `frames`: how many frames the page holds,
 * which are not read.
 */
const PageResult = z.union([
  z.object({ pdf: z.literal(true) }),
  z.object({ title: z.string(), url: z.string(), html: z.string(), cut: z.boolean(), frames: z.number() }),
])

/**
 * The page a tab shows, as read from it: its main content as Markdown, up to the characters asked
 * for, and how long it all is; `longer` when the page is longer still, as its HTML was cut in the tab.
 */
export interface TabPage {
  title: string
  url: string
  text: string
  chars: number
  longer: boolean
  frames: number
}

/**
 * How much of a page's HTML the tab hands over, for each character of Markdown asked for: markup
 * holds far more than its text, and a long thread or feed should not be carried and converted in
 * full only for its first characters to be kept.
 */
const HTML_PER_CHAR = 50
/**
 * The most HTML the tab hands over, whatever is asked for: a page kept whole (see KEPT_CHARS in
 * tools/results.ts) would otherwise hand over a hundred million characters to be converted.
 */
const MAX_HTML_CHARS = 10_000_000

/**
 * Reads up to `maxChars` of the main content of the page in the tab, as Markdown; the tab must
 * still be on `origin`. Otherwise, or when the tab can't be read, says why, for the model, naming
 * the tab as `where`.
 */
export async function readPage(
  tabId: number,
  origin: string,
  maxChars: number,
  product: string,
  where: TabWhere = 'the current tab',
): Promise<TabPage | { reason: string }> {
  let raw: unknown
  try {
    // ISOLATED, not MAIN: the page can't see or patch this code. The top frame only: frames from
    // other sites are other sites, which the user may not have allowed.
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: pageHtml,
      args: [origin, Math.min(maxChars * HTML_PER_CHAR, MAX_HTML_CHARS)],
    })
    raw = frame?.result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/Cannot access contents of|Missing host permission/i.test(message))
      return { reason: `Chrome did not let ${product} read the page in ${where}: it may have gone to another site.` }
    if (/error page|chrome-error/i.test(message))
      return { reason: `${cap(where)} shows an error page: there is nothing to read.` }
    return { reason: `Could not read the page in ${where}: ${message}` }
  }
  if (raw === undefined || raw === null)
    return { reason: `${cap(where)} reloaded or went to another page while it was read.` }
  const parsed = PageResult.safeParse(raw)
  if (!parsed.success) return { reason: `The page in ${where} could not be read: it did not give its text.` }
  const result = parsed.data
  if ('pdf' in result) return { reason: pdf(where, product) }
  const text = pageMarkdown(result.html)
  if (!text && result.frames)
    return {
      reason: `The page in ${where} shows no text of its own: its content is in frames, which ${product} doesn't read.`,
    }
  // The tab may have moved on since it was looked at, to a site the user allowed for something else.
  if (new URL(result.url).origin !== origin) return { reason: `${cap(where)} went to another site while it was read.` }
  return {
    title: result.title,
    url: result.url,
    text: text.slice(0, maxChars),
    chars: text.length,
    longer: result.cut,
    frames: result.frames,
  }
}

/**
 * The text selected in one frame of the tab, as the page shows it, line breaks included; undefined
 * when it can't be read there. Called on a click on the context menu's item, which gives the
 * extension the tab until it goes to another page (activeTab): no site need be allowed for it.
 */
export async function selectedText(tabId: number, frameId: number): Promise<string | undefined> {
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'ISOLATED',
      func: selectionText,
    })
    const parsed = z.string().safeParse(frame?.result)
    return parsed.success ? parsed.data : undefined
  } catch {
    // activeTab reaches the tab's own site only: a frame from another one, say.
    return undefined
  }
}

/** Keeps a UTF-16 budget without leaving half of a supplementary character at the end. */
export function clipSelection(text: string, limit: number): string {
  return text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '')
}

/** Runs in the tab (see pageHtml): the frame's selection as text. */
function selectionText(): string {
  return document.getSelection()?.toString() ?? ''
}

/**
 * Runs in the tab. Chrome serializes this function on its own, so it must not use anything from
 * outside its body, and it must not throw. The main content is the page's `main` element (or its
 * main landmark), else its first `article`, else the whole body: the first of them that shows any
 * text. It is given as HTML, for the side panel to turn into Markdown (markdown.ts), from a
 * copy without what the page doesn't show, what is not part of its text (scripts, styles, frames,
 * media, form fields; a button's text is kept, as an accordion's questions are buttons), and its
 * navigation, asides, and footers; its links made absolute, without
 * their fragment, and only on links to http(s) pages. Up to `maxHtml` characters of it: a cut tag
 * or element is mended when the side panel parses it.
 */
function pageHtml(origin: string, maxHtml: number): z.input<typeof PageResult> | null {
  if (location.origin !== origin) return null
  if (document.contentType === 'application/pdf') return { pdf: true }
  // What markdown.ts reads, besides the class that names a code block's language.
  const KEPT = ['href', 'alt', 'colspan', 'rowspan', 'start']
  const LEFT_OUT =
    'script, style, noscript, template, svg, canvas, iframe, frame, object, embed, video, audio, map, nav, ' +
    'aside, footer, input, select, textarea, dialog:not([open]), [hidden], [aria-hidden="true"]'
  // What the user would not see. Chrome finds that from the layout, element by element, without
  // computing every node's style; an element shown as its children only (display: contents) has no
  // box of its own but is shown. Where the browser can't tell (no checkVisibility), it is shown.
  // Left out with what hides it, as rare as they are: a part shown again inside a part hidden by
  // `visibility` (a whole branch goes at once), and the page under an open modal dialog that marked
  // it aria-hidden (only the dialog is read then, as only the dialog can be used).
  const unseen = (el: Element) =>
    typeof el.checkVisibility === 'function' &&
    !el.checkVisibility({ visibilityProperty: true }) &&
    getComputedStyle(el).display !== 'contents'
  const shown = (root: Element | null): string => {
    if (!root) return ''
    const copy = root.cloneNode(true)
    if (!(copy instanceof Element)) return ''
    // The copy has the same elements in the same order, but no layout: the page's own say what is shown.
    const from = [root, ...root.querySelectorAll('*')]
    const to = [copy, ...copy.querySelectorAll('*')]
    for (let i = 0; i < from.length; i++) {
      if (!from[i].matches(LEFT_OUT) && !unseen(from[i])) continue
      if (i === 0) return ''
      to[i].remove()
      // Its descendants go with it.
      i += from[i].querySelectorAll('*').length
    }
    // Only the attributes the side panel reads: on pages styled by class names, the others hold
    // more than the text does, and would use up the HTML the tab hands over.
    for (const el of [copy, ...copy.querySelectorAll('*')])
      for (const name of el.getAttributeNames())
        if (!KEPT.includes(name) && !(name === 'class' && (el.localName === 'pre' || el.localName === 'code')))
          el.removeAttribute(name)
    for (const link of copy.querySelectorAll('a')) {
      // An anchor with no address (a named target, a script's button) links nowhere; an empty one
      // would be the page itself.
      const href = link.getAttribute('href')
      if (!href) {
        link.removeAttribute('href')
        continue
      }
      let url: URL | undefined
      try {
        // A link to a place on the same page leads nowhere new.
        url = href.startsWith('#') ? undefined : new URL(href, document.baseURI)
      } catch {
        url = undefined
      }
      if (url && (url.protocol === 'https:' || url.protocol === 'http:')) {
        // A fragment rarely says more than where on the page to look; it can carry a token.
        url.hash = ''
        link.setAttribute('href', url.href)
      } else link.removeAttribute('href')
    }
    return copy.textContent?.trim() ? copy.innerHTML : ''
  }
  const html =
    shown(document.querySelector('main, [role="main"]')) ||
    shown(document.querySelector('article')) ||
    shown(document.body)
  // A named element can stand in for the title; the tab then gives none.
  const title = typeof document.title === 'string' ? document.title : ''
  const frames = document.querySelectorAll('iframe, frame').length
  return { title, url: location.href, html: html.slice(0, maxHtml), cut: html.length > maxHtml, frames }
}
