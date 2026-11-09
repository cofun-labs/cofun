// Tools the agent can run in the extension.
// The worker's tests import this file too, and their tsconfig has no chrome types.
/// <reference types="chrome" />
import type { ToolSpec } from './agent'
import { IN_TRASH, NotionError, mergeRecordMaps, type LoadedPage, type NotionRecord } from './notion/api'
import { isNotion, pageIdFromUrl, toUuid } from './notion/hosts'
import { PAGE_TYPES, hexId, pageToMarkdown, splitIntoParts } from './notion/markdown'
import { activeNotionTab, type NotionTab } from './notion/tab'

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

export const SEARCH_DEFAULT = 10
export const SEARCH_MAX = 20

export const searchPages: ToolSpec = {
  name: 'search_pages',
  description:
    "Searches the Notion workspace of the open page for pages by title and content, as Notion's search does. " +
    'Returns each page with its id, where it is, when it was last edited, and the matching text. Read a page it ' +
    'finds with read_page and its id.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to search for.' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: SEARCH_MAX,
        description: `How many pages to return, up to ${SEARCH_MAX}. Defaults to ${SEARCH_DEFAULT}.`,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  run: async (args) => {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) throw new Error('`query` must be some words to search for.')
    const limit =
      args.limit === undefined || args.limit === null || args.limit === '' ? SEARCH_DEFAULT : Number(args.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX) {
      throw new Error(`\`limit\` must be a whole number from 1 to ${SEARCH_MAX}.`)
    }
    const tab = await activeNotionTab()
    if (!tab.pageId) throw new Error('Open a page of the workspace to search it.')
    // The workspace to search is the open page's; it is looked up once per page.
    const spaceId = await workspaceOf(tab)

    const found = await tab.client.search(spaceId, query, limit)
    if (!found.results.length) return `No pages found for "${query}".`
    const origin = new URL(tab.url).origin
    const tag = highlightTag(found.results)
    const plain = (text: unknown) => withoutTag(typeof text === 'string' ? text : undefined, tag)
    // A database's name is on its collection, which search doesn't return.
    const names = await databaseNames(
      tab,
      found.results.map((r) => found.recordMap.block?.[r.id]),
      spaceId,
    )
    const lines = found.results.map((r, n) => {
      const block = found.recordMap.block?.[r.id] as
        | { type?: string; properties?: { title?: unknown }; last_edited_time?: number }
        | undefined
      const database = block?.type === 'collection_view_page' || block?.type === 'collection_view'
      const title =
        plain(r.highlight?.title) ||
        (database ? names.get(r.id) : runsText(block?.properties?.title)) ||
        (database ? 'Untitled database' : 'Untitled')
      // The path may end with the page itself (a top-level page's is only its own title).
      const path = plain(r.highlight?.pathText)
      const where = path === title ? '' : path.endsWith(` / ${title}`) ? path.slice(0, -title.length - 3) : path
      const text = plain(r.highlight?.text)
      const edited =
        typeof block?.last_edited_time === 'number' ? new Date(block.last_edited_time).toISOString().slice(0, 10) : ''
      return [
        `${n + 1}. ${database ? '🗃' : '📄'} ${title} ^${hexId(r.id)}`,
        ...(where ? [`   In: ${where}`] : []),
        ...(edited ? [`   Edited: ${edited}`] : []),
        ...(text ? [`   Match: “${clip(text, 200)}”`] : []),
        `   URL: ${origin}/${hexId(r.id)}`,
      ].join('\n')
    })
    const shown = found.results.length
    const more = found.total > shown ? ` (${found.total} in all; showing ${shown})` : ''
    return [`Pages found for "${query}"${more}:`, '', ...lines].join('\n')
  },
}

/**
 * The tag a search response marks matched words with: a random name per response, such as
 * `<gzkNfoUU>word</gzkNfoUU>`. Only that tag is removed, so other `<…>` text stays as written.
 */
function highlightTag(results: { highlight?: Record<string, unknown> }[]): string | undefined {
  // The name used most often across every highlight, preferring Notion's random 8-character
  // shape, so literal markup in page text (say `<b>bold</b>`) isn't taken for it.
  const counts = new Map<string, number>()
  for (const r of results) {
    for (const text of Object.values(r.highlight ?? {})) {
      if (typeof text !== 'string') continue
      for (const m of text.matchAll(/<([A-Za-z][A-Za-z0-9]*)>[^<]*<\/\1>/g))
        counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
    }
  }
  const random = (name: string) => Number(/^[A-Za-z0-9]{8}$/.test(name))
  const ranked = [...counts].sort(([a, n], [b, m]) => random(b) - random(a) || m - n)
  return ranked[0]?.[0]
}

/** Workspace ids of pages, so searching from the same page doesn't look it up again. */
const pageWorkspaces = new Map<string, string>()

async function workspaceOf(tab: NotionTab): Promise<string> {
  const pageId = tab.pageId!
  const known = pageWorkspaces.get(pageId)
  if (known) return known
  let spaceId: string | undefined
  try {
    const opened = await tab.client.getRecords([{ table: 'block', id: pageId }])
    spaceId = (opened.block?.[pageId] as { space_id?: string } | undefined)?.space_id
  } catch (err) {
    if (err instanceof NotionError && err.message === IN_TRASH) {
      throw new Error('The open page is in the trash. Open another page of the workspace to search it.')
    }
    throw err
  }
  if (!spaceId) throw new Error('Could not tell which workspace the open page is in.')
  pageWorkspaces.set(pageId, spaceId)
  return spaceId
}

/** Names of the databases among `blocks`, by block id; databases that can't be looked up are left out. */
async function databaseNames(
  tab: NotionTab,
  blocks: (NotionRecord | undefined)[],
  spaceId: string,
): Promise<Map<string, string>> {
  const databases = blocks.filter(
    (b): b is NotionRecord => !!b && (b.type === 'collection_view_page' || b.type === 'collection_view'),
  )
  const collectionOf = (b: NotionRecord) =>
    (b.collection_id as string | undefined) ??
    (b.format as { collection_pointer?: { id?: string } } | undefined)?.collection_pointer?.id
  const ids = [...new Set(databases.map(collectionOf).filter((id): id is string => !!id))]
  const names = new Map<string, string>()
  if (!ids.length) return names
  try {
    const records = await tab.client.getRecords(ids.map((id) => ({ table: 'collection' as const, id, spaceId })))
    for (const b of databases) {
      const name = runsText(records.collection?.[collectionOf(b) ?? '']?.name)
      if (name) names.set(b.id, name)
    }
  } catch {
    // Without them, databases are listed by the title Notion highlighted, or as untitled.
  }
  return names
}

function withoutTag(text: string | undefined, tag: string | undefined): string {
  const out = tag ? (text ?? '').split(`<${tag}>`).join('').split(`</${tag}>`).join('') : (text ?? '')
  return out.replace(/\s+/g, ' ').trim()
}

function runsText(value: unknown): string {
  return Array.isArray(value) ? value.map((r) => (Array.isArray(r) ? String(r[0]) : '')).join('') : ''
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export const TOOLS: ToolSpec[] = [getCurrentPage, readPage, searchPages]
