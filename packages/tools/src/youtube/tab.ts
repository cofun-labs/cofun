// Reads a YouTube video in one of the user's tabs, on www.youtube.com once the user allowed it, with
// chrome.scripting in the ISOLATED world: two requests from the tab to its own origin, with its
// session, as the page makes them itself. The watch page of the video the tab shows, for what it
// says about the video (the tab's own copy of it may be of an earlier video: YouTube changes video
// without loading a page); then, when the video has captions, the transcript panel's request, which
// the page sends when the user opens "Show transcript". Both are reads, each sent once, and follow
// no redirect. What they answer is parsed in video.ts.
import type { TabWhere } from '../tab'
import { z } from '../zod'
import { TRANSCRIPT_PANEL, transcriptLines, videoPage, type Line, type VideoPage } from './video'

/** A video as read from its tab: its page, and its transcript's lines, when it has a transcript. */
export interface TabVideo {
  url: string
  video: VideoPage
  lines: Line[]
}

/**
 * Why the video was not read, in words for the model; `turnedAway` when YouTube turned the request
 * away for coming too often, which stops the question (what the user is told).
 */
export interface NotRead {
  reason: string
  turnedAway?: string
}

/** What the scripts in the tab return; null when the tab is no longer on the video. Parsed, not trusted. */
const Failed = z.object({ failed: z.string() })
const PageResult = z.union([
  Failed,
  z.object({
    status: z.number(),
    url: z.string(),
    player: z.unknown(),
    markers: z.unknown(),
    params: z.unknown(),
    context: z.unknown(),
  }),
])
const PanelResult = z.union([Failed, z.object({ status: z.number(), body: z.unknown() })])

/**
 * Reads the video `id` in the tab, which must still show it on `origin` (www.youtube.com): its
 * page, and its transcript when it has one. `unplayable` when the page gives no details of the
 * video (YouTube doesn't play it), for the caller to read the page as any other.
 */
export async function readVideo(
  tabId: number,
  origin: string,
  id: string,
  product: string,
  where: TabWhere,
): Promise<TabVideo | { unplayable: string } | NotRead> {
  const page = await inTab(tabId, watchPage, [origin, id], PageResult, product, where)
  if ('reason' in page) return page
  if ('failed' in page) return { reason: `The video in ${where} was not read: its page did not load (${page.failed}).` }
  if (page.status !== 200) return refused(page.status, `The video in ${where} was not read`)
  const video = videoPage(id, page)
  if ('unplayable' in video || 'reason' in video) {
    if ('reason' in video) return { reason: `The video in ${where} was not read: ${video.reason}` }
    return video
  }
  if (!video.request) return { url: page.url, video, lines: [] }
  const { params, context } = video.request
  const panel = await inTab(
    tabId,
    transcriptPanel,
    [origin, id, TRANSCRIPT_PANEL, params, context],
    PanelResult,
    product,
    where,
  )
  const notRead = `The transcript of the video in ${where} was not read`
  if ('reason' in panel) return panel
  if ('failed' in panel) return { reason: `${notRead}: YouTube did not answer (${panel.failed}).` }
  if (panel.status !== 200) return refused(panel.status, notRead)
  const lines = transcriptLines(panel.body)
  if (!lines) return { reason: `${notRead}: YouTube's answer was not a transcript that could be read.` }
  if (!lines.length) return { reason: `${notRead}: YouTube gave it with no lines.` }
  return { url: page.url, video, lines }
}

/** A request YouTube answered with an error: turned away when it came too often, else not understood. */
function refused(status: number, notRead: string): NotRead {
  if (status === 429)
    return {
      reason: `${notRead}: YouTube turned the request away for coming too often.`,
      turnedAway: 'YouTube turned away a request for coming too often. Wait a while before asking about a video again.',
    }
  return { reason: `${notRead}: YouTube answered with an error (HTTP ${status}).` }
}

/** Runs `func` in the tab and parses what it returns; or why it could not run there. */
async function inTab<A extends unknown[], S extends z.ZodType>(
  tabId: number,
  func: (...args: A) => unknown,
  args: A,
  schema: S,
  product: string,
  where: TabWhere,
): Promise<z.infer<S> | NotRead> {
  let raw: unknown
  try {
    // ISOLATED, not MAIN: the page can't see or patch this code. The top frame only.
    const [frame] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func, args })
    raw = frame?.result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/Cannot access contents of|Missing host permission/i.test(message))
      return { reason: `Chrome did not let ${product} read the video in ${where}: it may have gone to another site.` }
    return { reason: `Could not read the video in ${where}: ${message}` }
  }
  if (raw === undefined || raw === null)
    return { reason: `${where[0].toUpperCase()}${where.slice(1)} went to another page while the video was read.` }
  const parsed = schema.safeParse(raw)
  if (!parsed.success)
    return { reason: `The video in ${where} could not be read: the tab gave nothing that could be read.` }
  return parsed.data
}

/**
 * Runs in the tab: the watch page of the video `id`, from the tab's own origin, and what is read
 * of it: the player response, the markers map of the player's bar, the transcript panel's
 * parameters, and the request context, as the page's scripts hold them (unparsed: see video.ts).
 * Null when the tab no longer shows the video. Chrome serializes this function on its own, so it
 * must not use anything from outside its body, and it must not throw.
 */
async function watchPage(origin: string, id: string): Promise<z.input<typeof PageResult> | null> {
  if (location.origin !== origin || new URLSearchParams(location.search).get('v') !== id) return null
  let html: string
  let status: number
  try {
    const response = await fetch(`/watch?v=${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
      redirect: 'error',
      // As long as a slow page may take; the tab's own requests have no deadline.
      signal: AbortSignal.timeout(20_000),
    })
    status = response.status
    html = response.ok ? await response.text() : ''
  } catch (err) {
    return { failed: err instanceof Error ? err.message : String(err) }
  }
  /**
   * The object literal that starts at the first `{` after `marker`, from `from` on, parsed (its value
   * undefined when it is not JSON), and where it ends; undefined when there is none.
   */
  const objectAfter = (marker: string, from = 0): { value: unknown; end: number } | undefined => {
    const at = html.indexOf(marker, from)
    if (at < 0) return undefined
    const start = html.indexOf('{', at + marker.length)
    if (start < 0) return undefined
    let depth = 0
    let quoted = false
    let escaped = false
    for (let i = start; i < html.length; i++) {
      const c = html[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === '"') quoted = false
      } else if (c === '"') quoted = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        try {
          return { value: JSON.parse(html.slice(start, i + 1)), end: i + 1 }
        } catch {
          return { value: undefined, end: i + 1 }
        }
      }
    }
    return undefined
  }
  const get = (value: unknown, ...keys: string[]): unknown => {
    let at = value
    for (const key of keys) at = at && typeof at === 'object' ? Reflect.get(at, key) : undefined
    return at
  }
  const player = objectAfter('ytInitialPlayerResponse = ')?.value
  const data = objectAfter('ytInitialData = ')?.value
  // The page sets its config in several calls: the request context is in one of them.
  let context: unknown
  for (
    let found = objectAfter('ytcfg.set(');
    found && context === undefined;
    found = objectAfter('ytcfg.set(', found.end)
  )
    context = get(found.value, 'INNERTUBE_CONTEXT')
  // The transcript panel's parameters are on the command that opens it, wherever the page put it.
  let params: unknown
  const stack: unknown[] = [data]
  for (let seen = 0; stack.length && params === undefined && seen < 2_000_000; seen++) {
    const value = stack.pop()
    if (!value || typeof value !== 'object') continue
    const command = get(value, 'updateEngagementPanelContentCommand')
    if (get(command, 'contentSourcePanelIdentifier', 'tag') === 'PAmodern_transcript_view')
      params = get(command, 'globalConfiguration', 'params')
    for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child)
  }
  const markers = get(
    data,
    'playerOverlays',
    'playerOverlayRenderer',
    'decoratedPlayerBarRenderer',
    'decoratedPlayerBarRenderer',
    'playerBar',
    'multiMarkersPlayerBarRenderer',
    'markersMap',
  )
  return { status, url: location.href, player, markers, params, context }
}

/**
 * Runs in the tab: the transcript panel of the video `id`, asked for as the page asks for it, with
 * the page's parameters and request context. Null when the tab no longer shows the video. Like
 * watchPage, it uses nothing from outside its body and does not throw.
 */
async function transcriptPanel(
  origin: string,
  id: string,
  panelId: string,
  params: string,
  context: unknown,
): Promise<z.input<typeof PanelResult> | null> {
  if (location.origin !== origin || new URLSearchParams(location.search).get('v') !== id) return null
  try {
    const response = await fetch('/youtubei/v1/get_panel?prettyPrint=false', {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, panelId, params }),
      signal: AbortSignal.timeout(20_000),
    })
    let body: unknown
    try {
      body = response.ok ? await response.json() : undefined
    } catch {
      body = undefined
    }
    return { status: response.status, body }
  } catch (err) {
    return { failed: err instanceof Error ? err.message : String(err) }
  }
}
