// Runs Notion requests inside the user's Notion tab, so they are same-origin requests with the
// tab's own session, exactly like Notion's own client. Sessions are per host (app.notion.com and
// www.notion.so don't share one), which a request from the tab gets right by construction.
// The worker's tests import this file too, and their tsconfig has no chrome types.
/// <reference types="chrome" />
import {
  NO_NOTION_TAB,
  NotionClient,
  NotionCooldown,
  NotionError,
  NotionUsage,
  type CooldownStore,
  type NotionResponse,
  type NotionTransport,
} from './api'
import { NOTION_HOSTS, isNotion, pageIdFromUrl } from './hosts'

/** The Notion tab of the side panel's window, and a client that calls Notion as its user. */
export interface NotionTab {
  tabId: number
  url: string
  /** The page the tab shows, if it shows one (not, say, Notion's home). */
  pageId?: string
  client: NotionClient
}

/** Where chrome.storage.local keeps the time the wait after Notion turned a request away ends. */
export const COOLDOWN_KEY = 'notionCooldownUntil'

/**
 * The wait's end time in chrome.storage.local, which every side panel of the browser shares and
 * a browser restart keeps. A value left over from long ago does no harm: it is in the past.
 */
export const chromeCooldownStore: CooldownStore = {
  load: async () => (await chrome.storage.local.get(COOLDOWN_KEY))[COOLDOWN_KEY],
  save: async (until) => chrome.storage.local.set({ [COOLDOWN_KEY]: until }),
  onChange: (listener) =>
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[COOLDOWN_KEY]) listener(changes[COOLDOWN_KEY].newValue)
    }),
}

/**
 * The wait after Notion turns a request away, kept by every client of every side panel: each
 * panel is a document of its own, so the end time lives in chrome.storage (see activeNotionTab).
 */
export const notionCooldown = new NotionCooldown(undefined, chromeCooldownStore)

/** The Notion requests of the question being answered; see countNotionRequests. */
let usage: NotionUsage | undefined

/**
 * Starts counting the Notion requests of a new question: every client made from now on counts
 * toward it. A client keeps the question it was made in, so a tool still running from an earlier
 * question never counts toward the next one. `ask` asks the user whether to go on at the budget.
 */
export function countNotionRequests(ask?: (question: string) => Promise<boolean>): NotionUsage {
  return (usage = new NotionUsage(ask))
}

/**
 * The active tab of the side panel's window, if it is on Notion; otherwise a `no_notion_tab` error.
 * The panel is open on every tab, so this is where a Notion tool finds out it can't run. Only the
 * active tab counts: a Notion page open in another tab is never used instead.
 */
export async function activeNotionTab(): Promise<NotionTab> {
  // The question that asked for the tab, even if another one starts while the tab is looked up.
  const counted = usage
  // Every client is made here, so none sends before a wait another side panel started is known.
  await notionCooldown.ready()
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined || !tab.url || !isNotion(tab.url)) throw new NotionError('no_notion_tab', NO_NOTION_TAB)
  const client = new NotionClient(tabTransport(tab.id), counted, notionCooldown)
  return { tabId: tab.id, url: tab.url, pageId: pageIdFromUrl(tab.url), client }
}

const TAB_RELOADED = 'The Notion tab reloaded or went to another page before Notion answered this request.'

const NO_SITE_ACCESS =
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
        // As JSON text: Chrome drops object keys whose value is null from script arguments, and a
        // null can mean something to Notion (it removes a database property).
        args: [endpoint, JSON.stringify(body), spaceId ?? null, NOTION_HOSTS, REQUEST_TIMEOUT_MS],
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
    // It may still be on Notion, so this doesn't send the user to a Notion page as NO_NOTION_TAB does.
    if (!result) throw new NotionError('no_notion_tab', TAB_RELOADED, { unanswered: true })
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
  /** The request body as JSON text. */
  body: string,
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
      body,
      signal: AbortSignal.timeout(timeoutMs),
      // Notion's API never redirects; following one would send the body (a write, say) elsewhere.
      redirect: 'manual',
    })
    if (res.type === 'opaqueredirect') return { status: res.status, json: null, userId, redirected: true }
    const text = await res.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      // Not JSON (e.g. an HTML error page); the status says enough.
    }
    return { status: res.status, json, userId, retryAfter: res.headers.get('retry-after') ?? undefined }
  } catch (err) {
    return { status: 0, json: null, userId, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The Notion user signed in to the tab, the one its requests go as; undefined when none is, or the
 * tab can't be read. Reads the tab's cookie, without asking Notion.
 */
export async function notionUserIn(tabId: number): Promise<string | undefined> {
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: tabUser,
      args: [],
    })
    return typeof frame?.result === 'string' ? frame.result : undefined
  } catch {
    return undefined
  }
}

/** Runs in the Notion tab, like notionRequest: the user it sends as, from the same cookie. */
function tabUser(): string | null {
  const raw = /(?:^|;\s*)notion_user_id=([^;]+)/.exec(document.cookie)?.[1]
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** What the user has selected in the Notion page: the selected text and the blocks it covers. */
export interface PageSelection {
  /** The text selected with the mouse; none when blocks are selected as blocks. */
  text?: string
  blockIds: string[]
  /**
   * Blocks selected as blocks that reach the first or last block Notion has drawn in the page.
   * Notion may draw only part of a long page, so the selection may go on past what was drawn.
   */
  reaches?: { start: boolean; end: boolean }
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
function readSelection(): PageSelection | null {
  // The main page and a side peek each have their own content.
  const roots = [...document.querySelectorAll('.notion-page-content')]
  const idOf = (el: Element) => el.getAttribute('data-block-id') ?? ''
  // Blocks selected as blocks (Esc, or dragging across them) carry a highlight inside them.
  for (const root of roots) {
    const blocks = [...root.querySelectorAll('[data-block-id]')]
    const haloed = [...root.querySelectorAll('.notion-selectable-halo')]
      .map((h) => h.closest('[data-block-id]'))
      .filter((b): b is Element => !!b && root.contains(b))
    const chosen = blocks.filter((b) => haloed.includes(b))
    if (!chosen.length) continue
    const first = chosen[0]
    const last = chosen[chosen.length - 1]
    return {
      blockIds: chosen.map(idOf),
      reaches: {
        // Only blocks that hold the first one are drawn before it.
        start: blocks.slice(0, blocks.indexOf(first)).every((b) => b.contains(first)),
        // Only blocks inside selected ones are drawn after the last one.
        end: blocks.slice(blocks.indexOf(last) + 1).every((b) => chosen.some((c) => c.contains(b))),
      },
    }
  }
  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  // Whether the range selects some characters of `node`. A range that only starts at its end or
  // ends at its start (a triple-click, or a drag to the end of a line) doesn't select it.
  const covers = (node: Node): boolean => {
    const part = document.createRange()
    part.selectNodeContents(node)
    // 0 is Range.START_TO_START and 2 is Range.END_TO_END.
    if (range.compareBoundaryPoints(0, part) > 0) part.setStart(range.startContainer, range.startOffset)
    if (range.compareBoundaryPoints(2, part) < 0) part.setEnd(range.endContainer, range.endOffset)
    return !part.collapsed && part.toString().length > 0
  }
  // Whether the range covers some of the block's own content, not only the blocks nested in it.
  const ownTouched = (el: Element): boolean =>
    [...el.children].some(
      (c) => !c.getAttribute('data-block-id') && covers(c) && (!c.querySelector('[data-block-id]') || ownTouched(c)),
    )
  // A range can start outside the content (in the page title) or run from the page into a side
  // peek: only the blocks it covers inside each content count.
  const chosen = roots
    .filter((root) => range.intersectsNode(root))
    .flatMap((root) => {
      const touched = [...root.querySelectorAll('[data-block-id]')].filter(covers)
      return touched.filter((b) => !touched.some((other) => other !== b && b.contains(other)) || ownTouched(b))
    })
  if (!chosen.length) return null
  return { text: selection.toString(), blockIds: chosen.map(idOf) }
}
