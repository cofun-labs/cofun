// Tools the agent can run in the extension.
// The worker's tests import this file too, and their tsconfig has no chrome types.
/// <reference types="chrome" />
import type { ToolSpec } from './agent'
import { NotionError, mergeRecordMaps, type LoadedPage } from './notion/api'
import { isNotion, pageIdFromUrl, toUuid } from './notion/hosts'
import { PAGE_TYPES, hexId, pageToMarkdown, rowValues, splitIntoParts, type Schema } from './notion/markdown'
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

/** How many rows one query loads, and how many one result shows. */
export const QUERY_LOAD = 500
export const QUERY_PART = 50
const FILTER_OPS = ['is', 'is_not', 'contains', 'not_contains', 'is_empty', 'is_not_empty', 'before', 'after'] as const
type FilterOp = (typeof FILTER_OPS)[number]

export const queryDatabase: ToolSpec = {
  name: 'query_database',
  description:
    "Reads the rows of a Notion database as a table: its properties (name and type) and each row's values, " +
    "with the row's id (read a row with read_page). Give the database by id or URL, or leave it out when the " +
    'open page is a database. `filter` keeps rows whose shown values match every condition (text, ' +
    'case-insensitive; dates as YYYY-MM-DD; checkboxes as Yes/No); `sort` orders them. Long results come in ' +
    'parts; ask for the next with `part`.',
  parameters: {
    type: 'object',
    properties: {
      database: { type: 'string', description: 'Id or URL of the database. Leave out for the open page.' },
      filter: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            property: { type: 'string', description: 'Property name, as the result lists it.' },
            op: { type: 'string', enum: [...FILTER_OPS] },
            value: { type: 'string', description: 'What to compare with; not needed for is_empty and is_not_empty.' },
          },
          required: ['property', 'op'],
          additionalProperties: false,
        },
      },
      sort: {
        type: 'object',
        properties: {
          property: { type: 'string' },
          direction: { type: 'string', enum: ['ascending', 'descending'] },
        },
        required: ['property'],
        additionalProperties: false,
      },
      part: { type: 'integer', minimum: 1, description: 'Which part of a long result, starting at 1.' },
    },
    additionalProperties: false,
  },
  run: async (args) => {
    const given = typeof args.database === 'string' && args.database.trim() ? args.database : undefined
    const part = args.part === undefined || args.part === null || args.part === '' ? 1 : Number(args.part)
    if (!Number.isInteger(part) || part < 1) throw new Error('`part` must be a whole number from 1.')
    const tab = await activeNotionTab()
    const id = given ? pageArg(given) : tab.pageId
    if (given && !id) throw new Error(`Not a Notion database URL or id: ${given}`)
    if (!id) throw new Error('Give `database`: the open tab does not show a page.')

    const records = await tab.client.getRecords([{ table: 'block', id }])
    const block = records.block![id]
    if (block.type !== 'collection_view_page' && block.type !== 'collection_view') {
      throw new Error(given ? 'That is not a database.' : 'The open page is not a database. Give `database`.')
    }
    const collectionId =
      (block.collection_id as string | undefined) ??
      (block.format as { collection_pointer?: { id?: string } } | undefined)?.collection_pointer?.id
    const viewId = Array.isArray(block.view_ids) ? (block.view_ids[0] as string | undefined) : undefined
    if (!collectionId || !viewId) throw new Error("This database's rows can't be read: it has no data source or view.")
    const spaceId = String(block.space_id)
    const collection = (await tab.client.getRecords([{ table: 'collection', id: collectionId, spaceId }])).collection![
      collectionId
    ]
    const schema = (collection.schema ?? {}) as Schema
    const name = runsText(collection.name) || 'Untitled database'

    const filters = parseFilters(args.filter, schema)
    const sort = parseSort(args.sort, schema)
    const { rowIds, hasMore, recordMap } = await tab.client.queryCollection(collectionId, viewId, spaceId, QUERY_LOAD)
    let rows = rowIds
      .map((r) => recordMap.block?.[r])
      .filter((r): r is NonNullable<typeof r> => !!r && r.alive !== false)
      .map((r) => ({ id: r.id, values: rowValues(recordMap, r as never, schema) }))
    rows = rows.filter((r) => filters.every((f) => matches(r.values, f)))
    if (sort)
      rows.sort((a, b) => compareValues(cell(a.values, sort.property), cell(b.values, sort.property)) * sort.sign)

    const parts = Math.max(1, Math.ceil(rows.length / QUERY_PART))
    if (part > parts)
      throw new Error(`This result has ${parts} part${parts === 1 ? '' : 's'}; there is no part ${part}.`)
    const shown = rows.slice((part - 1) * QUERY_PART, part * QUERY_PART)
    const columns = rows[0]?.values.map((v) => v.name) ?? Object.values(schema).map((s) => s.name ?? '')
    const escape = (text: string) => text.split('|').join('\\|').replace(/\n/g, ' ')
    const from = (part - 1) * QUERY_PART + 1
    const header = [
      `Database: ${name} ^${hexId(id)}`,
      // The user's own date, not UTC's, so "overdue" means what they'd say.
      `Today: ${localDate(new Date())}`,
      `Properties: ${rowValuesHeader(schema)}`,
      `${filters.length ? 'Matching rows' : 'Rows'}: ${rows.length}` +
        (rows.length ? ` (showing ${from}–${from + shown.length - 1})` : '') +
        (part < parts ? `. Read part ${part + 1} for more.` : '.'),
      ...(hasMore ? [`Only the first ${QUERY_LOAD} rows of the database were read; filters apply to those.`] : []),
    ]
    if (!shown.length) return [...header, '', '(no rows)'].join('\n')
    const table = [
      `| ${[...columns, 'Row'].join(' | ')} |`,
      `|${[...columns, 'Row'].map(() => ' --- ').join('|')}|`,
      ...shown.map((r) => `| ${[...r.values.map((v) => escape(v.value)), `^${hexId(r.id)}`].join(' | ')} |`),
    ]
    return [...header, '', ...table].join('\n')
  },
}

interface Filter {
  property: string
  op: FilterOp
  value: string
}

function parseFilters(raw: unknown, schema: Schema): Filter[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('`filter` must be a list of conditions.')
  return raw.map((f, n) => {
    const { property, op, value } = (f ?? {}) as Record<string, unknown>
    const where = `Filter ${n + 1}`
    if (typeof property !== 'string' || !propertyNamed(schema, property)) {
      throw new Error(
        `${where}: no property named "${String(property)}". The properties are: ${rowValuesHeader(schema)}.`,
      )
    }
    if (!FILTER_OPS.includes(op as FilterOp))
      throw new Error(`${where}: \`op\` must be one of ${FILTER_OPS.join(', ')}.`)
    const needsValue = op !== 'is_empty' && op !== 'is_not_empty'
    if (needsValue && (typeof value !== 'string' || !value.trim())) throw new Error(`${where} needs \`value\`.`)
    return {
      property: propertyNamed(schema, property)!,
      op: op as FilterOp,
      value: needsValue ? String(value).trim() : '',
    }
  })
}

function parseSort(raw: unknown, schema: Schema): { property: string; sign: 1 | -1 } | undefined {
  if (raw === undefined || raw === null) return undefined
  const { property, direction } = (raw ?? {}) as Record<string, unknown>
  if (typeof property !== 'string' || !propertyNamed(schema, property)) {
    throw new Error(
      `\`sort\`: no property named "${String(property)}". The properties are: ${rowValuesHeader(schema)}.`,
    )
  }
  return { property: propertyNamed(schema, property)!, sign: direction === 'descending' ? -1 : 1 }
}

/** The schema's name for a property, matched case-insensitively. */
function propertyNamed(schema: Schema, name: string): string | undefined {
  const want = name.trim().toLowerCase()
  return Object.entries(schema).find(([key, s]) => (s.name ?? key).toLowerCase() === want)?.[1].name ?? undefined
}

function rowValuesHeader(schema: Schema): string {
  const entries = Object.entries(schema)
  const isTitle = ([key, s]: [string, { type?: string }]) => key === 'title' || s.type === 'title'
  return [...entries.filter(isTitle), ...entries.filter((e) => !isTitle(e))]
    .map(([key, s]) => `${s.name ?? key} (${s.type ?? 'text'})`)
    .join(', ')
}

/** A row's value for a property, as compared: plain text, a date without its leading @. */
function cell(values: { name: string; value: string }[], property: string): string {
  const raw = values.find((v) => v.name === property)?.value ?? ''
  return raw.replace(/^@(?=\d{4}-\d{2}-\d{2})/, '').trim()
}

function matches(values: { name: string; value: string }[], f: Filter): boolean {
  const v = cell(values, f.property).toLowerCase()
  const want = f.value.toLowerCase()
  switch (f.op) {
    case 'is':
      return v === want
    case 'is_not':
      return v !== want
    case 'contains':
      return v.includes(want)
    case 'not_contains':
      return !v.includes(want)
    case 'is_empty':
      return v === ''
    case 'is_not_empty':
      return v !== ''
    case 'before':
      return v !== '' && v < want
    case 'after':
      return v !== '' && v > want
  }
}

function compareValues(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  // Empty values go last.
  if (!a || !b) return a ? -1 : b ? 1 : 0
  return a.localeCompare(b)
}

/** A date as YYYY-MM-DD in the browser's time zone. */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function runsText(value: unknown): string {
  return Array.isArray(value) ? value.map((r) => (Array.isArray(r) ? String(r[0]) : '')).join('') : ''
}

export const TOOLS: ToolSpec[] = [getCurrentPage, readPage, queryDatabase]
