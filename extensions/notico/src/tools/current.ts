// The current tab and the Notion page open in it: what a question carries, and @cofun/tools's tab
// tools (get_current_tab, read_current_tab and read_tab, which read the page of a tab on another
// site), bound to this extension's memory and told that Notion's pages are read with read_page.
import {
  addedTabsNote,
  clip,
  currentTabReadable as tabReadable,
  noteTitle,
  noteUrl,
  openWebTabs as webTabs,
  selectionNotes,
  tabTools,
  type OwnSite,
  type WebTab,
} from '@cofun/tools'
import type { QuestionPage } from '@cofun/agent'
import { z } from '../zod'
import { NOTION_HOSTS, isNotion, pageIdFromUrl, showsDatabase } from '../notion/hosts'
import type { Selection } from '../selection'
import type { ToolMemory } from './memory'

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
 * Notion, the site Notico's own tools read: the tab tools and read_web_page leave its pages to
 * read_page, and Notion's tabs are not offered as tabs on other sites.
 */
export const notionSite: OwnSite = (url, where) => {
  if (!isNotion(url)) return undefined
  if (where === 'the address') return 'This is a Notion page: read it with read_page instead.'
  if (where === 'the tab') return 'The tab now shows a Notion page: read it with read_page instead.'
  return 'The current tab is a Notion page: read it with read_page instead.'
}

export const { getCurrentTab, readCurrentTab, readTab } = tabTools<ToolMemory>({
  product: 'Notico',
  addedTabs: (memory) => memory.carried.tabs,
  ownSite: notionSite,
  beforeCurrentTab: needsAttachedPage,
})

/**
 * Whether the current tab is on another site than Notion that read_current_tab could read (once the
 * user allows the site): what the start of a chat offers there. Only the answer leaves here, never
 * the tab's address or title.
 */
export const currentTabReadable = (): Promise<boolean> => tabReadable(notionSite)

/** The tabs on other sites than Notion that the user can add to a question (see openWebTabs in @cofun/tools). */
export const openWebTabs = (): Promise<WebTab[]> => webTabs(notionSite)

/**
 * A page a question carries: its title and URL, as the tab or Notion's search showed them, and
 * whether it is a database; or, with `web`, a page on another site, in the tab the user added
 * (`tab`, Chrome's id for it), as that tab showed it then.
 */
export interface OpenPage {
  title: string
  url: string
  database?: true
  web?: true
  tab?: number
  /** The run of the browser the tab was added in (see addedTabNow in @cofun/tools). */
  run?: string
}

/** The flag of a page that is a database, as a question's pages keep it (see OpenPage). */
const DatabaseFlag = z.object({ database: z.literal(true) })

/**
 * Whether a page a question carries is a database. The agent keeps the flag with a question's pages
 * without reading it, so a page read back from a saved session is checked here.
 */
export const isDatabase = (page: QuestionPage): boolean => DatabaseFlag.safeParse(page).success

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

const LEFT_OUT =
  'No page is attached to this question: the user took the page open in the current tab off it, so that page ' +
  "can't be used. Ask the user which page they mean, or search for it, and give it to this tool."

/**
 * Refuses a call that names no page while the question carries none and the current tab shows a
 * Notion page: once the user took the page open in the current tab off the question (see
 * Carried.openPage, which `memory` holds), a page the user left out is never read in its place. On
 * another site there is no page to leave out: Notion tools fail there as everywhere off Notion, and
 * get_current_tab gives that site's tab.
 */
export async function needsAttachedPage(memory: ToolMemory): Promise<void> {
  if (!memory.carried.openPage && (await currentNotionPage())) throw new Error(LEFT_OUT)
}

/**
 * Sets up the next question of the chat whose agent has `memory` from what its composer showed:
 * `page`, the Notion page open in the current tab (if one is), whether the user took a page off the
 * question, and the pages and tabs they added to it by hand; `earlier`, the pages the conversation's
 * earlier questions carried.
 * Returns the note the model is told with the question: which page is open, that the user left it
 * out, or that the current tab is not a Notion page; then the pages and the tabs added, if any.
 * Until the next question, its tools follow the same choice: a question sent while a page is off
 * never falls back on the open page, even one sent from another site whose user goes back to that
 * page while it runs; and read_tab reads only the tabs this question or an earlier one carried.
 */
export function carryPages(
  memory: ToolMemory,
  page: OpenPage | undefined,
  removed: boolean,
  added: OpenPage[] = [],
  selections: Selection[] = [],
  earlier: OpenPage[] = [],
): string {
  // With the current tab, the tabs added are the only ones read_tab may read, whatever page they show now.
  memory.carried = {
    openPage: !removed,
    tabs: new Map([...earlier, ...added].flatMap((p) => (p.web && p.tab !== undefined ? [[p.tab, p]] : []))),
  }
  const tabs = added.filter((p) => p.web)
  // The open page is named once, in its own note, also when the user added it by hand.
  const open = page && !removed ? pageIdFromUrl(page.url) : undefined
  const others = added.filter((p) => !p.web && (!open || pageIdFromUrl(p.url) !== open))
  const notes = [openNote(page, removed, others.length + tabs.length > 0)]
  if (others.length)
    notes.push(`[Pages the user added to this question: ${others.map((p) => pageNamed(p)).join('; ')}]`)
  const tabsNote = addedTabsNote(tabs)
  if (tabsNote) notes.push(tabsNote)
  notes.push(...selectionNotes(selections))
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
 * Names a Notion page a question carries, for the model. The current tab on another site is never
 * named: such a tab is only said not to be Notion. A tab on another site is named only when the user
 * added it (see addedTabsNote in @cofun/tools).
 */
function pageNamed(page: OpenPage): string {
  // The page's author picks its title, and a shared link its query: keep both from closing the note
  // and faking another one.
  const title = clip(noteTitle(page.title), TITLE_CHARS)
  const url = clippedUrl(page.url)
  const kind = page.database ? ' (a database)' : ''
  return `${JSON.stringify(title)}${kind}, ${url}`
}

/**
 * A URL as a note names it: a shared link's query must not close the note and fake another one,
 * and an address that keeps a page's state (a playground's, say) may run to many thousand
 * characters, which every question would carry.
 */
const clippedUrl = (url: string) => noteUrl(url).slice(0, URL_CHARS)

const TITLE_CHARS = 200

/** How much of a page's URL a note names: some URLs (a data: URL, say) hold a whole document. */
const URL_CHARS = 2000
