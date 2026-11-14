// Databases: query_database reads the rows, create_database and update_database_schema change
// the properties.
import { defineTool } from '../tool'
import { z } from '../zod'
import { NotionError, blockOps, type Block, type NotionRecord } from '../notion/api'
import { pageLink, pathPageIdFromUrl, toUuid } from '../notion/hosts'
import { EditError } from '../notion/edit'
import { oneLine, plainText, type PropertyDef } from '../notion/props'
import { hexId, rowValues, titleFirst, type Schema } from '../notion/markdown'
import {
  BACKSLASH,
  CHANGE_ARG,
  PROPERTY_SPEC,
  SCHEMA_MAX,
  SchemaError,
  newSchema,
  parseChanges,
  planSchemaChanges,
  renameInRows,
} from '../notion/schema'
import { activeNotionTab } from '../notion/tab'
import { needsAttachedPage } from './current'
import { loadRowMentions, resolveDatabase } from './load'
import { forgetLoads, forgetRead, forgetSeenRow, keepSeenDatabase, keepSeenRow, lastRead, seenDatabase } from './memory'
import {
  CHANGE,
  CREATE,
  READ,
  TITLE_EMPTY,
  filled,
  idIn,
  named,
  on,
  pageArg,
  partArg,
  plural,
  shownText,
} from './shared'

/** How many rows one query loads, and how many one result shows. */
export const QUERY_LOAD = 500
export const QUERY_PART = 50
const FILTER_OPS = ['is', 'is_not', 'contains', 'not_contains', 'is_empty', 'is_not_empty', 'before', 'after'] as const
type FilterOp = (typeof FILTER_OPS)[number]

/** The date properties of a row whose date has a reminder, by name in lowercase. */
function dateReminders(row: Block, schema: Schema): Set<string> {
  const out = new Set<string>()
  for (const [key, def] of Object.entries(schema as Record<string, PropertyDef>)) {
    if (def.type !== 'date') continue
    const runs = (row.properties?.[key] ?? []) as [string, [string, { reminder?: unknown }?][]?][]
    const dated = runs.some(([, marks]) => marks?.some(([m, arg]) => m === 'd' && arg?.reminder))
    if (dated) out.add((def.name ?? key).toLowerCase())
  }
  return out
}

/** Which condition of `filter` an issue is about, as the model is told: "Filter 1". */
const filterAt = (issue: { path?: PropertyKey[] }) => `Filter ${Number(issue.path?.[1]) + 1}`

const QUERY_ARGS = z.strictObject({
  database: z.string().describe('Id or URL of the database. Leave out for the open page.').optional(),
  filter: z
    .array(
      z.strictObject({
        property: z
          .string({ error: (issue) => `${filterAt(issue)} needs \`property\`: a property's name.` })
          .describe('Property name, as the result lists it.'),
        op: z.enum(FILTER_OPS, {
          error: (issue) => `${filterAt(issue)}: \`op\` must be one of ${FILTER_OPS.join(', ')}.`,
        }),
        value: z
          .string({ error: (issue) => `${filterAt(issue)}: \`value\` must be text.` })
          .describe('What to compare with; not needed for is_empty and is_not_empty.')
          .optional(),
      }),
      { error: '`filter` must be a list of conditions.' },
    )
    .optional(),
  sort: z
    .strictObject({
      property: z.string(),
      direction: z.enum(['ascending', 'descending']).optional(),
    })
    .optional(),
  part: partArg('Which part of a long result, starting at 1.'),
})
type QueryArgs = z.output<typeof QUERY_ARGS>

export const queryDatabase = defineTool({
  name: 'query_database',
  description:
    "Reads the rows of a Notion database as a table: its properties (name and type) and each row's values, " +
    "with the row's id (read a row with read_page). Give the database by id or URL, or leave it out when the " +
    "open page is a database. The open view's own filters and sorts are not applied. `filter` keeps rows " +
    'whose shown values match every condition (text, case-insensitive; people and linked pages by name; ' +
    'numbers by value; dates as YYYY-MM-DD, a date range or a time by the day it starts on; checkboxes as ' +
    'Yes/No; multi-select by whole options: `contains` "A, B" keeps rows with both, `is` rows with exactly ' +
    "those); `sort` orders them as Notion's own sort does. Formulas and rollups can't be used. Long results come in parts; ask for " +
    'the next with `part`.',
  touched: (_args, result) => ({ read: idIn(result, /^Database: .* \^([0-9a-f]{32})(?:\n|$)/) }),
  describe: (args, result) =>
    on(
      READ,
      named(result, /^Database: (.+) \^[0-9a-f]+(?:\n|$)/),
      !args || args.database ? 'a database' : 'the open database',
      'rows of',
    ),
  args: QUERY_ARGS,
  run: async ({ database, filter, sort: sortBy, part = 1 }) => {
    const given = filled(database)
    if (!given) await needsAttachedPage()
    const tab = await activeNotionTab()
    const id = given ? pageArg(given) : tab.pageId
    if (given && !id) throw new Error(`Not a Notion database URL or id: ${given}`)
    if (!id) throw new Error('Give `database`: the open tab does not show a page.')

    const isDatabase = (b: NotionRecord) => b.type === 'collection_view_page' || b.type === 'collection_view'
    let block = (await tab.client.getRecords([{ table: 'block', id }])).block![id]
    // A row open in side peek (`?p=`) sits on its database's page: that is the database meant.
    const behind = given ? undefined : pathPageIdFromUrl(tab.url)
    if (!isDatabase(block) && behind && behind !== id) {
      block = (await tab.client.getRecords([{ table: 'block', id: behind }])).block![behind]
    }
    if (!isDatabase(block)) {
      throw new Error(
        given
          ? 'That is not a database.'
          : "The open page is not a database. Give `database`: a database inside a page has its id in read_page's result.",
      )
    }
    const dbId = block.id
    const { collectionId, spaceId, schema, name, views } = await resolveDatabase(tab.client, block)
    // The view the user is looking at (`?v=` in the URL) when it is one of this database's.
    const viewInUrl = urlView(given ?? tab.url)
    const viewId = views.find((v) => toUuid(v) === viewInUrl) ?? views[0]
    if (!viewId) throw new Error("This database's rows can't be read: it has no view.")
    keepSeenDatabase(dbId, name)

    const filters = parseFilters(filter, schema)
    const sort = parseSort(sortBy, schema)
    // Notion orders the rows, as its own sort does (a select by its options, empty values last), so
    // when there are more than one read loads, the ones read are the first in that order.
    const { rowIds, hasMore, recordMap } = await tab.client.queryCollection(collectionId, viewId, spaceId, QUERY_LOAD, {
      sort: sort && { property: sort.key, direction: sort.sign === 1 ? 'ascending' : 'descending' },
    })
    const listed = rowIds.map((r) => recordMap.block?.[r])
    // Rows Notion listed but sent no record for can't be shown or filtered; they are counted instead.
    const missing = listed.filter((r) => !r).length
    // Notion leaves out the pages a relation points to: looked up, they show and filter by name.
    const unnamed = await loadRowMentions(
      tab,
      recordMap,
      listed.filter((r): r is Block => !!r && r.alive !== false),
      spaceId,
    )
    let rows = listed
      .filter((r): r is Block => !!r && r.alive !== false)
      .map((r) => ({ id: r.id, block: r, values: rowValues(recordMap, r, schema) }))
    rows = rows.filter((r) => filters.every((f) => matches(r.values, f)))

    const parts = Math.max(1, Math.ceil(rows.length / QUERY_PART))
    if (part > parts)
      throw new Error(`This result has ${parts} part${parts === 1 ? '' : 's'}; there is no part ${part}.`)
    const shown = rows.slice((part - 1) * QUERY_PART, part * QUERY_PART)
    const columns = titleFirst(schema).map(([key, s]) => (s.name ?? key).replace(/[\\|]/g, '\\$&'))
    const from = (part - 1) * QUERY_PART + 1
    const header = [
      `Database: ${name} ^${hexId(dbId)}`,
      // The user's own date, not UTC's, so "overdue" means what they'd say.
      `Today: ${localDate(new Date())}`,
      `Properties: ${rowValuesHeader(schema)}`,
      `${filters.length ? 'Matching rows' : 'Rows'}: ${rows.length}` +
        (rows.length ? ` (showing ${from}–${from + shown.length - 1})` : '') +
        (part < parts ? `. Read part ${part + 1} for more.` : '.'),
      ...(hasMore
        ? [
            `Only the first ${QUERY_LOAD} rows of the database` +
              (sort ? ` by ${sort.property} (${sort.sign === 1 ? 'ascending' : 'descending'})` : '') +
              ' were read; filters apply to those.',
          ]
        : []),
      ...(missing
        ? [
            `${plural(missing, 'more row')} came without ${missing === 1 ? 'its' : 'their'} values and ${missing === 1 ? 'is' : 'are'} not shown.`,
          ]
        : []),
      ...(unnamed
        ? [
            `${unnamed} more linked ${unnamed === 1 ? 'page or person was' : 'pages or people were'} not looked up and show unnamed; filters on their names may miss rows.`,
          ]
        : []),
      ...(part > 1
        ? ['This part comes from a new read of the database; parts you have from an earlier read may not match it.']
        : []),
    ]
    // What the agent saw of each row, so a change to one can show its old values.
    for (const r of shown) {
      const seen = {
        title: r.values[0]?.value ?? '',
        values: r.values,
        schema,
        reminders: dateReminders(r.block, schema),
      }
      keepSeenRow(r.id, seen)
    }
    if (!shown.length) return [...header, '', '(no rows)'].join('\n')
    const table = [
      `| ${[...columns, 'Row'].join(' | ')} |`,
      `|${[...columns, 'Row'].map(() => ' --- ').join('|')}|`,
      ...shown.map((r) => {
        // A cell is one line. A text value's line break is shown as it is written back (`<br>`, as
        // read_page shows one inside a block); other values, the title among them, are one line.
        const cells = rowValues(recordMap, r.block, schema, { table: true }).map((v) =>
          v.value.replace(/\n/g, v.type === 'text' ? '<br>' : ' '),
        )
        return `| ${[...cells, `^${hexId(r.id)}`].join(' | ')} |`
      }),
    ]
    return [...header, '', ...table].join('\n')
  },
})

interface Filter {
  property: string
  type: string
  op: FilterOp
  value: string
}

function parseFilters(filters: QueryArgs['filter'] = [], schema: Schema): Filter[] {
  return filters.map(({ property, op, value = '' }, n) => {
    const where = `Filter ${n + 1}`
    const [key, def] = usableProperty(schema, property, where)
    const needsValue = op !== 'is_empty' && op !== 'is_not_empty'
    // A multi-select value is a list of options; a list of only commas names none.
    const named = def.type === 'multi_select' ? value.replace(/,/g, '') : value
    if (needsValue && !named.trim()) throw new Error(`${where} needs \`value\`.`)
    return {
      property: def.name ?? key,
      type: def.type ?? 'text',
      op,
      value: needsValue ? value.trim() : '',
    }
  })
}

function parseSort(
  sort: QueryArgs['sort'],
  schema: Schema,
): { property: string; key: string; sign: 1 | -1 } | undefined {
  if (!sort) return undefined
  const [key, def] = usableProperty(schema, sort.property, '`sort`')
  return { property: def.name ?? key, key, sign: sort.direction === 'descending' ? -1 : 1 }
}

/**
 * The schema entry, as [key, definition], for a property a filter or sort names (any case). Formulas
 * and rollups are computed by Notion when it shows a database; this tool can't read them.
 */
function usableProperty(schema: Schema, name: string, where: string): [string, Schema[string]] {
  const want = name.trim().toLowerCase()
  const found = titleFirst(schema).find(([key, s]) => (s.name ?? key).toLowerCase() === want)
  if (!found) {
    throw new Error(`${where}: no property named "${name}". The properties are: ${rowValuesHeader(schema)}.`)
  }
  const { type } = found[1]
  if (type === 'formula' || type === 'rollup') {
    throw new Error(
      `${where}: "${name}" is a ${type}, which Notion computes and this tool can't read, so it can't be used.`,
    )
  }
  return found
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
  return titleFirst(schema)
    .map(([key, s]) => `${s.name ?? key} (${s.type ?? 'text'})`)
    .join(', ')
}

/**
 * A row's value for a property, as compared: plain text, with mentions as names (`@Ann` → `Ann`,
 * `[Spec](…)` → `Spec`, `@2026-11-12` → `2026-11-12`) and no Markdown marks.
 */
function cell(values: { name: string; value: string }[], property: string): string {
  return shownText(values.find((v) => v.name === property)?.value ?? '').trim()
}

/** A number as Notion stores one (`5`, `-1.5`, `2e3`), or undefined for any other text. */
function asNumber(text: string): number | undefined {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : undefined
}

function matches(values: { name: string; value: string }[], f: Filter): boolean {
  const v = cell(values, f.property).toLowerCase()
  const want = f.value.toLowerCase()
  if (
    f.type === 'multi_select' &&
    f.op !== 'is_empty' &&
    f.op !== 'is_not_empty' &&
    f.op !== 'before' &&
    f.op !== 'after'
  ) {
    // Options one by one, so "Bug" doesn't match "Debug". Notion keeps them without spaces around commas.
    const options = new Set(v ? v.split(/\s*,\s*/) : [])
    const wanted = [...new Set(want.split(/\s*,\s*/).filter(Boolean))]
    const exactly = () => wanted.length === options.size && wanted.every((o) => options.has(o))
    switch (f.op) {
      case 'is':
        return exactly()
      case 'is_not':
        return !exactly()
      case 'contains':
        return wanted.every((o) => options.has(o))
      case 'not_contains':
        return !wanted.some((o) => options.has(o))
    }
  }
  const [a, b] = [asNumber(v), asNumber(want)]
  const numbers = a !== undefined && b !== undefined
  // A bare date asks about a day: a cell with a time or a range matches by the day it starts on.
  // A number property's values compare by value: 5 is 5.0.
  const same = () =>
    f.type === 'number' && numbers ? a === b : /^\d{4}-\d{2}-\d{2}$/.test(want) ? day(v) === want : v === want
  // Numbers compare as numbers, dates by the day they start on, other text as text.
  const order = () => (numbers ? Math.sign(a - b) : day(v) < day(want) ? -1 : day(v) > day(want) ? 1 : 0)
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

/** A value's leading YYYY-MM-DD when it starts with one, else the value. */
function day(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value
}

/** A date as YYYY-MM-DD in the browser's time zone. */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** A page title on one line, as Notion keeps it, so it can't break up the preview's lines. */
function titleArg(value: string): string {
  return oneLine(plainText(value))
}

const DATABASE_PARENT = '`parent` is required: the URL or id of the page to create it in.'

/** Refusals from planning schema changes, for the model; anything else is passed on. */
function schemaRefusal(err: unknown): never {
  if (err instanceof SchemaError) throw new EditError(err.message)
  throw err
}

export const createDatabase = defineTool({
  changesData: true,
  name: 'create_database',
  description:
    "Creates a Notion database (a table) as a page at the end of `parent`, a page (the open page's URL, or " +
    'another page): a title column (`title_property`, "Name" if left out), then `properties` in order, with ' +
    "options for selects. Add rows afterwards with create_page. Returns the new database's id and URL.",
  touched: (_args, result) => ({ changed: idIn(result, /^Created the database “.*” \^([0-9a-f]{32}) /) }),
  describe: (args) => {
    const name = args?.title.trim()
    return name ? { verb: CREATE, what: 'the database', name } : { verb: CREATE, what: 'a database' }
  },
  args: z.strictObject({
    parent: z.string({ error: DATABASE_PARENT }).describe('URL or id of the page to create it in.'),
    title: z.string({ error: TITLE_EMPTY }).describe(`The database's name. ${BACKSLASH}`),
    title_property: z
      .string({ error: 'The title column must not be empty.' })
      .describe('The name of the title column. Default: Name.')
      .optional(),
    properties: z
      .array(PROPERTY_SPEC, { error: '`properties` must be a list of properties.' })
      .max(SCHEMA_MAX, { error: `A database can be created with at most ${SCHEMA_MAX} properties.` })
      .optional(),
  }),
  preview: (args) => {
    const given = args.parent.trim()
    const id = given ? pageArg(given) : undefined
    const known = id ? lastRead(id)?.title : undefined
    const parent = id ? `${known ? `${oneLine(known)} ` : ''}^${hexId(id)}` : given || '(none given)'
    const titleColumn = args.title_property === undefined ? '' : titleArg(args.title_property)
    return [
      'Create a database',
      `Title: ${titleArg(args.title)}`,
      `At the end of: ${parent}`,
      'Properties:',
      `    ${titleColumn || 'Name'} (title)`,
      ...(args.properties ?? []).map((p) => {
        const options = p.options ? `: ${p.options.map((o) => oneLine(o)).join(', ')}` : ''
        return `    ${titleArg(p.name)} (${p.type.replace(/_/g, ' ')}${options})`
      }),
    ].join('\n')
  },
  run: async (args, signal) => {
    const title = titleArg(args.title)
    if (!title) throw new Error(TITLE_EMPTY)
    const given = args.parent.trim()
    if (!given) throw new Error(DATABASE_PARENT)
    const parentId = pageArg(given)
    if (!parentId) throw new Error(`Not a Notion page URL or id: ${given}`)
    let schema: Schema
    try {
      schema = newSchema(args.title_property, args.properties)
    } catch (err) {
      schemaRefusal(err)
    }
    const tab = await activeNotionTab()
    const parent = (await tab.client.getRecords([{ table: 'block', id: parentId }])).block![parentId]
    if (parent.type === 'collection_view_page' || parent.type === 'collection_view')
      throw new EditError('That parent is a database: give a page. (To add a row to it, use create_page.)')
    if (parent.type !== 'page') throw new EditError('That id is a block inside a page, not a page.')
    const spaceId = parent.space_id
    if (typeof spaceId !== 'string' || !spaceId)
      throw new NotionError('notion_error', 'Notion returned the page without its workspace.')
    const ids = { page: crypto.randomUUID(), collection: crypto.randomUUID(), view: crypto.randomUUID() }
    const op = blockOps(spaceId, Date.now(), tab.client.userId)
    const operations = [
      ...op.createDatabase(ids, title, schema, parentId),
      op.listAfter(parentId, ids.page),
      op.touch(parentId),
    ]
    signal?.throwIfAborted()
    try {
      await tab.client.submitTransaction(spaceId, operations, 'Notico: create_database')
    } catch (err) {
      // A retry would create a second database if this one was saved: the agent must look first.
      if (err instanceof NotionError && err.code === 'outcome_unknown') {
        forgetRead(parentId)
        throw new NotionError(
          'outcome_unknown',
          `Notion did not confirm it, so the database may or may not have been created. Read ^${hexId(parentId)} ` +
            `and check for “${title}” before trying again.`,
          { cause: err, stopsQuestion: err.stopsQuestion },
        )
      }
      throw err
    } finally {
      forgetLoads(parentId)
    }
    keepSeenDatabase(ids.page, title)
    const hex = hexId(ids.page)
    return [
      `Created the database “${title}” ^${hex} at the end of ^${hexId(parentId)}.`,
      `Properties: ${rowValuesHeader(schema)}`,
      `URL: ${pageLink(tab.url, hex)}`,
    ].join('\n')
  },
})

const CHANGES_LIST = '`changes` must be a list with at least one change.'

export const updateDatabaseSchema = defineTool({
  changesData: true,
  name: 'update_database_schema',
  description:
    "Changes a Notion database's properties, in order, in one change: add_property (with `type`, and " +
    '`options` for selects), rename_property (`to`), add_options, rename_option (`option`, `to`; every row ' +
    'that has it is renamed too), remove_option, and remove_property. Removing a property or an option ' +
    'loses its values in every row: remove one only when the user asked to remove exactly it. A property ' +
    "can't change its type, and status options can't be changed. Give the database by id or URL, or leave it " +
    'out when the open page is a database. Nothing changes if any change is refused.',
  touched: (_args, result) => ({ changed: idIn(result, /^Changed the properties of “.*” \^([0-9a-f]{32}):(?:\n|$)/) }),
  describe: (_args, result) =>
    on(
      CHANGE,
      named(result, /^Changed the properties of “(.+)” \^[0-9a-f]+:(?:\n|$)/),
      'a database',
      'the properties of',
    ),
  args: z.strictObject({
    database: z.string().describe('Id or URL of the database. Leave out for the open page.').optional(),
    changes: z
      .array(CHANGE_ARG, { error: CHANGES_LIST })
      .min(1, { error: CHANGES_LIST })
      .max(SCHEMA_MAX, { error: `At most ${SCHEMA_MAX} changes can be made in one call.` }),
  }),
  preview: ({ database, changes }) => {
    const given = database?.trim() ?? ''
    const id = given ? pageArg(given) : undefined
    const known = id ? seenDatabase(id) : undefined
    const name = (v: string | undefined) => `“${titleArg(v ?? '')}”`
    const list = (v: string[] | undefined) => (v ?? []).map((o) => oneLine(o)).join(', ')
    return [
      `Change the properties of ${id ? `${known ? `${oneLine(known)} ` : ''}^${hexId(id)}` : given ? oneLine(given) : 'the open database'}`,
      ...changes.map((c) => {
        switch (c.action) {
          case 'add_property':
            return `    Add the property ${name(c.property)} (${(c.type ?? '').replace(/_/g, ' ')}${c.options ? `: ${list(c.options)}` : ''})`
          case 'rename_property':
            return `    Rename the property ${name(c.property)} to ${name(c.to)}`
          case 'remove_property':
            return `    Remove the property ${name(c.property)}: its values in every row are lost`
          case 'add_options':
            return `    Add options to ${name(c.property)}: ${list(c.options)}`
          case 'rename_option':
            return `    Rename the option ${name(c.option)} of ${name(c.property)} to ${name(c.to)}, in every row that has it`
          case 'remove_option':
            return `    Remove the option ${name(c.option)} of ${name(c.property)}: rows that have it lose it`
        }
      }),
    ].join('\n')
  },
  run: async (args, signal) => {
    let changes
    try {
      changes = parseChanges(args.changes)
    } catch (err) {
      schemaRefusal(err)
    }
    const given = filled(args.database)
    if (!given) await needsAttachedPage()
    const tab = await activeNotionTab()
    const id = given ? pageArg(given) : tab.pageId
    if (given && !id) throw new Error(`Not a Notion database URL or id: ${given}`)
    if (!id) throw new Error('Give `database`: the open tab does not show a page.')
    const block = (await tab.client.getRecords([{ table: 'block', id }])).block![id]
    if (block.type !== 'collection_view_page' && block.type !== 'collection_view')
      throw new EditError(given ? 'That is not a database.' : 'The open page is not a database. Give `database`.')
    const db = await resolveDatabase(tab.client, block)
    let plan
    try {
      plan = planSchemaChanges(db.spaceId, db.collectionId, db.schema, changes, tab.client.userId)
    } catch (err) {
      schemaRefusal(err)
    }
    const operations = [...plan.operations]
    let renamedRows: string[] = []
    if (plan.renames.length) {
      // Rows keep an option's text: every row that has a renamed option is renamed with it, or the
      // ones left out would lose their value. So every row must be read first.
      const viewId = db.views[0]
      if (!viewId)
        throw new EditError("This database's rows can't be read (it has no view), so its options can't be renamed.")
      const { rowIds, hasMore, recordMap } = await tab.client.queryCollection(
        db.collectionId,
        viewId,
        db.spaceId,
        QUERY_LOAD,
      )
      if (hasMore)
        throw new EditError(
          `This database has more than ${QUERY_LOAD} rows, so not every row that has the option can be renamed with it. ` +
            'Nothing was changed; the user can rename the option in Notion.',
        )
      let rows
      try {
        rows = renameInRows(db.spaceId, rowIds, recordMap, plan.renames, tab.client.userId)
      } catch (err) {
        schemaRefusal(err)
      }
      operations.push(...rows.operations)
      renamedRows = rows.rows
    }
    signal?.throwIfAborted()
    try {
      await tab.client.submitTransaction(db.spaceId, operations, 'Notico: update_database_schema')
    } catch (err) {
      // A retry would add a property a second time if this change was saved: the agent must look first.
      if (err instanceof NotionError && err.code === 'outcome_unknown')
        throw new NotionError(
          'outcome_unknown',
          'Notion did not confirm it, so the properties may or may not have changed. Query ' +
            `^${hexId(id)} to see its properties before trying again.`,
          { cause: err, stopsQuestion: err.stopsQuestion },
        )
      throw err
    } finally {
      // Reads of the database and its rows show the old properties.
      forgetLoads(id)
      for (const row of renamedRows) forgetSeenRow(row)
    }
    return [
      `Changed the properties of “${db.name}” ^${hexId(id)}:`,
      ...plan.lines,
      ...(plan.renames.length ? [`Rows renamed with their options: ${renamedRows.length}.`] : []),
      `Properties now: ${rowValuesHeader(plan.schema)}`,
    ].join('\n')
  },
})
