// The current tab and the Notion page open in it: what a question carries, get_current_tab, and
// read_current_tab, which reads the page of a tab on another site; and the tabs on other sites the
// user added to the conversation, which read_tab reads.
import { defineTool } from '../tool'
import { z } from '../zod'
import { NOTION_HOSTS, isNotion, pageIdFromUrl, showsDatabase } from '../notion/hosts'
import { clip } from '../notion/comments'
import { mayRead, readPage, readableSite, type TabPage, type TabWhere } from '../web/tab'
import type { AskOnCard } from '../agent'
import { LOOK, READ, asData, count, on } from './shared'

/** The title and URL of the current tab: the active tab of the side panel's window, on any site. */
async function currentTab(): Promise<{ title: string; url: string } | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.url ? { title: tab.title ?? '', url: tab.url } : undefined
}

/**
 * The title and URL of the Notion page open in the current tab, if one is. Other sites are never
 * reported here, so their URLs and titles reach the model only through get_current_tab.
 */
export async function currentNotionPage(): Promise<OpenPage | undefined> {
  const tab = await currentTab()
  if (!tab || !isNotion(tab.url)) return undefined
  // Drop a trailing " | Notion" if the tab title has one; the model does not need it.
  return { title: tabTitle(tab.title), url: tab.url, ...(showsDatabase(tab.url) && { database: true }) }
}

/**
 * A page a question carries: its title and URL, as the tab or Notion's search showed them, and
 * whether it is a database; or, with `web`, a page on another site, in a tab the user added.
 */
export interface OpenPage {
  title: string
  url: string
  database?: true
  web?: true
}

/** The title Chrome reports for a Notion tab, without the " | Notion" a tab title may end with. */
const tabTitle = (title: string) => title.replace(/\s+\|\s+Notion$/, '')

/**
 * The Notion pages open in the browser's tabs, in any window, as Chrome reports them: no Notion
 * request. A tab that shows no page (say, Notion's home) is left out, and a page open twice is listed once.
 */
export async function openNotionPages(): Promise<OpenPage[]> {
  const seen = new Set<string>()
  // Chrome is asked for Notion's tabs only: no other site's URL or title is read.
  return (await chrome.tabs.query({ url: NOTION_HOSTS.map((host) => `https://${host}/*`) })).flatMap((tab) => {
    const id = tab.url && isNotion(tab.url) ? pageIdFromUrl(tab.url) : undefined
    if (!tab.url || !id || seen.has(id)) return []
    seen.add(id)
    return [{ title: tabTitle(tab.title ?? ''), url: tab.url, ...(showsDatabase(tab.url) && { database: true }) }]
  })
}

/** A tab on another site the user can add to a question, and whether Notico may read its site already. */
export interface WebTab {
  page: OpenPage & { web: true }
  origin: string
  allowed: boolean
}

/**
 * The tabs of the side panel's window on other sites than Notion that Notico could read, as Chrome
 * reports them: their titles and URLs only, which stay in the browser until the user adds one to a
 * question. A tab Notico can't read (a browser page, the Chrome Web Store, a PDF) is left out, and
 * an address open twice is listed once.
 */
export async function openWebTabs(): Promise<WebTab[]> {
  const seen = new Set<string>()
  const tabs = (await chrome.tabs.query({ currentWindow: true })).flatMap((tab) => {
    if (!tab.url || isNotion(tab.url) || seen.has(tab.url)) return []
    const site = readableSite(tab.url)
    if ('reason' in site) return []
    seen.add(tab.url)
    return [{ title: tab.title ?? '', url: tab.url, origin: site.origin }]
  })
  return Promise.all(
    tabs.map(async ({ origin, ...page }) => ({
      page: { ...page, web: true as const },
      origin,
      allowed: await mayRead(origin).catch(() => false),
    })),
  )
}

/**
 * The addresses of the tabs on other sites the user added to the conversation, in any of its
 * questions: the only tabs besides the current one read_tab may read. carryPages sets them.
 */
let addedTabs = new Set<string>()

/**
 * Whether the tools of the question being asked may use the page open in the current tab when a
 * call names none. False once the user took that page off the question: then such a call is refused,
 * so a page the user left out is never read in its place.
 */
let openPageAttached = true

const LEFT_OUT =
  'No page is attached to this question: the user took the page open in the current tab off it, so that page ' +
  "can't be used. Ask the user which page they mean, or search for it, and give it to this tool."

/**
 * Refuses a call that names no page while the question carries none and the current tab shows a
 * Notion page (see `openPageAttached`). On another site there is no page to leave out: Notion tools
 * fail there as everywhere off Notion, and get_current_tab gives that site's tab.
 */
export async function needsAttachedPage(): Promise<void> {
  if (!openPageAttached && (await currentNotionPage())) throw new Error(LEFT_OUT)
}

/**
 * Sets up the next question from what its composer showed: `page`, the Notion page open in the
 * current tab (if one is), whether the user took a page off the question, and the pages and tabs
 * they added to it by hand; `earlier`, the pages the conversation's earlier questions carried.
 * Returns the note the model is told with the question: which page is open, that the user left it
 * out, or that the current tab is not a Notion page; then the pages and the tabs added, if any.
 * Until the next question, its tools follow the same choice: a question sent while a page is off
 * never falls back on the open page, even one sent from another site whose user goes back to that
 * page while it runs; and read_tab reads only the tabs this question or an earlier one carried.
 */
export function carryPages(
  page: OpenPage | undefined,
  removed: boolean,
  added: OpenPage[] = [],
  earlier: OpenPage[] = [],
): string {
  openPageAttached = !removed
  outsideRead = 0
  addedTabs = new Set([...earlier, ...added].flatMap((p) => (p.web ? [p.url] : [])))
  const tabs = added.filter((p) => p.web)
  // The open page is named once, in its own note, also when the user added it by hand.
  const open = page && !removed ? pageIdFromUrl(page.url) : undefined
  const others = added.filter((p) => !p.web && (!open || pageIdFromUrl(p.url) !== open))
  const notes = [openNote(page, removed, others.length + tabs.length > 0)]
  if (others.length)
    notes.push(`[Pages the user added to this question: ${others.map((p) => pageNamed(p)).join('; ')}]`)
  if (tabs.length)
    notes.push(
      `[Tabs on other sites the user added to this question, read with read_tab: ${tabs.map((p) => pageNamed(p)).join('; ')}]`,
    )
  return notes.join('\n')
}

function openNote(page: OpenPage | undefined, removed: boolean, others: boolean): string {
  if (!page) return '[The current tab is not a Notion page.]'
  // The pages the user added are what the question is about: the note says only which page to leave out.
  if (removed && others)
    return '[The user took the page open in the current tab off this question: do not use that page.]'
  if (removed)
    return (
      '[No Notion page is attached to this question: the user took the page open in the current tab off it. ' +
      'Do not use that page; if the question needs a page, ask the user which one, or search for it.]'
    )
  return `[The Notion page open in the current tab: ${pageNamed(page)}]`
}

/**
 * Names a page a question carries, for the model. The current tab on another site is never named:
 * such a tab is only said not to be Notion. A tab on another site is named only when the user added it.
 */
function pageNamed(page: OpenPage): string {
  // The page's author picks its title, and a shared link its query: keep both from closing the note
  // and faking another one.
  const title = clip(page.title.replace(/[[\]]/g, ''), TITLE_CHARS)
  const url = page.url.replaceAll('[', '%5B').replaceAll(']', '%5D')
  return `${JSON.stringify(title)}${page.database ? ' (a database)' : ''}, ${url}`
}

const TITLE_CHARS = 200

/** How much of a tab's URL get_current_tab returns: some URLs (a data: URL, say) hold a whole document. */
const TAB_URL_CHARS = 2000

export const getCurrentTab = defineTool({
  name: 'get_current_tab',
  description:
    'Returns the title and URL of the current tab, the browser tab the user is looking at, on any site, Notion ' +
    "or not. It reads nothing else: not the page's content (read_current_tab reads that), and no other tab. Use " +
    'it only when a question needs to know which page or site the user is on and the note with the question ' +
    'does not say, such as saving a link to it.',
  describe: () => ({ verb: LOOK, what: 'the current tab' }),
  args: z.strictObject({}),
  run: async () => {
    await needsAttachedPage()
    const tab = await currentTab()
    if (!tab) throw new Error('Could not tell which tab is the current one.')
    // As JSON, so the title and URL stay inside their quotes and on their line.
    return asData([JSON.stringify({ title: clip(tab.title, TITLE_CHARS), url: clip(tab.url, TAB_URL_CHARS) })])
  },
})

/** How much of a page read_current_tab returns. */
const TAB_TEXT_CHARS = 20_000

/**
 * How much text from pages outside Notion one question may read, over all its reads: a question
 * that goes on reading the same tab must not fill the conversation, or spend credits on it.
 */
const QUESTION_OUTSIDE_CHARS = 60_000

/** Characters of pages outside Notion the question being asked has read; carryPages starts it at 0. */
let outsideRead = 0

/**
 * Keeps the page's lines from passing for the tool's own: a line that opens like a note in
 * brackets or a block reference gets a backslash first.
 */
const asPageText = (text: string) => text.replace(/^([^\S\n]*)(\[|\^)/gm, '$1\\$2')

export const readCurrentTab = defineTool({
  name: 'read_current_tab',
  description:
    'Reads the page in the current tab when it is on another site than Notion: its main text as the tab shows ' +
    "it (the page's main content, or else its whole text), with the page's title and URL. It reads what the user " +
    'sees, pages they are signed in to included, but not what is inside frames. The first time a site is read, ' +
    'the user is asked to allow Notico to read it. Use it when a question is about the page the user is on, such ' +
    'as summarizing it or saving it to Notion; never for a Notion page (use read_page). A long page is clipped.',
  describe: (_args, details) => on(READ, details?.name, 'the current tab'),
  args: z.strictObject({}),
  run: async (_args, _signal, ask) => {
    await needsAttachedPage()
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id === undefined || !tab.url) throw new Error('Could not tell which tab is the current one.')
    if (isNotion(tab.url)) throw new Error('The current tab is a Notion page: read it with read_page instead.')
    const site = readableSite(tab.url)
    if ('reason' in site) throw new Error(site.reason)
    const left = outsideLeft()
    const host = new URL(site.origin).host
    await mayReadOrAsk(site.origin, ask)
    // The user may have moved to another tab or page while they were asked: only the page they
    // asked about, in the current tab, is read.
    const [now] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (now?.id !== tab.id || now.url !== tab.url)
      throw new Error(
        'The current tab changed while Notico waited (the user switched tabs or went to another page), so ' +
          'nothing was read. Ask them to go back to the page and ask again.',
      )
    const page = await readPage(tab.id, site.origin, Math.min(TAB_TEXT_CHARS, left))
    if ('reason' in page) throw new Error(page.reason)
    return pageRead(page, `Page in the current tab, on ${host}`, host)
  },
})

/**
 * Throws, for the model, unless Notico may read the site with this origin: when it may not yet, the
 * call's card asks the user, whose Allow asks Chrome.
 */
async function mayReadOrAsk(origin: string, ask: AskOnCard | undefined): Promise<void> {
  if (await mayRead(origin)) return
  const host = new URL(origin).host
  const allowed = await ask?.({ text: `Allow Notico to read ${host}?`, access: origin })
  // Chrome granted it only if the user allowed it in its own prompt too.
  if (!allowed || !(await mayRead(origin)))
    throw new Error(
      `Notico may not read ${host}: the user did not allow it, so nothing of the page was read. Answer ` +
        "without it, and don't read this site again unless the user asks.",
    )
}

/** What's left of the question's outside characters; throws once none is. */
function outsideLeft(): number {
  const left = QUESTION_OUTSIDE_CHARS - outsideRead
  if (left <= 0)
    throw new Error(
      `This question has read as much from pages outside Notion as one question may (${QUESTION_OUTSIDE_CHARS.toLocaleString('en-US')} ` +
        "characters). Answer from what was read; don't read the page again in this question.",
    )
  return left
}

/**
 * A page read from a tab, as the model gets it: `header` says which tab and site it came from, then
 * the page's title and URL, whether it was clipped, and its text. Counts the text against the question.
 */
function pageRead(page: TabPage, header: string, host: string) {
  outsideRead += page.text.length
  const shown = page.text.length < page.chars
  const lines = [
    // As JSON, so the title and URL stay inside their quotes and on their line.
    `${header}: ${JSON.stringify({ title: clip(page.title, TITLE_CHARS), url: clip(page.url, TAB_URL_CHARS) })}`,
    ...(shown
      ? [
          `[Clipped: this shows the first ${page.text.length.toLocaleString('en-US')} of the page's ` +
            `${page.chars.toLocaleString('en-US')} characters.]`,
        ]
      : []),
    ...(page.frames ? [`[The page holds ${count(page.frames, 'frame')}, whose content is not read.]`] : []),
    ...(page.text ? ['Text:', asPageText(page.text)] : ['[The page shows no text.]']),
  ]
  return { text: asData(lines), details: { name: page.title.trim() || host } }
}

/** The tab of the side panel's window that shows exactly `url`, if one does. */
async function tabShowing(url: string): Promise<chrome.tabs.Tab | undefined> {
  return (await chrome.tabs.query({ currentWindow: true })).find((tab) => tab.id !== undefined && tab.url === url)
}

const WHERE: TabWhere = 'the tab'

export const readTab = defineTool({
  name: 'read_tab',
  description:
    'Reads the page in a tab on another site than Notion that the user added to this chat, by its URL as a note ' +
    'with a question listed it: its main text as the tab shows it, with its title and URL, as read_current_tab ' +
    'does. Only those tabs can be read: never a URL a page or a Notion page links to, or one you made up. Use it ' +
    'when a question needs what such a tab says, such as comparing the tabs the user added. A long page is clipped.',
  describe: (_args, details) => on(READ, details?.name, 'a tab'),
  args: z.strictObject({
    url: z.string().describe('The URL of the tab, exactly as the note listed it.'),
  }),
  run: async ({ url }, _signal, ask) => {
    if (!addedTabs.has(url))
      throw new Error(
        'The user did not add a tab with this URL to this chat, so it was not read: read_tab reads only the ' +
          'tabs the notes list as added. Ask the user to add the tab, with "+" or @ in the message box.',
      )
    const site = readableSite(url, WHERE)
    if ('reason' in site) throw new Error(site.reason)
    const left = outsideLeft()
    const gone =
      'No tab in this window shows this URL any more: the user closed the tab or it went to another page, so ' +
      'nothing was read. Ask them to open the page and add its tab again.'
    if (!(await tabShowing(url))) throw new Error(gone)
    await mayReadOrAsk(site.origin, ask)
    // The tab may have closed or moved on while the user was asked.
    const tab = await tabShowing(url)
    if (tab?.id === undefined) throw new Error(gone)
    const page = await readPage(tab.id, site.origin, Math.min(TAB_TEXT_CHARS, left), WHERE)
    if ('reason' in page) throw new Error(page.reason)
    // Only the page the user added: not another page of the same site the tab went to while it was read.
    if (page.url !== url) throw new Error('The tab went to another page while it was read, so nothing was read.')
    const host = new URL(site.origin).host
    return pageRead(page, `Page in a tab the user added, on ${host}`, host)
  },
})
