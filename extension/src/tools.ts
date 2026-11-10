// Tools the agent can run in the extension.
// The worker's tests import this file too, and their tsconfig has no chrome types.
/// <reference types="chrome" />
import type { ToolSpec } from './agent'
import {
  IN_TRASH,
  NotionError,
  blockOps,
  mergeRecordMaps,
  type LoadedPage,
  type NotionRecord,
  type Operation,
} from './notion/api'
import { isNotion, pageIdFromUrl, toUuid } from './notion/hosts'
import {
  EditError,
  forget,
  mergeReads,
  parseEdits,
  pageRead,
  planEdit,
  previewEdits,
  type PageRead,
  planNewPage,
} from './notion/edit'
import { MarkdownError, parseMarkdown, type NewBlock } from './notion/blocks'
import {
  PropertyError,
  oneLine,
  plainText,
  propertyValue,
  schemaEntry,
  shownInput,
  type PropertyInput,
} from './notion/props'
import { PAGE_TYPES, hexId, pageToMarkdown, rowValues, splitSections, type Schema } from './notion/markdown'
import { activeNotionTab, selectionIn, type NotionTab } from './notion/tab'
import { pageChildren, pageTree, runsText, treeLines } from './notion/tree'

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

/** Which Notion page is open, told to the model with each question; the page can change between them. */
export async function openPageNote(): Promise<string> {
  const page = await currentNotionPage()
  if (!page) return '[No Notion page is open in the current tab.]'
  // The page's author picks its title, and a shared link its query: keep both from closing the note
  // and faking another one.
  const title = clip(page.title.replace(/[[\]]/g, ''), TITLE_CHARS)
  const url = page.url.replaceAll('[', '%5B').replaceAll(']', '%5D')
  return `[The Notion page open in the current tab: ${JSON.stringify(title)}, ${url}]`
}

const TITLE_CHARS = 200

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
    const { parts, members } = splitSections(md.sections, PART_CHARS)
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
      ...(md.kind === 'database' ? ['This page is a database: read its rows with query_database.'] : []),
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
    // What edit_page checks edits against: only the blocks this read showed, as they were. Part 1
    // starts a new read; later parts add to it.
    // The blocks this part drew, as the renderer reports them: never inferred from page text.
    const drawn = new Set(members[part - 1].flatMap(({ section, from, to }) => md.owners[section].slice(from, to)))
    const seen = pageRead(loaded, md, (b) => drawn.has(b))
    remember(part === 1 ? seen : mergeReads(pageReads.get(loaded.page.id), seen))
    return [...header, '', ...properties, ...(body ? [body] : [])].join('\n')
  },
}

/**
 * A page id from what the model gave: a Notion URL (with or without `https://`), an id, a page
 * slug ending in its id (`Title-<id>`), or a reference to a page (`^<id>`).
 */
function pageArg(text: string): string | undefined {
  // `/<id>` is how read_page shows links to pages.
  let value = text
    .trim()
    .replace(/^\^/, '')
    .replace(/^\/(?=[0-9a-f]{32}\b)/i, '')
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

/** A database's data source: its collection, the workspace it lives in, its schema, and its views. */
async function resolveDatabase(client: NotionTab['client'], block: NotionRecord) {
  const pointer = (block.format as { collection_pointer?: { id?: string; spaceId?: string } } | undefined)
    ?.collection_pointer
  const collectionId = (block.collection_id as string | undefined) ?? pointer?.id
  if (!collectionId) throw new Error('This database has no data source.')
  // A linked view's database may live in another workspace; its pointer says which.
  const spaceId = String(block.collection_id ? block.space_id : (pointer?.spaceId ?? block.space_id))
  const collection = (await client.getRecords([{ table: 'collection', id: collectionId, spaceId }])).collection![
    collectionId
  ]
  return {
    collectionId,
    spaceId,
    schema: (collection.schema ?? {}) as Schema,
    name: runsText(collection.name) || 'Untitled database',
    views: Array.isArray(block.view_ids) ? (block.view_ids as string[]) : [],
  }
}

/** How many rows and databases the agent saw are remembered, for previews; the oldest go first. */
const SEEN_KEPT = 500
/** The rows query_database showed, by row id: their title and values as shown. */
const seenRows = new Map<string, { title: string; values: { name: string; value: string }[] }>()
/** The databases query_database read, by block id: their names. */
const seenDatabases = new Map<string, string>()

function keep<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key)
  map.set(key, value)
  if (map.size > SEEN_KEPT) map.delete(map.keys().next().value!)
}

export const queryDatabase: ToolSpec = {
  name: 'query_database',
  description:
    "Reads the rows of a Notion database as a table: its properties (name and type) and each row's values, " +
    "with the row's id (read a row with read_page). Give the database by id or URL, or leave it out when the " +
    'open page is a database. `filter` keeps rows whose shown values match every condition (text, ' +
    'case-insensitive; people and linked pages by name; dates as YYYY-MM-DD; checkboxes as Yes/No); `sort` ' +
    "orders them. Formulas and rollups can't be used. Long results come in " +
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

    const block = (await tab.client.getRecords([{ table: 'block', id }])).block![id]
    if (block.type !== 'collection_view_page' && block.type !== 'collection_view') {
      throw new Error(given ? 'That is not a database.' : 'The open page is not a database. Give `database`.')
    }
    const { collectionId, spaceId, schema, name, views } = await resolveDatabase(tab.client, block)
    // The view the user is looking at (`?v=` in the URL) when it is one of this database's.
    const viewInUrl = urlView(given ?? tab.url)
    const viewId = views.find((v) => toUuid(v) === viewInUrl) ?? views[0]
    if (!viewId) throw new Error("This database's rows can't be read: it has no view.")
    keep(seenDatabases, id, name)

    const filters = parseFilters(args.filter, schema)
    const sort = parseSort(args.sort, schema)
    const { rowIds, hasMore, recordMap } = await tab.client.queryCollection(collectionId, viewId, spaceId, QUERY_LOAD)
    let rows = rowIds
      .map((r) => recordMap.block?.[r])
      .filter((r): r is NonNullable<typeof r> => !!r && r.alive !== false)
      .map((r) => ({ id: r.id, values: rowValues(recordMap, r as never, schema) }))
    rows = rows.filter((r) => filters.every((f) => matches(r.values, f)))
    if (sort) {
      // Decided once for the column: numbers by value, anything else as text.
      const numbers = numeric(rows, sort.property)
      rows.sort((a, b) =>
        compareValues(cell(a.values, sort.property), cell(b.values, sort.property), sort.sign, numbers),
      )
    }

    const parts = Math.max(1, Math.ceil(rows.length / QUERY_PART))
    if (part > parts)
      throw new Error(`This result has ${parts} part${parts === 1 ? '' : 's'}; there is no part ${part}.`)
    const shown = rows.slice((part - 1) * QUERY_PART, part * QUERY_PART)
    const columns = rows[0]?.values.map((v) => v.name) ?? Object.values(schema).map((s) => s.name ?? '')
    // Titles come escaped as Markdown already; escape only the pipes that aren't.
    const escape = (text: string) => text.replace(/(?<!\\)((?:\\\\)*)\|/g, '$1\\|').replace(/\n/g, ' ')
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
    // What the agent saw of each row, so a change to one can show its old values.
    for (const r of shown) keep(seenRows, r.id, { title: r.values[0]?.value ?? '', values: r.values })
    if (!shown.length) return [...header, '', '(no rows)'].join('\n')
    const table = [
      `| ${[...columns.map(escape), 'Row'].join(' | ')} |`,
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
    refuseComputed(schema, property, where)
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
  refuseComputed(schema, property, '`sort`')
  return { property: propertyNamed(schema, property)!, sign: direction === 'descending' ? -1 : 1 }
}

/** The schema's name for a property (its key when it has none), matched case-insensitively. */
function propertyNamed(schema: Schema, name: string): string | undefined {
  const want = name.trim().toLowerCase()
  const found = Object.entries(schema).find(([key, s]) => (s.name ?? key).toLowerCase() === want)
  return found ? (found[1].name ?? found[0]) : undefined
}

/** Formulas and rollups are computed by Notion when it shows a database; this tool can't read them. */
function refuseComputed(schema: Schema, name: string, where: string) {
  const want = name.trim().toLowerCase()
  const type = Object.entries(schema).find(([key, s]) => (s.name ?? key).toLowerCase() === want)?.[1].type
  if (type === 'formula' || type === 'rollup') {
    throw new Error(
      `${where}: "${name}" is a ${type}, which Notion computes and this tool can't read, so it can't be used.`,
    )
  }
}

/** The view a Notion database URL names with `?v=`. */
function urlView(url: string): string | undefined {
  try {
    return toUuid(new URL(url).searchParams.get('v') ?? '')
  } catch {
    return undefined
  }
}

function rowValuesHeader(schema: Schema): string {
  const entries = Object.entries(schema)
  const isTitle = ([key, s]: [string, { type?: string }]) => key === 'title' || s.type === 'title'
  return [...entries.filter(isTitle), ...entries.filter((e) => !isTitle(e))]
    .map(([key, s]) => `${s.name ?? key} (${s.type ?? 'text'})`)
    .join(', ')
}

/**
 * A row's value for a property, as compared: plain text, with mentions as names (`@Ann` → `Ann`,
 * `[Spec](…)` → `Spec`, `@2026-11-12` → `2026-11-12`) and no Markdown marks.
 */
function cell(values: { name: string; value: string }[], property: string): string {
  const raw = values.find((v) => v.name === property)?.value ?? ''
  // The value as the user reads it: links as their text, no mention marks, Markdown marks and
  // escapes undone, so filters compare against what Notion shows.
  return raw
    .replace(/\[((?:\\.|[^\]\\])*)\]\([^)]*\)/g, '$1')
    .replace(/(^|[\s,(])@/g, '$1')
    .replace(/\\(.)|\*\*|~~|`/g, (_, escaped: string | undefined) => escaped ?? '')
    .trim()
}

function matches(values: { name: string; value: string }[], f: Filter): boolean {
  const v = cell(values, f.property).toLowerCase()
  const want = f.value.toLowerCase()
  // A bare date asks about a day: a cell with a time or a range matches by the day it starts on.
  const same = () => (/^\d{4}-\d{2}-\d{2}$/.test(want) ? day(v) === want : v === want)
  // Numbers compare as numbers, dates by the day they start on, other text as text.
  const order = () => {
    const [a, b] = [Number(v), Number(want)]
    return Number.isFinite(a) && Number.isFinite(b)
      ? Math.sign(a - b)
      : day(v) < day(want)
        ? -1
        : day(v) > day(want)
          ? 1
          : 0
  }
  switch (f.op) {
    case 'is':
      return same()
    case 'is_not':
      return !same()
    case 'contains':
      return v.includes(want)
    case 'not_contains':
      return !v.includes(want)
    case 'is_empty':
      return v === ''
    case 'is_not_empty':
      return v !== ''
    case 'before':
      return v !== '' && order() < 0
    case 'after':
      return v !== '' && order() > 0
  }
}

/**
 * Compares two values in the asked direction (`sign`); empty values go last either way. A column of
 * numbers compares by value (negatives and decimals included); anything else as text.
 */
function compareValues(a: string, b: string, sign: 1 | -1, numbers: boolean): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0
  const order = numbers ? Number(a) - Number(b) : a.localeCompare(b, undefined, { numeric: true })
  return order * sign
}

/** Whether every non-empty value of a property, across the rows, is a number. */
function numeric(rows: { values: { name: string; value: string }[] }[], property: string): boolean {
  const values = rows.map((r) => cell(r.values, property)).filter((v) => v !== '')
  return values.length > 0 && values.every((v) => Number.isFinite(Number(v)))
}

/** A value's leading YYYY-MM-DD when it starts with one, else the value. */
function day(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value
}

/** A date as YYYY-MM-DD in the browser's time zone. */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const LIST_MAX_DEPTH = 3
/** How many pages one list shows, so a large workspace still fits the conversation. */
export const LIST_LIMIT = 100
/** How many pages each top-level section shows. */
export const SECTION_LIMIT = 50

export const listPages: ToolSpec = {
  name: 'list_pages',
  description:
    "Lists pages and databases as Notion's sidebar shows them: without `page`, the top level of the open page's " +
    "workspace (private and shared pages, and the workspace's own pages and teamspaces where its records list " +
    'them); with `page`, the pages ' +
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
      truncated
        ? [
            `Not every page may be listed: a list shows at most ${LIST_LIMIT} pages, and pages under the ` +
              'last ones shown may be left out. To see what is under a listed page, list it by its id.',
          ]
        : []

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
    // A page can be in more than one list (a shared page often stays in the owner's private
    // pages, where the sidebar shows it); it is listed in the first. Teamspaces are listed when the
    // workspace's records name them; workspaces that load them another way don't show them yet.
    const sections: [string, string[]][] = [
      ['Private', space.privatePages],
      ['Shared', space.sharedPages],
      ['Workspace', space.workspacePages],
      ...space.teams.map((t): [string, string[]] => [`Teamspace: ${t.name}`, t.pages]),
    ]
    // Each section has its own share of the limit, so a long one can't hide the others, and all of
    // them together stay within the overall limit.
    const seen = new Set<string>()
    const out = [`Pages in the workspace “${space.name}”:`]
    const skipped: string[] = []
    let any = false
    let left = LIST_LIMIT
    for (const [label, all] of sections) {
      const ids = all.filter((id) => !seen.has(id))
      if (!ids.length) continue
      if (left <= 0) {
        skipped.push(label)
        continue
      }
      const limit = Math.min(SECTION_LIMIT, left)
      const { nodes, truncated } = await pageTree(tab.client, ids, depth, limit)
      if (!nodes.length) continue
      any = true
      left -= countNodes(nodes)
      out.push('', label, ...treeLines(nodes))
      // Only pages actually listed count as listed, so one cut from this section can show in a later one.
      for (const id of nodeIds(nodes)) seen.add(id)
      if (truncated) out.push('(This section was cut off: not every page in it is listed.)')
    }
    if (skipped.length) out.push('', `Not listed, to keep the list short: ${skipped.join(', ')}.`)
    if (!any) out.push('', '(no pages)')
    return out.join('\n')
  },
}

function nodeIds(nodes: { id: string; children: unknown[] }[]): string[] {
  return nodes.flatMap((n) => [n.id, ...nodeIds(n.children as { id: string; children: unknown[] }[])])
}

function countNodes(nodes: { children: unknown[] }[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children as { children: unknown[] }[]), 0)
}

/** The last read of each page, by page id: what edit_page checks edits against. */
const pageReads = new Map<string, PageRead>()

/** Forgets what the agent read, for a new or another conversation, which must read pages itself. */
export function forgetReads(): void {
  pageReads.clear()
  recentReads.clear()
  seenRows.clear()
  seenDatabases.clear()
}

const EDIT_ITEM = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['insert', 'replace', 'delete'] },
    block: {
      type: 'string',
      description:
        'Reference of the block, as read_page shows it (e.g. ^1a2b3c4d). For insert: the block to insert after.',
    },
    position: {
      type: 'string',
      enum: ['after', 'start', 'end'],
      description: 'For insert: after `block` (the default when `block` is given), or at the start or end of the page.',
    },
    markdown: { type: 'string', description: 'For insert and replace: the new content, as Markdown.' },
  },
  required: ['action'],
  additionalProperties: false,
}

export const editPage: ToolSpec = {
  name: 'edit_page',
  description:
    'Changes a Notion page you have read with read_page: insert Markdown after a block or at the start or end of the ' +
    'page, replace a block with Markdown, or delete a block. Blocks are named by the references read_page shows. ' +
    'All edits in one call are applied together, or none are. Supported Markdown: paragraphs, # headings, - lists, ' +
    '1. lists, - [ ] to-dos, ▸ toggles, > quotes, > [!💡] callouts, ``` code, ---, $$equations$$, **bold**, *italic*, ' +
    '~~strike~~, `code`, [links](url), and [page](<page id>) mentions; a backslash keeps a character literal. ' +
    'Indent by two spaces to nest under lists, to-dos, toggles, and paragraphs; quotes and callouts hold text only. ' +
    "Child pages, databases, files, and tables can't be written. If the page changed since you read it, the edit is " +
    'refused: read it again and redo the edit.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'string', description: 'Id of the page to edit, as read_page shows it after "Page:".' },
      edits: { type: 'array', items: EDIT_ITEM, minItems: 1 },
    },
    required: ['page', 'edits'],
    additionalProperties: false,
  },
  preview: (args) => {
    const given = givenPage(args)
    if (!given) return undefined
    return previewEdits(args.edits, pageReads.get(pageArg(given) ?? ''), given)
  },
  run: async (args, signal) => {
    // The page is named in the call, so the page the preview names is the page that gets changed.
    const given = givenPage(args)
    if (!given) throw new EditError('Give `page`: the id read_page shows after "Page:".')
    const id = pageArg(given)
    if (!id) throw new Error(`Not a Notion page URL or id: ${given}`)
    const tab = await activeNotionTab()
    const read = pageReads.get(id)
    if (!read) throw new EditError('Read the page with read_page first, then edit it using the references it shows.')
    const edits = parseEdits(args.edits, read)

    const loaded = await tab.client.loadPage(id)
    if (loaded.page.type !== 'page') {
      throw new EditError(
        PAGE_TYPES.has(loaded.page.type)
          ? "That is a database; edit_page can't change it."
          : 'That id is a block inside a page, not a page.',
      )
    }
    const plan = planEdit(loaded, read, edits)
    // The last point where nothing has been sent: a Stop pressed while the page loaded wins.
    // Every edit was a no-op: there is nothing to send, and the page stays as read.
    if (!plan.operations.length) return plan.summary.join('\n')
    signal?.throwIfAborted()
    try {
      await tab.client.submitTransaction(loaded.spaceId, plan.operations, 'Notion Copilot: edit_page')
    } catch (err) {
      // The edit may have been saved: a retry from the same read could apply it twice, so the
      // page must be read again first, which also shows whether it landed.
      if (err instanceof NotionError && err.code === 'outcome_unknown') {
        pageReads.delete(id)
        for (const key of recentReads.keys()) if (key.endsWith(`:${id}`)) recentReads.delete(key)
      }
      throw err
    }

    // The page changed: forget cached parts. What the agent saw stays as it was, except for what
    // this edit changed, so a block the user changed meanwhile is still refused.
    for (const key of recentReads.keys()) if (key.endsWith(`:${id}`)) recentReads.delete(key)
    // Blocks it changed or deleted need a new read before they are edited again.
    let next = forget(read, [...plan.deleted, ...plan.changed.filter((b) => b !== id)])
    let newRefs = ''
    try {
      const after = await tab.client.loadPage(id)
      // Only the blocks this edit created: anyone may have changed the others since it was saved,
      // so blocks it changed are left for the next read_page to show.
      const ours = new Set(plan.createdAll)
      next = mergeReads(
        next,
        pageRead(after, pageToMarkdown(after), (b) => ours.has(b)),
      )
      const refs = plan.created.map((c) => next.refs.get(c)).filter(Boolean)
      if (refs.length) newRefs = `New blocks: ${refs.map((r) => `^${r}`).join(', ')}.`
    } catch {
      // The edit is saved; blocks it changed will be refused until the page is read again.
    }
    remember(next)
    return [...plan.summary, newRefs, 'Read the page again to see the result.'].filter(Boolean).join('\n')
  },
}

/** The page argument, if given; null and blank mean not given. */
function givenPage(args: Record<string, unknown>): string | undefined {
  return typeof args.page === 'string' && args.page.trim() ? args.page : undefined
}

/** How many pages' reads are kept; the oldest go first. */
const READS_KEPT = 20

/** Keeps a read, as the most recent one. */
function remember(read: PageRead) {
  pageReads.delete(read.pageId)
  pageReads.set(read.pageId, read)
  if (pageReads.size > READS_KEPT) pageReads.delete(pageReads.keys().next().value!)
}

/** A page title on one line, as Notion keeps it, so it can't break up the preview's lines. */
function titleArg(value: unknown): string {
  return typeof value === 'string' ? oneLine(plainText(value)) : ''
}

/** `properties` as tools take it: values by property name. */
const PROPERTIES_ARG = {
  type: 'object',
  description:
    'Database properties by name: text, a number, Yes/No for checkboxes, an option name (a list for ' +
    'multi-select), or a date as YYYY-MM-DD (a range as "YYYY-MM-DD → YYYY-MM-DD"). Empty clears a value.',
  additionalProperties: {
    anyOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'array', items: { type: 'string' } },
      { type: 'null' },
    ],
  },
}

export const createPage: ToolSpec = {
  name: 'create_page',
  description:
    'Creates a Notion page with a title and Markdown content (the same Markdown as edit_page). `parent` is a page ' +
    "(the open page's URL, or another page), and the new page goes at its end; or a " +
    'database, and the new page is a row of it, with `properties` set by name (values as query_database shows ' +
    "them; options must exist). Returns the new page's id and URL.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: "The new page's title." },
      markdown: { type: 'string', description: "The page's content, as Markdown. Leave out for an empty page." },
      parent: { type: 'string', description: 'URL or id of the page or database to create it in.' },
      properties: PROPERTIES_ARG,
    },
    required: ['title', 'parent'],
    additionalProperties: false,
  },
  preview: (args) => {
    const title = titleArg(args.title)
    // The page exactly as `run` will resolve it, so the user sees where the page went.
    const given = typeof args.parent === 'string' ? args.parent.trim() : ''
    const id = given ? pageArg(given) : undefined
    // By name when the agent has read it, so the user can tell which page or database it is.
    const database = id ? seenDatabases.get(id) : undefined
    const known = id ? (database ?? pageReads.get(id)?.title) : undefined
    const parent = id ? `${known ? `${oneLine(known)} ` : ''}^${hexId(id)}` : given || '(none given)'
    const markdown = typeof args.markdown === 'string' && args.markdown.trim() ? args.markdown : '(empty)'
    const props = propertiesArg(args.properties)
    // Each part on a line of its own, so text in the title can't read as where the page goes.
    // Whether the parent is a page or a database decides what happens; say it only when known.
    const row = !!database || props.length > 0
    const page = !row && !!id && pageReads.has(id)
    return [
      row ? 'Add a row to a database' : 'Create a page',
      `Title: ${title}`,
      row
        ? `In: ${parent}`
        : page
          ? `At the end of: ${parent}`
          : `In: ${parent} (at its end if it is a page; as a new row if it is a database)`,
      ...(props.length ? ['Properties:', ...props.map(([name, v]) => `    ${oneLine(name)}: ${shownInput(v)}`)] : []),
      'Content:',
      ...markdown.split('\n').map((l) => `    ${l}`),
    ].join('\n')
  },
  run: async (args, signal) => {
    const title = titleArg(args.title)
    if (!title) throw new Error('`title` must not be empty.')
    const given = typeof args.parent === 'string' ? args.parent.trim() : ''
    if (!given) throw new Error('`parent` is required: the URL or id of the page or database to create it in.')
    const parentId = pageArg(given)
    if (!parentId) throw new Error(`Not a Notion page URL or id: ${given}`)
    const props = propertiesArg(args.properties)
    const tab = await activeNotionTab()
    let blocks: NewBlock[] = []
    if (typeof args.markdown === 'string' && args.markdown.trim()) {
      try {
        blocks = parseMarkdown(args.markdown)
      } catch (err) {
        if (err instanceof MarkdownError) throw new EditError(err.message)
        throw err
      }
    }
    const parent = (await tab.client.getRecords([{ table: 'block', id: parentId }])).block![parentId]
    let target: { id: string; table: 'block' | 'collection' }
    let spaceId: unknown = parent.space_id
    let properties: Record<string, unknown> = {}
    if (parent.type === 'collection_view_page' || parent.type === 'collection_view') {
      // A row goes in the database's data source, in the workspace that holds it.
      const db = await resolveDatabase(tab.client, parent)
      target = { id: db.collectionId, table: 'collection' }
      spaceId = db.spaceId
      properties = toProperties(db.schema, props)
    } else if (parent.type === 'page') {
      if (props.length) throw new EditError('`properties` are only for rows: that parent is a page, not a database.')
      target = { id: parentId, table: 'block' }
    } else {
      throw new EditError('That id is a block inside a page, not a page or a database.')
    }
    if (typeof spaceId !== 'string' || !spaceId)
      throw new NotionError('notion_error', 'Notion returned the page without its workspace.')
    const { operations, pageId } = planNewPage(target, spaceId, title, blocks, { properties })
    signal?.throwIfAborted()
    // The parent's list changes: cached parts of it would hide the new page, and after an unknown
    // outcome the agent must see whether it was created before it tries again.
    try {
      await tab.client.submitTransaction(spaceId, operations, 'Notion Copilot: create_page')
    } catch (err) {
      // A retry would create a second page if this one was saved: the agent must look first.
      if (err instanceof NotionError && err.code === 'outcome_unknown') {
        pageReads.delete(parentId)
        throw new NotionError(
          'outcome_unknown',
          `Notion did not answer, so the page may or may not have been created. ` +
            `${target.table === 'collection' ? 'Query' : 'Read'} ^${hexId(parentId)} and check for “${title}” ` +
            'before trying again.',
          { cause: err },
        )
      }
      throw err
    } finally {
      for (const key of recentReads.keys()) if (key.endsWith(`:${parentId}`)) recentReads.delete(key)
    }
    const hex = hexId(pageId)
    return [
      target.table === 'collection'
        ? `Added the row “${title}” ^${hex} to the database ^${hexId(parentId)}.`
        : `Created the page “${title}” ^${hex} at the end of ^${hexId(parentId)}.`,
      `URL: ${new URL(tab.url).origin}/${hex}`,
    ].join('\n')
  },
}

/** How many pages one update_pages call changes at most, so its preview stays readable. */
export const UPDATE_MAX = 50

export const updatePages: ToolSpec = {
  name: 'update_pages',
  description:
    "Changes pages' titles, icons (an emoji), or database properties (for rows, by name, values as " +
    'query_database shows them; options must exist; empty clears a value), several pages in one call: "mark ' +
    'these five tasks done" is one call. Get row ids from query_database. Nothing is written if any value is ' +
    'refused.',
  parameters: {
    type: 'object',
    properties: {
      pages: {
        type: 'array',
        minItems: 1,
        maxItems: UPDATE_MAX,
        items: {
          type: 'object',
          properties: {
            page: { type: 'string', description: 'Id or URL of the page or row.' },
            title: { type: 'string', description: 'A new title.' },
            icon: { type: 'string', description: 'A new icon: one emoji.' },
            properties: PROPERTIES_ARG,
          },
          required: ['page'],
          additionalProperties: false,
        },
      },
    },
    required: ['pages'],
    additionalProperties: false,
  },
  preview: (args) => {
    const updates = Array.isArray(args.pages) ? (args.pages as Record<string, unknown>[]) : []
    const lines = [`Change ${updates.length} page${updates.length === 1 ? '' : 's'}`]
    for (const u of updates) {
      const given = typeof u?.page === 'string' ? u.page.trim() : ''
      const id = given ? pageArg(given) : undefined
      const seen = id ? seenRows.get(id) : undefined
      const known = seen?.title ?? (id ? pageReads.get(id)?.title : undefined)
      lines.push(id ? `${known ? `${oneLine(known)} ` : ''}^${hexId(id)}` : oneLine(given) || '(no page given)')
      // The old value when the agent saw it, so the user sees what changes.
      const was = (name: string) => {
        const old = seen?.values.find((v) => v.name.toLowerCase() === name.trim().toLowerCase())?.value
        return old === undefined ? '' : ` (was ${old ? oneLine(old) : 'empty'})`
      }
      if (typeof u?.title === 'string')
        lines.push(`    Title: ${titleArg(u.title)}${seen ? ` (was ${oneLine(seen.title)})` : ''}`)
      if (typeof u?.icon === 'string') lines.push(`    Icon: ${oneLine(u.icon)}`)
      let props: [string, PropertyInput][] = []
      try {
        props = propertiesArg(u?.properties)
      } catch {
        lines.push('    (properties that will be refused)')
      }
      for (const [name, v] of props) lines.push(`    ${oneLine(name)}: ${shownInput(v)}${was(name)}`)
    }
    return lines.join('\n')
  },
  run: async (args, signal) => {
    const updates = parseUpdates(args.pages)
    const tab = await activeNotionTab()
    const ids = updates.map((u) => u.id)
    const blocks = (await tab.client.getRecords(ids.map((id) => ({ table: 'block', id })))).block!
    for (const u of updates) {
      const block = blocks[u.id]
      if (PAGE_TYPES.has(String(block.type)) && block.type !== 'page')
        throw new EditError(`^${hexId(u.id)} is a database; its name can't be changed with update_pages.`)
      if (block.type !== 'page') throw new EditError(`^${hexId(u.id)} is a block inside a page, not a page.`)
      if (u.props.length && block.parent_table !== 'collection')
        throw new EditError(
          `^${hexId(u.id)} isn't a database row, so it has no properties; only its title and icon can change.`,
        )
    }
    const spaces = new Set(updates.map((u) => String(blocks[u.id].space_id)))
    if (spaces.size > 1)
      throw new EditError('These pages are in different workspaces: change each workspace’s pages in its own call.')
    const spaceId = [...spaces][0]
    // Each row's database, for its schema.
    const collectionIds = [...new Set(updates.filter((u) => u.props.length).map((u) => String(blocks[u.id].parent_id)))]
    const collections = collectionIds.length
      ? (await tab.client.getRecords(collectionIds.map((id) => ({ table: 'collection', id, spaceId })))).collection!
      : {}
    const op = blockOps(spaceId, Date.now())
    const operations: Operation[] = []
    const summary: string[] = []
    for (const u of updates) {
      const block = blocks[u.id]
      const values: Record<string, unknown[]> = u.props.length
        ? toProperties((collections[String(block.parent_id)]?.schema ?? {}) as Schema, u.props)
        : {}
      if (u.title !== undefined) values.title = [[u.title]]
      if (Object.keys(values).length) operations.push(op.setProperties(u.id, values))
      if (u.icon !== undefined) operations.push(op.setFormat(u.id, { page_icon: u.icon }))
      operations.push(op.touch(u.id))
      const changed = [
        ...(u.title !== undefined ? ['title'] : []),
        ...(u.icon !== undefined ? ['icon'] : []),
        ...u.props.map(([n]) => oneLine(n)),
      ]
      summary.push(`^${hexId(u.id)}: ${changed.join(', ')}`)
    }
    signal?.throwIfAborted()
    try {
      // Setting values again does no harm, so after a lost answer the agent may simply retry.
      await tab.client.submitTransaction(spaceId, operations, 'Notion Copilot: update_pages')
    } catch (err) {
      // Whether a rename landed is unknown: the page's read, and the title it shows, go too.
      if (err instanceof NotionError && err.code === 'outcome_unknown') for (const id of ids) pageReads.delete(id)
      throw err
    } finally {
      for (const id of ids) {
        seenRows.delete(id)
        for (const key of recentReads.keys()) if (key.endsWith(`:${id}`)) recentReads.delete(key)
      }
    }
    // A read's title shows in later previews; keep it current.
    for (const u of updates) {
      const read = pageReads.get(u.id)
      if (read && u.title !== undefined) read.title = u.title
    }
    return [`Changed ${updates.length} page${updates.length === 1 ? '' : 's'}:`, ...summary].join('\n')
  },
}

/** Whether `text` is exactly one emoji (flags and keycaps included), as Notion takes for an icon. */
function isEmoji(text: string): boolean {
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
  return graphemes.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(text)
}

/** update_pages' `pages`, checked before anything is asked of Notion. */
function parseUpdates(value: unknown) {
  if (!Array.isArray(value) || !value.length) throw new EditError('`pages` must be a list with at least one page.')
  if (value.length > UPDATE_MAX) throw new EditError(`At most ${UPDATE_MAX} pages can change in one call.`)
  const seen = new Set<string>()
  return value.map((raw: unknown, i) => {
    const u = (raw ?? {}) as Record<string, unknown>
    const id = typeof u.page === 'string' ? pageArg(u.page) : undefined
    if (!id) throw new EditError(`Page ${i + 1} needs \`page\`: the id or URL of a page or row.`)
    if (seen.has(id)) throw new EditError(`^${hexId(id)} is given twice; put all its changes in one entry.`)
    seen.add(id)
    const title = u.title === undefined ? undefined : titleArg(u.title)
    if (title === '') throw new EditError(`Page ${i + 1}: \`title\` must not be empty.`)
    const icon = u.icon === undefined ? undefined : typeof u.icon === 'string' ? u.icon.trim() : ''
    if (icon !== undefined && !isEmoji(icon)) throw new EditError(`Page ${i + 1}: \`icon\` must be an emoji.`)
    const props = propertiesArg(u.properties)
    if (title === undefined && icon === undefined && !props.length)
      throw new EditError(`Page ${i + 1} changes nothing: give \`title\`, \`icon\`, or \`properties\`.`)
    return { id, title, icon, props }
  })
}

/** The `properties` argument as [name, value] pairs; anything else is refused. */
function propertiesArg(value: unknown): [string, PropertyInput][] {
  if (value === undefined || value === null) return []
  if (typeof value !== 'object' || Array.isArray(value))
    throw new EditError('`properties` must be an object of values by name.')
  return Object.entries(value as Record<string, unknown>).map(([name, v]) => {
    const ok =
      v === null ||
      ['string', 'number', 'boolean'].includes(typeof v) ||
      (Array.isArray(v) && v.every((x) => typeof x === 'string'))
    if (!ok) throw new EditError(`The value for “${oneLine(name)}” must be text, a number, Yes/No, or a list.`)
    return [name, v as PropertyInput]
  })
}

/** Property values as Notion stores them, by schema key; the title is given as `title` instead. */
function toProperties(schema: Schema, props: [string, PropertyInput][]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  for (const [name, input] of props) {
    const [key, def] = schemaEntry(schema, name)
    if (key === 'title' || def.type === 'title')
      throw new EditError(`Give the title as \`title\`, not as “${oneLine(name)}”.`)
    if (key in out) throw new EditError(`“${oneLine(name)}” is given twice.`)
    try {
      out[key] = propertyValue(def, input)
    } catch (err) {
      if (err instanceof PropertyError) throw new EditError(err.message)
      throw err
    }
  }
  return out
}

/** How many pages one move_page or trash_page call takes at most, so its preview stays readable. */
export const ORGANIZE_MAX = 50

/** How far up from a page move_page looks for the pages it is in. */
const ANCESTORS_MAX = 100

/** A list of pages as move_page and trash_page take it: ids, each once. */
function pageList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw new EditError('`pages` must be a list with at least one page.')
  if (value.length > ORGANIZE_MAX) throw new EditError(`At most ${ORGANIZE_MAX} pages can go in one call.`)
  const ids = value.map((v, i) => {
    const id = typeof v === 'string' ? pageArg(v) : undefined
    if (!id) throw new EditError(`Page ${i + 1} is not a Notion page URL or id: ${oneLine(String(v))}`)
    return id
  })
  return [...new Set(ids)]
}

/** The ids `pages` names, for a preview: whatever can be read of it, never an error. */
function previewIds(value: unknown): { given: string; id?: string }[] {
  const list = Array.isArray(value) ? value : []
  return list.slice(0, ORGANIZE_MAX).map((v) => {
    const given = typeof v === 'string' ? v.trim() : ''
    return { given, id: given ? pageArg(given) : undefined }
  })
}

/** A page's title as the agent last saw it, if it saw one. */
function knownTitle(id: string): string | undefined {
  return pageReads.get(id)?.title ?? seenRows.get(id)?.title ?? seenDatabases.get(id)
}

/** A page for a preview: its title when known, and its reference. */
function shownPage(given: string, id: string | undefined, title = id ? knownTitle(id) : undefined): string {
  if (!id) return oneLine(given) || '(no page given)'
  return `${title ? `${oneLine(title)} ` : ''}^${hexId(id)}`
}

/** Why a block can't be moved, copied, or trashed as a page; undefined if it can. */
function notAPage(block: NotionRecord, verb: string): string | undefined {
  const ref = `^${hexId(block.id)}`
  if (block.type === 'collection_view') return `${ref} is a database inside a page, not a page: move the page it is on.`
  if (block.type !== 'page' && block.type !== 'collection_view_page')
    return `${ref} is a block inside a page, not a page.`
  if (block.parent_table === 'collection') return `${ref} is a database row: rows can't be ${verb} with this tool.`
  return undefined
}

/** Forgets what the agent cached of these pages, which a move, copy, or trash changed. */
function forgetPages(ids: Iterable<string>) {
  for (const id of ids) {
    pageReads.delete(id)
    seenRows.delete(id)
    for (const key of recentReads.keys()) if (key.endsWith(`:${id}`)) recentReads.delete(key)
  }
}

export const movePage: ToolSpec = {
  name: 'move_page',
  description:
    'Moves pages, or databases that are pages of their own, to the end of another page, with everything in them, ' +
    'as Notion\'s "Move to" does. Several pages can go in one call. A page can\'t go into itself or a page ' +
    "inside it, and database rows can't be moved.",
  parameters: {
    type: 'object',
    properties: {
      pages: {
        type: 'array',
        minItems: 1,
        maxItems: ORGANIZE_MAX,
        items: { type: 'string' },
        description: 'Ids or URLs of the pages to move.',
      },
      to: { type: 'string', description: 'Id or URL of the page to move them into.' },
    },
    required: ['pages', 'to'],
    additionalProperties: false,
  },
  preview: (args) => {
    const pages = previewIds(args.pages)
    const to = typeof args.to === 'string' ? args.to.trim() : ''
    return [
      `Move ${pages.length} page${pages.length === 1 ? '' : 's'}`,
      `To the end of: ${shownPage(to, to ? pageArg(to) : undefined)}`,
      ...pages.map((p) => `    ${shownPage(p.given, p.id)}`),
    ].join('\n')
  },
  run: async (args, signal) => {
    const ids = pageList(args.pages)
    const to = typeof args.to === 'string' ? args.to.trim() : ''
    if (!to) throw new EditError('`to` is required: the id or URL of the page to move them into.')
    const destId = pageArg(to)
    if (!destId) throw new EditError(`Not a Notion page URL or id: ${oneLine(to)}`)
    const tab = await activeNotionTab()
    const records = (await tab.client.getRecords([...ids, destId].map((id) => ({ table: 'block' as const, id }))))
      .block!
    const dest = records[destId]
    if (dest.type !== 'page') {
      throw new EditError(
        PAGE_TYPES.has(String(dest.type))
          ? `^${hexId(destId)} is a database: pages can only be moved into a page.`
          : `^${hexId(destId)} is a block inside a page: pages can only be moved into a page.`,
      )
    }
    for (const id of ids) {
      const why = notAPage(records[id], 'moved')
      if (why) throw new EditError(why)
      if (records[id].space_id !== dest.space_id)
        throw new EditError(`^${hexId(id)} is in another workspace than ^${hexId(destId)}.`)
    }
    // The destination and every page it is in: none of them may be a page that moves.
    const chain = await ancestors(tab, dest)
    for (const id of ids) {
      if (chain.includes(id))
        throw new EditError(
          id === destId
            ? `^${hexId(id)} can't be moved into itself.`
            : `^${hexId(id)} can't be moved into ^${hexId(destId)}: that page is inside it.`,
        )
    }
    const op = blockOps(String(dest.space_id), Date.now())
    const parents = new Set(ids.map((id) => String(records[id].parent_id)))
    signal?.throwIfAborted()
    try {
      // Moving again puts the pages in the same place, so after a lost answer a retry does no harm.
      await tab.client.submitTransaction(
        String(dest.space_id),
        [op.moveInto(destId, ids), op.touch(destId), ...ids.map((id) => op.touch(id))],
        'Notion Copilot: move_page',
      )
    } finally {
      forgetPages([destId, ...parents])
    }
    return `Moved ${ids.length} page${ids.length === 1 ? '' : 's'} to the end of ^${hexId(destId)}: ${ids.map((id) => `^${hexId(id)}`).join(', ')}.`
  },
}

/** `page` and the pages it is in, from `page` up, as far as the account can see. */
async function ancestors(tab: NotionTab, page: NotionRecord): Promise<string[]> {
  const chain = [page.id]
  let current = page
  for (let depth = 0; depth < ANCESTORS_MAX && current.parent_table === 'block' && current.parent_id; depth++) {
    const parentId = current.parent_id
    // A page the account can't open ends the walk; Notion itself still refuses a move into a page's own pages.
    const parent = (await tab.client.findRecords([{ table: 'block', id: parentId }])).block?.[parentId]
    if (!parent) break
    chain.push(parent.id)
    current = parent
  }
  return chain
}

export const duplicatePage: ToolSpec = {
  name: 'duplicate_page',
  description:
    'Duplicates a page, or a database that is a page of its own, with everything in it (content, pages, and ' +
    "databases inside), as Notion's Duplicate does: the copy goes right after the page, and Notion adds a number " +
    "to its title. Returns the copy's id and URL. Database rows and pages at the top of the sidebar can't be " +
    'duplicated with this tool.',
  parameters: {
    type: 'object',
    properties: { page: { type: 'string', description: 'Id or URL of the page to duplicate.' } },
    required: ['page'],
    additionalProperties: false,
  },
  preview: (args) => {
    const given = typeof args.page === 'string' ? args.page.trim() : ''
    return [
      'Duplicate a page, with everything in it',
      `Page: ${shownPage(given, given ? pageArg(given) : undefined)}`,
    ].join('\n')
  },
  run: async (args, signal) => {
    const given = typeof args.page === 'string' ? args.page.trim() : ''
    if (!given) throw new EditError('`page` is required: the id or URL of the page to duplicate.')
    const id = pageArg(given)
    if (!id) throw new EditError(`Not a Notion page URL or id: ${oneLine(given)}`)
    const tab = await activeNotionTab()
    const page = (await tab.client.getRecords([{ table: 'block', id }])).block![id]
    const why = notAPage(page, 'duplicated')
    if (why) throw new EditError(why)
    if (page.parent_table !== 'block' || !page.parent_id)
      throw new EditError(
        `^${hexId(id)} is at the top of the sidebar: duplicate it in Notion, or move it into a page first.`,
      )
    signal?.throwIfAborted()
    try {
      const copy = await tab.client.duplicatePage(String(page.space_id), id, page.parent_id, { signal })
      const hex = hexId(copy)
      return [
        `Duplicated ^${hexId(id)} as ^${hex}, right after it in ^${hexId(page.parent_id)}.`,
        `URL: ${new URL(tab.url).origin}/${hex}`,
      ].join('\n')
    } catch (err) {
      // A retry would make a second copy if this one was made: the agent must look first.
      if (err instanceof NotionError && err.code === 'outcome_unknown')
        throw new NotionError(
          'outcome_unknown',
          `${err.message} List the pages of ^${hexId(page.parent_id)} to see whether the copy is there.`,
          { cause: err },
        )
      throw err
    } finally {
      forgetPages([page.parent_id])
    }
  },
}

export const trashPage: ToolSpec = {
  name: 'trash_page',
  description:
    "Moves pages, or databases that are pages of their own, to Notion's trash, with everything in them. The user " +
    "is asked first, each time. Nothing is deleted for good: the pages can be restored from Notion's trash. " +
    "Database rows and pages at the top of a teamspace can't be trashed with this tool.",
  needsConfirmation: true,
  parameters: {
    type: 'object',
    properties: {
      pages: {
        type: 'array',
        minItems: 1,
        maxItems: ORGANIZE_MAX,
        items: { type: 'string' },
        description: 'Ids or URLs of the pages to trash.',
      },
    },
    required: ['pages'],
    additionalProperties: false,
  },
  // The user agrees from this, so it names each page as Notion has it now, not as the agent saw it.
  preview: async (args) => {
    const pages = previewIds(args.pages)
    const ids = pages.flatMap((p) => (p.id ? [p.id] : []))
    let found: Record<string, NotionRecord> = {}
    let names = new Map<string, string>()
    try {
      const tab = await activeNotionTab()
      found = (await tab.client.findRecords(ids.map((id) => ({ table: 'block' as const, id })))).block ?? {}
      names = await databaseNames(tab, Object.values(found))
    } catch {
      // Without Notion, the names the agent saw are all there is.
    }
    return [
      `Move ${pages.length} page${pages.length === 1 ? '' : 's'} to the trash, with everything in ${pages.length === 1 ? 'it' : 'them'}`,
      ...pages.map((p) => {
        const block = p.id ? found[p.id] : undefined
        const title = block
          ? names.get(block.id) || runsText((block.properties as { title?: unknown } | undefined)?.title) || 'Untitled'
          : undefined
        return `    ${shownPage(p.given, p.id, title ?? (p.id ? knownTitle(p.id) : undefined))}`
      }),
      "They stay in Notion's trash, where they can be restored.",
    ].join('\n')
  },
  run: async (args, signal) => {
    const ids = pageList(args.pages)
    const tab = await activeNotionTab()
    const records = (await tab.client.getRecords(ids.map((id) => ({ table: 'block' as const, id })))).block!
    const pages = ids.map((id) => {
      const page = records[id]
      const why = notAPage(page, 'trashed')
      if (why) throw new EditError(why)
      if ((page.parent_table !== 'block' && page.parent_table !== 'space') || !page.parent_id)
        throw new EditError(`^${hexId(id)} is at the top of a teamspace: trash it in Notion.`)
      return { id, parentId: page.parent_id, parentTable: page.parent_table as 'block' | 'space' }
    })
    const spaces = new Set(ids.map((id) => String(records[id].space_id)))
    if (spaces.size > 1)
      throw new EditError('These pages are in different workspaces: trash each workspace’s pages in its own call.')
    signal?.throwIfAborted()
    try {
      // Trashing again changes nothing, so after a lost answer a retry does no harm.
      await tab.client.trashPages([...spaces][0], pages)
    } finally {
      forgetPages([...ids, ...pages.map((p) => p.parentId)])
    }
    return [
      `Moved ${ids.length} page${ids.length === 1 ? '' : 's'} to Notion's trash: ${ids.map((id) => `^${hexId(id)}`).join(', ')}.`,
      "They can be restored from Notion's trash.",
    ].join('\n')
  },
}

export const getSelection: ToolSpec = {
  name: 'get_selection',
  description:
    'Returns what the user has selected in the open Notion page: the selected text, and each selected block as ' +
    'Markdown with its reference, ready for edit_page (no read_page needed for those blocks). Use it when the user ' +
    'says "this", "the selection", or "the highlighted text". Nothing selected is a normal answer.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  run: async () => {
    const tab = await activeNotionTab()
    if (!tab.pageId) throw new Error('The Notion tab does not show a page.')
    const selection = await selectionIn(tab.tabId)
    if (!selection?.blockIds.length) return 'Nothing is selected in the Notion page.'
    const loaded = await tab.client.loadPage(tab.pageId)
    const md = pageToMarkdown(loaded)
    // Blocks drawn without a line of their own (table rows, columns) stand for the nearest block
    // that has one, so only blocks whose content is shown count as read.
    const shown = (raw: string): string | undefined => {
      for (let b = toUuid(raw); b && md.refs.has(b); b = loaded.recordMap.block?.[b]?.parent_id)
        if (md.lines.has(b)) return b
      return undefined
    }
    const ids = [...new Set(selection.blockIds.map(shown).filter((b): b is string => !!b))]
    const missed = selection.blockIds.some((b) => !shown(b))
    const beyond = loaded.complete
      ? "aren't on the open page"
      : "aren't on the open page, or are past the part of it that could be loaded"
    if (!ids.length) return `The selected blocks ${beyond}. Read the page instead, or ask the user to select again.`
    // A block of several lines (a table, code) gets its reference on a line of its own.
    const lineOf = (b: string) => {
      const own = md.lines.get(b)!
      return `${own}${own.includes('\n') ? '\n' : ' '}^${md.refs.get(b)}`
    }
    // At most a part's worth, like read_page; at least one block.
    const lines: string[] = []
    let size = 0
    for (const b of ids) {
      const line = lineOf(b)
      if (lines.length && size + line.length > PART_CHARS) break
      lines.push(line)
      size += line.length + 1
    }
    const more = ids.length - lines.length
    // The blocks shown count as read, so edit_page can change them by these references.
    const chosen = new Set(ids.slice(0, lines.length))
    remember(
      mergeReads(
        pageReads.get(loaded.page.id),
        pageRead(loaded, md, (b) => chosen.has(b)),
      ),
    )
    const pageHex = hexId(loaded.page.id)
    return [
      `Selection on the page “${md.title}” ^${pageHex}:`,
      '',
      ...(selection.text === undefined
        ? []
        : [
            `Selected text: “${selection.text.length > 2000 ? `${selection.text.slice(0, 1999)}…` : selection.text}”`,
            '',
          ]),
      `Selected block${ids.length === 1 ? '' : 's'}:`,
      ...lines,
      ...(more ? ['', `${more} more selected block${more === 1 ? '' : 's'}: read the page for them.`] : []),
      ...(missed ? ['', `Only part of the selection is shown: the other selected blocks ${beyond}.`] : []),
    ].join('\n')
  },
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
    // A page in the trash can't be read, so it isn't offered.
    found.results = found.results.filter((r) => found.recordMap.block?.[r.id]?.alive !== false)
    if (!found.results.length) return `No pages found for "${query}".`
    const origin = new URL(tab.url).origin
    const tag = highlightTag(found.results)
    const plain = (text: unknown) => withoutTag(typeof text === 'string' ? text : undefined, tag)
    // A database's name is on its collection, which search doesn't return.
    const names = await databaseNames(
      tab,
      found.results.map((r) => found.recordMap.block?.[r.id]),
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
      for (const m of text.matchAll(/<([A-Za-z0-9]+)>[^<]*<\/\1>/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
    }
  }
  // Only Notion's shape counts: without one, no tag is removed at all.
  const ranked = [...counts].filter(([name]) => /^[A-Za-z0-9]{8}$/.test(name)).sort(([, n], [, m]) => m - n)
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
async function databaseNames(tab: NotionTab, blocks: (NotionRecord | undefined)[]): Promise<Map<string, string>> {
  const databases = blocks.filter(
    (b): b is NotionRecord => !!b && (b.type === 'collection_view_page' || b.type === 'collection_view'),
  )
  const collectionOf = (b: NotionRecord) =>
    (b.collection_id as string | undefined) ??
    (b.format as { collection_pointer?: { id?: string } } | undefined)?.collection_pointer?.id
  const ids = [...new Set(databases.map(collectionOf).filter((id): id is string => !!id))]
  const names = new Map<string, string>()
  if (!ids.length) return names
  // One lookup per database, so one that can't be opened (say, a linked view of another
  // workspace's database) leaves only its own name out.
  const found = await Promise.allSettled(
    ids.map((id) =>
      tab.client.getRecords([{ table: 'collection', id }]).then((r) => [id, r.collection?.[id]] as const),
    ),
  )
  const byCollection = new Map(found.flatMap((f) => (f.status === 'fulfilled' ? [f.value] : [])))
  for (const b of databases) {
    const name = runsText(byCollection.get(collectionOf(b) ?? '')?.name)
    if (name) names.set(b.id, name)
  }
  return names
}

function withoutTag(text: string | undefined, tag: string | undefined): string {
  const out = tag ? (text ?? '').split(`<${tag}>`).join('').split(`</${tag}>`).join('') : (text ?? '')
  return out.replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export const TOOLS: ToolSpec[] = [
  readPage,
  editPage,
  createPage,
  searchPages,
  getSelection,
  queryDatabase,
  updatePages,
  listPages,
  movePage,
  duplicatePage,
  trashPage,
]
