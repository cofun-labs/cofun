// The Notion pages open in the browser's tabs, as Chrome reports them: no Notion request. What the
// product's site (products/notico/product.ts) says is open, and what the Notion tools check before they fall back
// on the page open in the current tab.
import { NOTION_HOSTS, isNotion, pageIdFromUrl, showsDatabase } from '../notion/hosts'
import { currentTab, type OpenPage } from './carry'
import type { ToolMemory } from './memory'

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
