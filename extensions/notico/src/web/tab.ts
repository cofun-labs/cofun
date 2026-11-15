// Reads the page in the user's current tab when it is on another site than Notion: its main text,
// as the tab shows it, in the tab itself (chrome.scripting, ISOLATED world). So it reaches what the
// user sees there, pages behind their sign-in and content drawn by scripts included, and sends no
// request of its own. Notico may read a site only once the user allowed it (optional host
// permissions, one origin at a time), which only a click in the side panel can grant. It also reads
// the text selected in a tab, on any site, when the user sends it with the context menu.

import { z } from '../zod'

/** The match pattern of a site's origin, as host permissions name it. */
const pattern = (origin: string) => `${origin}/*`

/** The Chrome Web Store, where Chrome lets no extension run scripts. */
const STORE = [/^https:\/\/chromewebstore\.google\.com\//, /^https:\/\/chrome\.google\.com\/webstore(\/|$)/]

/**
 * The origin of the site a tab shows, when Notico can be allowed to read it; otherwise why not, in
 * words for the model.
 */
export function readableSite(url: string): { origin: string } | { reason: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { reason: "The current tab's address is not one Notico can read." }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    return {
      reason:
        `The current tab shows a ${parsed.protocol.replace(/:$/, '')}: page (a browser or extension page, or a ` +
        "local file), which Notico can't read: only web pages on http or https.",
    }
  if (STORE.some((store) => store.test(url)))
    return { reason: "The current tab is the Chrome Web Store: Chrome doesn't let extensions read it." }
  // Told before the user is asked to allow the site; a PDF at another address shows only once read.
  if (/\.pdf$/i.test(parsed.pathname)) return { reason: PDF }
  return { origin: parsed.origin }
}

/** Whether the user allowed Notico to read the site with this origin. */
export async function mayRead(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [pattern(origin)] })
}

/**
 * Asks Chrome to let Notico read the site with this origin, which shows the user Chrome's own
 * prompt. Chrome takes the request only from a user's click: call it in the click's handler, before
 * anything is awaited. Resolves true once Chrome granted it.
 */
export function allowSite(origin: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [pattern(origin)] })
}

const PDF = "The current tab shows a PDF in Chrome's viewer, which Notico can't read."

/**
 * What the script in the tab returns. The page can reach the DOM it reads (a named element can
 * stand in for `document.title`), so the result is parsed, not trusted. `frames`: how many frames
 * the page holds, which are not read.
 */
const PageResult = z.union([
  z.object({ pdf: z.literal(true) }),
  z.object({ title: z.string(), url: z.string(), text: z.string(), chars: z.number(), frames: z.number() }),
])

/** The page a tab shows, as read from it: its main text up to the characters asked for, and how long it all is. */
export type TabPage = Exclude<z.infer<typeof PageResult>, { pdf: true }>

/**
 * Reads up to `maxChars` of the main text of the page in the tab, which must still be on `origin`;
 * otherwise, or when the tab can't be read, says why, for the model.
 */
export async function readPage(tabId: number, origin: string, maxChars: number): Promise<TabPage | { reason: string }> {
  let raw: unknown
  try {
    // ISOLATED, not MAIN: the page can't see or patch this code. The top frame only: frames from
    // other sites are other sites, which the user may not have allowed.
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: pageText,
      args: [maxChars],
    })
    raw = frame?.result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/Cannot access contents of|Missing host permission/i.test(message))
      return { reason: 'Chrome did not let Notico read the page in the current tab: it may have gone to another site.' }
    if (/error page|chrome-error/i.test(message))
      return { reason: 'The current tab shows an error page: there is nothing to read.' }
    return { reason: `Could not read the page in the current tab: ${message}` }
  }
  if (raw === undefined || raw === null)
    return { reason: 'The current tab reloaded or went to another page while it was read.' }
  const parsed = PageResult.safeParse(raw)
  if (!parsed.success) return { reason: 'The page in the current tab could not be read: it did not give its text.' }
  const result = parsed.data
  if ('pdf' in result) return { reason: PDF }
  if (!result.text && result.frames)
    return {
      reason:
        "The page in the current tab shows no text of its own: its content is in frames, which Notico doesn't read.",
    }
  // The tab may have moved on since it was looked at, to a site the user allowed for something else.
  if (new URL(result.url).origin !== origin)
    return { reason: 'The current tab went to another site while it was read.' }
  return result
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

/** Runs in the tab (see pageText): the frame's selection as text. */
function selectionText(): string {
  return document.getSelection()?.toString() ?? ''
}

/**
 * Runs in the tab. Chrome serializes this function on its own, so it must not use anything from
 * outside its body, and it must not throw. The main text is the page's `main` element (or its main
 * landmark), else its first `article`, else the whole body, as the page shows it (innerText: what is
 * hidden is left out).
 */
function pageText(maxChars: number): z.input<typeof PageResult> | null {
  if (document.contentType === 'application/pdf') return { pdf: true }
  // An element's text as shown: only HTML elements have it (an SVG's `main` has none).
  const shown = (el: Element | null) =>
    el && 'innerText' in el && typeof el.innerText === 'string' ? el.innerText.trim() : ''
  const main = shown(document.querySelector('main, [role="main"]')) || shown(document.querySelector('article'))
  // Three or more line breaks in a row say nothing more than two.
  const text = (main || shown(document.body)).replace(/\n{3,}/g, '\n\n')
  // A named element can stand in for the title; the tab then gives none.
  const title = typeof document.title === 'string' ? document.title : ''
  const frames = document.querySelectorAll('iframe, frame').length
  return { title, url: location.href, text: text.slice(0, maxChars), chars: text.length, frames }
}
