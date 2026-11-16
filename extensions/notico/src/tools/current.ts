// The current tab, on any site: get_current_tab, and read_current_tab, which reads the page of a tab
// on another site than Notion; and read_tab, which reads the tabs on other sites the user added to
// the conversation (see carry.ts).
import type { AskOnCard, ToolContext } from '../agent'
import { clip } from '../notion/comments'
import { isNotion } from '../notion/hosts'
import { defineTool } from '../tool'
import { mayRead, readPage, readableSite, type TabPage, type TabWhere } from '../web/tab'
import { z } from '../zod'
import { addedTabNow, clippedUrl, currentTab, TAB_URL_CHARS, TITLE_CHARS } from './carry'
import { needsAttachedPage } from './notion-tabs'
import { KEPT_CHARS, withText } from './results'
import { LOOK, READ, asData, count, on } from './shared'

export const getCurrentTab = defineTool({
  name: 'get_current_tab',
  description:
    'Returns the title and URL of the current tab, the browser tab the user is looking at, on any site, Notion ' +
    "or not. It reads nothing else: not the page's content (read_current_tab reads that), and no other tab. Use " +
    'it only when a question needs to know which page or site the user is on and the note with the question ' +
    'does not say, such as saving a link to it.',
  describe: () => ({ verb: LOOK, what: 'the current tab' }),
  args: z.strictObject({}),
  run: async (_args, _signal, { memory }) => {
    await needsAttachedPage(memory)
    const tab = await currentTab()
    if (!tab) throw new Error('Could not tell which tab is the current one.')
    // As JSON, so the title and URL stay inside their quotes and on their line.
    return asData([JSON.stringify({ title: clip(tab.title, TITLE_CHARS), url: clip(tab.url, TAB_URL_CHARS) })])
  },
})

export const readCurrentTab = defineTool({
  name: 'read_current_tab',
  description:
    'Reads the page in the current tab when it is on another site than Notion: its main content as the tab ' +
    "shows it (the page's main element, or else its whole text), as Markdown that keeps its headings, lists, " +
    "links, and tables, with the page's title and URL. Images are given by their alt text only. It reads what the " +
    'user sees, pages they are signed in to included, but not what is inside frames, its navigation, or its ' +
    'footer. The first time a site is read, ' +
    'the user is asked to allow Notico to read it. Use it when a question is about the page the user is on, such ' +
    'as summarizing it or saving it to Notion; never for a Notion page (use read_page). A long page is kept ' +
    'on the device and given in parts: its first part comes with an id that read_result and search_result take.',
  describe: (_args, details) => on(READ, details?.name, 'the current tab'),
  args: z.strictObject({}),
  run: async (_args, _signal, context) => {
    await needsAttachedPage(context.memory)
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id === undefined || !tab.url) throw new Error('Could not tell which tab is the current one.')
    if (isNotion(tab.url)) throw new Error('The current tab is a Notion page: read it with read_page instead.')
    const site = readableSite(tab.url)
    if ('reason' in site) throw new Error(site.reason)
    const host = new URL(site.origin).host
    await mayReadOrAsk(site.origin, context.ask)
    // The user may have moved to another tab or page while they were asked: only the page they
    // asked about, in the current tab, is read.
    const [now] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (now?.id !== tab.id || now.url !== tab.url)
      throw new Error(
        'The current tab changed while Notico waited (the user switched tabs or went to another page), so ' +
          'nothing was read. Ask them to go back to the page and ask again.',
      )
    const page = await readPage(tab.id, site.origin, KEPT_CHARS)
    if ('reason' in page) throw new Error(page.reason)
    return pageRead(page, `Page in the current tab, on ${host}`, host, context, 'read_current_tab')
  },
})

/**
 * Throws, for the model, unless Notico may read the site with this origin: when it may not yet, the
 * call's card asks the user, whose Allow asks Chrome.
 */
async function mayReadOrAsk(origin: string, ask: AskOnCard): Promise<void> {
  if (await mayRead(origin)) return
  const host = new URL(origin).host
  const allowed = await ask({ text: `Allow Notico to read ${host}?`, access: origin })
  // Chrome granted it only if the user allowed it in its own prompt too.
  if (!allowed || !(await mayRead(origin)))
    throw new Error(
      `Notico may not read ${host}: the user did not allow it, so nothing of the page was read. Answer ` +
        "without it, and don't read this site again unless the user asks.",
    )
}

/**
 * A page read from a tab, as the model gets it: `header` says which tab and site it came from, then
 * the page's title and URL, `notes` about it, and its content as Markdown; a long page's first part,
 * with the rest kept on the device (see withText).
 */
async function pageRead(
  page: TabPage,
  header: string,
  host: string,
  context: ToolContext,
  tool: string,
  notes: string[] = [],
) {
  const lines = [
    // As JSON, so the title and URL stay inside their quotes and on their line.
    `${header}: ${JSON.stringify({ title: clip(page.title, TITLE_CHARS), url: clip(page.url, TAB_URL_CHARS) })}`,
    ...notes,
    ...(page.frames ? [`[The page holds ${count(page.frames, 'frame')}, whose content is not read.]`] : []),
  ]
  const name = page.title.trim() || host
  if (!page.text) return { text: asData([...lines, '[The page shows no text.]']), details: { name } }
  const { title, url, text, chars, longer } = page
  return withText(lines, { tool, title, url, markdown: true, text, chars, longer }, name, context)
}

const WHERE: TabWhere = 'the tab'

export const readTab = defineTool({
  name: 'read_tab',
  description:
    'Reads the page in a tab on another site than Notion that the user added to this chat, by the tab number a ' +
    'note with a question gave it ("(tab 123)"): the main content the tab shows now, as Markdown, with its title ' +
    'and URL, as read_current_tab does. The tab may have gone to another page since it was added: the result ' +
    'then says so. Only those tabs can be read, never another tab. Use it when a question needs ' +
    'what such a tab says, such as comparing the tabs the user added. A long page is kept on the device and ' +
    'given in parts, as read_current_tab does.',
  describe: (_args, details) => on(READ, details?.name, 'a tab'),
  args: z.strictObject({
    tab: z.number().int().describe('The number of the tab, as the note gave it.'),
  }),
  run: async ({ tab }, _signal, context) => {
    const added = context.memory.carried.tabs.get(tab)
    if (!added)
      throw new Error(
        `The user did not add tab ${tab} to this chat, so it was not read: read_tab reads only the tabs the ` +
          'notes list as added. Ask the user to add the tab, with "+" or @ in the message box.',
      )
    const gone =
      'The tab the user added is not open any more (it was closed, or the browser restarted since), so nothing ' +
      'was read. Ask them to open the page and add its tab again.'
    // Added in an earlier run of the browser, the id may be another tab's now.
    const now = await addedTabNow(added)
    if (!now?.url) throw new Error(gone)
    if (isNotion(now.url)) throw new Error('The tab now shows a Notion page: read it with read_page instead.')
    const site = readableSite(now.url, WHERE)
    if ('reason' in site) throw new Error(site.reason)
    await mayReadOrAsk(site.origin, context.ask)
    const page = await readPage(tab, site.origin, KEPT_CHARS, WHERE)
    if ('reason' in page) throw new Error(page.reason)
    const host = new URL(site.origin).host
    // The model reads the tab, not the address: it is told when the tab went to another page.
    const moved =
      page.url === added.url
        ? []
        : [
            `[The tab went to another page since the user added it, when it showed ${JSON.stringify(clippedUrl(added.url))}.]`,
          ]
    return pageRead(page, `Page in tab ${tab}, which the user added, on ${host}`, host, context, 'read_tab', moved)
  },
})
