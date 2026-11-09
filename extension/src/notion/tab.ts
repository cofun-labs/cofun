// Runs Notion requests inside the user's Notion tab, so they are same-origin requests with the
// tab's own session, exactly like Notion's own client. Sessions are per host (app.notion.com and
// www.notion.so don't share one), which a request from the tab gets right by construction.
// The worker's tests import this file too, and their tsconfig has no chrome types.
/// <reference types="chrome" />
import { NO_NOTION_TAB, NotionClient, NotionError, type NotionResponse, type NotionTransport } from './api'
import { NOTION_HOSTS, isNotion, pageIdFromUrl } from './hosts'

/** The Notion tab of the side panel's window, and a client that calls Notion as its user. */
export interface NotionTab {
  tabId: number
  url: string
  /** The page the tab shows, if it shows one (not, say, Notion's home). */
  pageId?: string
  client: NotionClient
}

/** The active tab of the side panel's window, if it is on Notion; otherwise a `no_notion_tab` error. */
export async function activeNotionTab(): Promise<NotionTab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined || !tab.url || !isNotion(tab.url)) throw new NotionError('no_notion_tab', NO_NOTION_TAB)
  return { tabId: tab.id, url: tab.url, pageId: pageIdFromUrl(tab.url), client: new NotionClient(tabTransport(tab.id)) }
}

export const NO_SITE_ACCESS =
  "Notion Copilot is not allowed to access this Notion site. Allow it in the extension's site access settings and try again"

/** How long one Notion request may take before it fails, so a stalled request can't hang a tool. */
const REQUEST_TIMEOUT_MS = 30_000

/** Sends requests through `chrome.scripting` in the given tab. */
export function tabTransport(tabId: number): NotionTransport {
  return async (endpoint, body, { spaceId }) => {
    let result: Awaited<ReturnType<typeof notionRequest>> | undefined
    try {
      // ISOLATED, not MAIN: the page can't see or patch this code (Notion wraps window.fetch).
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: notionRequest,
        args: [endpoint, body, spaceId ?? null, NOTION_HOSTS, REQUEST_TIMEOUT_MS],
      })
      result = frame?.result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Chrome refused to run the script at all: nothing was sent.
      const refused = /Cannot access contents of|Missing host permission|Cannot access a chrome/i.test(message)
      // The tab closed, navigated, or left Notion: say so, and that the request may have been in
      // flight unless Chrome refused to run it.
      const tab = await chrome.tabs.get(tabId).catch(() => undefined)
      if (!tab || !isNotion(tab.url)) {
        throw new NotionError('no_notion_tab', NO_NOTION_TAB, { cause: err, unanswered: !refused })
      }
      if (refused) throw new NotionError('notion_error', `${NO_SITE_ACCESS} (${message})`, { cause: err })
      throw new NotionError('notion_error', `Could not run in the Notion tab: ${message}`, {
        cause: err,
        unanswered: true,
      })
    }
    // No result: the tab reloaded or navigated while the request was in flight.
    if (!result) throw new NotionError('no_notion_tab', NO_NOTION_TAB, { unanswered: true })
    // The tab was no longer on Notion, so nothing was sent.
    if ('notOnNotion' in result) throw new NotionError('no_notion_tab', NO_NOTION_TAB)
    return result
  }
}

/**
 * Runs in the Notion tab. Chrome serializes this function on its own, so it must not use
 * anything from outside its body, and it must not throw.
 */
export async function notionRequest(
  endpoint: string,
  body: unknown,
  spaceId: string | null,
  hosts: string[],
  timeoutMs: number,
): Promise<NotionResponse | { notOnNotion: true }> {
  // The tab may have navigated since the side panel looked at it.
  if (!hosts.includes(location.hostname)) return { notOnNotion: true }
  // notion_user_id is not HttpOnly (checked in the #64 spike); Notion's own client reads it too.
  let userId = /(?:^|;\s*)notion_user_id=([^;]+)/.exec(document.cookie)?.[1]
  try {
    if (userId) userId = decodeURIComponent(userId)
  } catch {
    // A malformed cookie: use it as it is.
  }
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    // Picks the tab's user when several Notion accounts are signed in.
    if (userId) headers['x-notion-active-user-header'] = userId
    if (spaceId) headers['x-notion-space-id'] = spaceId
    const res = await fetch(`/api/v3/${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // Notion's API never redirects; following one would send the body (a write, say) elsewhere.
      redirect: 'manual',
    })
    if (res.type === 'opaqueredirect') return { status: res.status, json: null, signedIn: !!userId, redirected: true }
    const text = await res.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      // Not JSON (e.g. an HTML error page); the status says enough.
    }
    return { status: res.status, json, signedIn: !!userId }
  } catch (err) {
    return { status: 0, json: null, signedIn: !!userId, error: err instanceof Error ? err.message : String(err) }
  }
}

/** What the user has selected in the Notion page: the selected text and the blocks it covers. */
export interface PageSelection {
  /** The text selected with the mouse; none when blocks are selected as blocks. */
  text?: string
  blockIds: string[]
}

/** Reads the selection in the Notion tab: text selected with the mouse, or blocks selected as blocks. */
export async function selectionIn(tabId: number): Promise<PageSelection | undefined> {
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: readSelection,
      args: [],
    })
    return frame?.result ?? undefined
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new NotionError('notion_error', `Could not read the selection in the Notion tab: ${message}`, { cause: err })
  }
}

/**
 * Runs in the Notion tab: the selection inside the page's content (not the sidebar). Chrome
 * serializes this function on its own, so it must not use anything from outside its body.
 */
export function readSelection(): PageSelection | null {
  // The main page and a side peek each have their own content.
  const roots = [...document.querySelectorAll('.notion-page-content')]
  const idOf = (el: Element) => el.getAttribute('data-block-id') ?? ''
  // Blocks selected as blocks (Esc, or dragging across them) carry a highlight inside them.
  for (const root of roots) {
    const haloed = [...root.querySelectorAll('.notion-selectable-halo')]
      .map((h) => h.closest('[data-block-id]'))
      .filter((b): b is Element => !!b && root.contains(b))
    if (haloed.length)
      return {
        blockIds: [...root.querySelectorAll('[data-block-id]')].filter((b) => haloed.includes(b)).map(idOf),
      }
  }
  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const root = roots.find((r) => r.contains(range.commonAncestorContainer))
  if (!root) return null
  const blocks = [...root.querySelectorAll('[data-block-id]')]
  const touched = blocks.filter((b) => range.intersectsNode(b))
  // Whether the range covers some of the block's own content, not only the blocks nested in it.
  const ownTouched = (el: Element): boolean =>
    [...el.children].some(
      (c) =>
        !c.getAttribute('data-block-id') &&
        range.intersectsNode(c) &&
        (!c.querySelector('[data-block-id]') || ownTouched(c)),
    )
  const chosen = touched.filter((b) => !touched.some((other) => other !== b && b.contains(other)) || ownTouched(b))
  if (!chosen.length) return null
  return { text: selection.toString(), blockIds: chosen.map(idOf) }
}
