import { carryPages as carry, currentTab, needsAttachedPage as needs, type OpenPage } from '@cofun/app/tools/current'
import type { PageSite } from '@cofun/app/product'
import type { Selection } from '@cofun/app/selection'
import { NOTION_HOSTS, isNotion, pageIdFromUrl, showsDatabase } from '../notion/hosts'
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

export const notionPages: PageSite = {
  name: 'Notion',
  readTool: 'read_page',
  currentPage: currentNotionPage,
  isPage: isNotion,
  pageId: pageIdFromUrl,
}

export const needsAttachedPage = (memory: ToolMemory) => needs(memory, notionPages)

export function carryPages(
  memory: ToolMemory,
  page: OpenPage | undefined,
  removed: boolean,
  added?: OpenPage[],
  selections?: Selection[],
  earlier?: OpenPage[],
): string {
  return carry(memory, page, removed, added, selections, earlier, notionPages)
}

export type { OpenPage } from '@cofun/app/tools/current'
