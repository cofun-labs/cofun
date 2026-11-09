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
      // The tab closed or left Notion; anything else (say, a missing permission) is passed on.
      // Either way the request may have been in flight.
      const tab = await chrome.tabs.get(tabId).catch(() => undefined)
      if (!tab || !isNotion(tab.url)) {
        throw new NotionError('no_notion_tab', NO_NOTION_TAB, { cause: err, unanswered: true })
      }
      const message = err instanceof Error ? err.message : String(err)
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
    })
    // Notion's API never redirects; a redirect lands on a page (sign-in, interstitial), not an answer.
    if (res.redirected)
      return { status: res.status, json: null, signedIn: !!userId, error: 'Notion redirected the request.' }
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
