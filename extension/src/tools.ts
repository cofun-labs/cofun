// Tools the agent can run in the extension.
// The worker's tests import this file too, and their tsconfig has no chrome types.
/// <reference types="chrome" />
import type { ToolSpec } from './agent'
import { NotionError, mergeRecordMaps, type LoadedPage } from './notion/api'
import { isNotion, pageIdFromUrl, toUuid } from './notion/hosts'
import { PAGE_TYPES, hexId, pageToMarkdown, splitIntoParts } from './notion/markdown'
import { activeNotionTab, type NotionTab } from './notion/tab'
import { pageChildren, pageTree, treeLines } from './notion/tree'

/**
 * The title and URL of the Notion page open in the side panel's window, if one is.
 * Other sites are never reported, so their URLs and titles don't reach the model.
 */
export async function currentNotionPage(): Promise<{ title: string; url: string } | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || !isNotion(tab.url)) return undefined
  // Drop a trailing " | Notion" if the tab title has one; the model does not need it.
  const title = (tab.title ?? '').replace(/\s+\|\s+Notion$/, '')
  return { title, url: tab.url! }
}

export const getCurrentPage: ToolSpec = {
  name: 'get_current_page',
  description: 'Returns the title and URL of the Notion page open in the current browser tab.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  run: async () => {
    const page = await currentNotionPage()
    if (!page) throw new Error('No Notion page is open in this window.')
    return page
  },
}

/** How much of a page one read returns, so a long page doesn't fill the conversation. */
export const PART_CHARS = 12_000

export const readPage: ToolSpec = {
  name: 'read_page',
  description:
    'Reads a Notion page as Markdown: the page open in the current tab, or another page by URL or id. ' +
    'Each block ends with a reference such as ^1a2b3c4d. Child pages, databases, and links to pages end with ' +
    'the page id, which this tool accepts. A long page comes in parts; ask for the next one with `part`.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'string', description: 'URL or id of the page to read. Leave out to read the open page.' },
      part: { type: 'integer', minimum: 1, description: 'Which part of a long page to read, starting at 1.' },
    },
    additionalProperties: false,
  },
  run: async (args) => {
    // Models often fill optional arguments with null or an empty string; those mean "not given".
    const pageText = typeof args.page === 'string' && args.page.trim() ? args.page : undefined
    const tab = await activeNotionTab()
    const id = pageText === undefined ? tab.pageId : pageArg(pageText)
    if (!id) {
      throw new Error(
        pageText === undefined
          ? 'The Notion tab does not show a page. Open a page, or give its URL or id.'
          : `Not a Notion page URL or id: ${pageText}`,
      )
    }
    const part = args.part === undefined || args.part === null || args.part === '' ? 1 : Number(args.part)
    if (!Number.isInteger(part) || part < 1) throw new Error('`part` must be a whole number from 1.')

    const { loaded, databaseMissing, reloaded } = await loadForPart(tab, id, part)
    if (!PAGE_TYPES.has(loaded.page.type)) {
      throw new Error('That id is a block inside a page, not a page. Read the page it is on instead.')
    }
    const md = pageToMarkdown(loaded)
    const parts = splitIntoParts(md.sections, PART_CHARS)
    if (part > parts.length) {
      throw new Error(`This page has ${parts.length} part${parts.length === 1 ? '' : 's'}; there is no part ${part}.`)
    }

    const pageHex = hexId(loaded.page.id)
    const header = [
      `Page: ${md.title} ^${pageHex}`,
      `URL: ${new URL(tab.url).origin}/${pageHex}`,
      ...(parts.length > 1
        ? [`Part ${part} of ${parts.length}${part < parts.length ? `. Read part ${part + 1} for more.` : '.'}`]
        : []),
      ...(md.kind === 'database' ? ['This page is a database. Reading its rows is not supported yet.'] : []),
      ...(loaded.complete ? [] : ['The page is too long to load in full; only its beginning is shown.']),
      ...(reloaded
        ? ['This part comes from a new read of the page; parts you have from an earlier read may not match it.']
        : []),
      ...(databaseMissing
        ? ["This is a database row, but its database can't be opened, so its properties are not shown."]
        : []),
    ]
    const properties = part === 1 && md.properties.length ? ['---', ...md.properties, '---'] : []
    const body = parts[part - 1] || (md.kind === 'page' ? '(This page is empty.)' : '')
    return [...header, '', ...properties, ...(body ? [body] : [])].join('\n')
  },
}

/**
 * A page id from what the model gave: a Notion URL (with or without `https://`), an id, a page
 * slug ending in its id (`Title-<id>`), or a reference to a page (`^<id>`).
 */
function pageArg(text: string): string | undefined {
  let value = text.trim().replace(/^\^/, '')
  if (/^((www\.)?notion\.so|app\.notion\.com)\//i.test(value)) value = `https://${value}`
  // notion.so redirects to www.notion.so, the host Notion's pages live on.
  value = value.replace(/^https:\/\/notion\.so\//i, 'https://www.notion.so/')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return isNotion(value) ? pageIdFromUrl(value) : undefined
  if (value.includes('/')) return undefined
  return toUuid(value) ?? toUuid(/[0-9a-f]{32}$/i.exec(value.replace(/-/g, ''))?.[0] ?? '')
}

interface Loaded {
  loaded: LoadedPage
  databaseMissing: boolean
  /** A later part was read from a fresh load, not from the read of part 1. */
  reloaded?: boolean
}

/** How long the parts after the first come from the page as it was when part 1 was read. */
const PARTS_REUSE_MS = 5 * 60_000
/** Pages whose part 1 was read last, so reading two long pages in turn keeps both. */
const PARTS_PAGES = 5
const recentReads = new Map<string, { at: number; result: Loaded }>()

/**
 * Part 1 always reads the page fresh. Later parts reuse that read for a while, so reading a long
 * page part by part loads it once, and the parts fit together even if the page changes meanwhile.
 */
async function loadForPart(tab: NotionTab, id: string, part: number): Promise<Loaded> {
  const key = `${tab.tabId}:${id}`
  const recent = recentReads.get(key)
  if (part > 1 && recent && Date.now() - recent.at < PARTS_REUSE_MS) {
    // The account in the tab may have changed since: check it can still open the page.
    await tab.client.getRecords([{ table: 'block', id, spaceId: recent.result.loaded.spaceId }])
    return recent.result
  }
  const result = await loadWithDatabase(tab, id)
  recentReads.delete(key)
  recentReads.set(key, { at: Date.now(), result })
  if (recentReads.size > PARTS_PAGES) recentReads.delete(recentReads.keys().next().value!)
  // A later part read fresh may not fit with earlier parts the model got from another read.
  return part > 1 ? { ...result, reloaded: true } : result
}

/** Loads a page, and for a database row also its database, which names the row's properties. */
async function loadWithDatabase(tab: NotionTab, id: string): Promise<Loaded> {
  const loaded = await tab.client.loadPage(id)
  const { page, spaceId, recordMap } = loaded
  if (page.parent_table !== 'collection' || !page.parent_id || recordMap.collection?.[page.parent_id]) {
    return { loaded, databaseMissing: false }
  }
  try {
    mergeRecordMaps(recordMap, await tab.client.getRecords([{ table: 'collection', id: page.parent_id, spaceId }]))
    return { loaded, databaseMissing: false }
  } catch (err) {
    // A row can be shared with someone who can't open its database; the row itself still reads.
    if (err instanceof NotionError && err.code === 'no_access') return { loaded, databaseMissing: true }
    throw err
  }
}

export const LIST_MAX_DEPTH = 3
/** How many pages one list shows, so a large workspace still fits the conversation. */
export const LIST_LIMIT = 100

export const listPages: ToolSpec = {
  name: 'list_pages',
  description:
    "Lists pages and databases as Notion's sidebar shows them: without `page`, the top level of the open page's " +
    'workspace (private pages, pages shared with the user, workspace pages, teamspaces); with `page`, the pages ' +
    'and databases under it. Titles and ids only, no content: read a page with read_page. `depth` also lists the ' +
    'pages under those, up to 3 levels.',
  parameters: {
    type: 'object',
    properties: {
      page: {
        type: 'string',
        description: 'URL or id of a page to list the pages under. Leave out for the top level.',
      },
      depth: {
        type: 'integer',
        minimum: 1,
        maximum: LIST_MAX_DEPTH,
        description: 'How many levels to list. Defaults to 1.',
      },
    },
    additionalProperties: false,
  },
  run: async (args) => {
    const given = typeof args.page === 'string' && args.page.trim() ? args.page : undefined
    const rootId = given ? pageArg(given) : undefined
    if (given && !rootId) throw new Error(`Not a Notion page URL or id: ${given}`)
    const depth = args.depth === undefined || args.depth === null || args.depth === '' ? 1 : Number(args.depth)
    if (!Number.isInteger(depth) || depth < 1 || depth > LIST_MAX_DEPTH) {
      throw new Error(`\`depth\` must be a whole number from 1 to ${LIST_MAX_DEPTH}.`)
    }
    const tab = await activeNotionTab()
    const cutOff = (truncated: boolean) =>
      truncated ? [`Only the first ${LIST_LIMIT} pages are listed. List a page by its id to see more under it.`] : []

    if (rootId) {
      const records = await tab.client.getRecords([{ table: 'block', id: rootId }])
      const root = records.block![rootId]
      if (root.type !== 'page') {
        throw new Error(
          PAGE_TYPES.has(String(root.type))
            ? 'That is a database; its rows are not pages to list.'
            : 'That id is a block inside a page, not a page.',
        )
      }
      const children = (await pageChildren(tab.client, [rootId], records)).get(rootId) ?? []
      const { nodes, truncated } = await pageTree(tab.client, children, depth, LIST_LIMIT, records)
      const title = runsText((root.properties as { title?: unknown } | undefined)?.title) || 'Untitled'
      return [
        `Pages under “${title}” ^${hexId(rootId)}:`,
        '',
        ...(treeLines(nodes).length ? treeLines(nodes) : ['(no pages)']),
        ...cutOff(truncated),
      ].join('\n')
    }

    if (!tab.pageId) throw new Error('Open a page of the workspace to list it.')
    const opened = await tab.client.getRecords([{ table: 'block', id: tab.pageId }])
    const spaceId = (opened.block?.[tab.pageId] as { space_id?: string } | undefined)?.space_id
    if (!spaceId) throw new Error('Could not tell which workspace the open page is in.')
    const space = await tab.client.getSpace(spaceId)
    const sections: [string, string[]][] = [
      ['Private', space.privatePages],
      ['Shared with you', space.sharedPages],
      ['Workspace', space.workspacePages],
      ...space.teams.map((t): [string, string[]] => [`Teamspace: ${t.name}`, t.pages]),
    ]
    // One tree over every section, so the limit counts them all.
    const { nodes, truncated } = await pageTree(
      tab.client,
      sections.flatMap(([, ids]) => ids),
      depth,
      LIST_LIMIT,
    )
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const out = [`Pages in the workspace “${space.name}”:`]
    for (const [label, ids] of sections) {
      const shown = ids.map((id) => byId.get(id)).filter((n) => !!n)
      if (shown.length) out.push('', label, ...treeLines(shown))
    }
    if (out.length === 1) out.push('', '(no pages)')
    return [...out, ...cutOff(truncated)].join('\n')
  },
}

function runsText(value: unknown): string {
  return Array.isArray(value) ? value.map((r) => (Array.isArray(r) ? String(r[0]) : '')).join('') : ''
}

export const TOOLS: ToolSpec[] = [getCurrentPage, readPage, listPages]
