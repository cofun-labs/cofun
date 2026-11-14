// The query_database tool (extensions/notico/src/tools/database.ts) against a fake Notion tab answering in the
// shapes Notion's syncRecordValuesMain and queryCollection return (see the #64 spike).
import { afterEach, describe, expect, it } from 'vitest'
import { QUERY_LOAD, QUERY_PART, localDate, queryDatabase } from '../src/tools/database'
import { FakeNotionTab, PAGE_URL, SPACE, USER, restoreGlobals } from './notion-tab'

afterEach(restoreGlobals)

const hex = (id: string) => id.replace(/-/g, '')
const DB = 'db0db0db-0000-4000-8000-000000000001'
const COLLECTION = 'c0c0c0c0-0000-4000-8000-000000000001'
const VIEW = 'e0e0e0e0-0000-4000-8000-000000000001'
const row = (n: number) => `a1a1a1a1-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

function wrapped(record: Record<string, unknown>) {
  return { spaceId: SPACE, value: { role: 'editor', value: { version: 1, alive: true, space_id: SPACE, ...record } } }
}
const sync = (table: string, records: Record<string, unknown>[]) => ({
  recordMap: { __version__: 3, [table]: Object.fromEntries(records.map((r) => [r.id, wrapped(r)])) },
})

const SCHEMA = {
  title: { name: 'Task', type: 'title' },
  'a:a': { name: 'Status', type: 'status' },
  'b:b': { name: 'Due', type: 'date' },
  'c:c': { name: 'Owner', type: 'person' },
  'd:d': { name: 'Points', type: 'number' },
  'e:e': { name: 'Done', type: 'checkbox' },
}
const date = (d: string) => [['‣', [['d', { type: 'date', start_date: d }]]]]
const TASKS = [
  { n: 1, task: 'Write docs', status: 'Done', due: '2026-11-05', points: '3', done: 'Yes' },
  { n: 2, task: 'Fix login | Safari', status: 'In progress', due: '2026-11-07', points: '5', done: 'No' },
  { n: 3, task: 'Ship beta', status: 'Not started', due: '2026-11-20', points: '8', done: 'No' },
  { n: 4, task: 'Plan retro', status: 'Not started', due: '', points: '1', done: 'No' },
]
function rowRecord(t: (typeof TASKS)[number]) {
  return {
    id: row(t.n),
    type: 'page',
    parent_id: COLLECTION,
    parent_table: 'collection',
    properties: {
      title: [[t.task]],
      'a:a': [[t.status]],
      ...(t.due ? { 'b:b': date(t.due) } : {}),
      'c:c': [['‣', [['u', USER]]]],
      'd:d': [[t.points]],
      'e:e': [[t.done]],
    },
  }
}

/**
 * A database whose view lists `rows`, and `unsent` ids whose records the response leaves out; the
 * rows' person is named `userName`.
 */
function database(
  rows = TASKS.map(rowRecord),
  hasMore = false,
  schema: Record<string, unknown> = SCHEMA,
  unsent: string[] = [],
  userName = 'Fixture User',
) {
  return new FakeNotionTab(`https://app.notion.com/${hex(DB)}?v=${hex(VIEW)}`)
    .respond(
      'syncRecordValuesMain',
      200,
      sync('block', [{ id: DB, type: 'collection_view_page', collection_id: COLLECTION, view_ids: [VIEW] }]),
    )
    .respond('syncRecordValuesMain', 200, sync('collection', [{ id: COLLECTION, name: [['Tasks']], schema }]))
    .respond('queryCollection', 200, {
      result: {
        reducerResults: {
          collection_group_results: { type: 'results', blockIds: [...rows.map((r) => r.id), ...unsent], hasMore },
        },
      },
      recordMap: {
        __version__: 3,
        block: Object.fromEntries(rows.map((r) => [r.id, wrapped(r)])),
        notion_user: { [USER]: wrapped({ id: USER, name: userName }) },
      },
    })
    .install()
}

const query = async (args: Record<string, unknown> = {}) => (await queryDatabase.run(args)) as string
const tableRows = (result: string) =>
  result.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Task | Status |') && !l.startsWith('| ---'))
const today = localDate(new Date())

describe('UC-NOTICO-NOTION-006 read a database', () => {
  it('[UC-NOTICO-NOTION-006-S01] reads the open database: its properties, and each row with its values and id', async () => {
    const tab = database()
    expect(await query()).toBe(
      [
        `Database: Tasks ^${hex(DB)}`,
        `Today: ${today}`,
        'Properties: Task (title), Status (status), Due (date), Owner (person), Points (number), Done (checkbox)',
        'Rows: 4 (showing 1–4).',
        '',
        '| Task | Status | Due | Owner | Points | Done | Row |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        `| Write docs | Done | @2026-11-05 | @[Fixture User] | 3 | Yes | ^${hex(row(1))} |`,
        `| Fix login \\| Safari | In progress | @2026-11-07 | @[Fixture User] | 5 | No | ^${hex(row(2))} |`,
        `| Ship beta | Not started | @2026-11-20 | @[Fixture User] | 8 | No | ^${hex(row(3))} |`,
        `| Plan retro | Not started |  | @[Fixture User] | 1 | No | ^${hex(row(4))} |`,
      ].join('\n'),
    )
    // The rows came from the database's view, as the tab's Notion user.
    expect(tab.sent.at(-1)!.body).toMatchObject({
      source: { type: 'collection', id: COLLECTION, spaceId: SPACE },
      collectionView: { id: VIEW, spaceId: SPACE },
      loader: { reducers: { collection_group_results: { type: 'results', limit: QUERY_LOAD } } },
    })
  })

  it('[UC-NOTICO-NOTION-006-S02] keeps only the rows that match every condition, in the asked order', async () => {
    database()
    const result = await query({
      database: hex(DB),
      filter: [
        { property: 'due', op: 'before', value: '2026-11-10' },
        { property: 'Status', op: 'is_not', value: 'done' },
      ],
      sort: { property: 'Points', direction: 'descending' },
    })
    expect(result).toContain('Matching rows: 1 (showing 1–1).')
    expect(tableRows(result)).toEqual([
      `| Fix login \\| Safari | In progress | @2026-11-07 | @[Fixture User] | 5 | No | ^${hex(row(2))} |`,
    ])

    // Against the text as Notion shows it, not as escaped for Markdown.
    database()
    const piped = await query({ filter: [{ property: 'Task', op: 'is', value: 'fix login | safari' }] })
    expect(tableRows(piped).map((l) => l.split(' | ')[0])).toEqual(['| Fix login \\| Safari'])
    database()
    const empty = await query({ filter: [{ property: 'Due', op: 'is_empty' }] })
    expect(tableRows(empty).map((l) => l.split(' | ')[0])).toEqual(['| Plan retro'])
  })

  it('[UC-NOTICO-NOTION-006-S02] has Notion order the rows, and keeps its order', async () => {
    const titles = (result: string) => tableRows(result).map((l) => l.split(' | ')[0].slice(2))
    // Notion answers with the rows sorted (by due date, descending; empty last).
    const tab = database([TASKS[2], TASKS[1], TASKS[0], TASKS[3]].map(rowRecord))
    expect(titles(await query({ sort: { property: 'Due', direction: 'descending' } }))).toEqual([
      'Ship beta',
      'Fix login \\| Safari',
      'Write docs',
      'Plan retro',
    ])
    expect(tab.sent.at(-1)!.body).toMatchObject({ loader: { sort: [{ property: 'b:b', direction: 'descending' }] } })
  })

  it('[UC-NOTICO-NOTION-006-S03] reads many rows part by part, and says when there are more than it read', async () => {
    const many = Array.from({ length: QUERY_PART + 10 }, (_, i) =>
      rowRecord({ ...TASKS[0], n: 100 + i, task: `Task ${i}` }),
    )
    database(many, true)
    const first = await query()
    expect(first).toContain(`Rows: ${QUERY_PART + 10} (showing 1–${QUERY_PART}). Read part 2 for more.`)
    expect(first).toContain(`Only the first ${QUERY_LOAD} rows of the database were read; filters apply to those.`)
    expect(tableRows(first)).toHaveLength(QUERY_PART)
    database(many, true)
    const second = await query({ part: 2 })
    expect(tableRows(second)).toHaveLength(10)
    expect(second).toContain('This part comes from a new read of the database')
  })

  it('[UC-NOTICO-NOTION-006-S05] with more rows than one read loads, asks Notion for the order, so the rows read come first in it', async () => {
    const tab = database(TASKS.map(rowRecord), true)
    const result = await query({ sort: { property: 'points', direction: 'descending' } })
    expect(tab.sent.at(-1)!.body).toMatchObject({
      loader: { sort: [{ property: 'd:d', direction: 'descending' }] },
    })
    expect(result).toContain(
      `Only the first ${QUERY_LOAD} rows of the database by Points (descending) were read; filters apply to those.`,
    )
    // The rows read stay in Notion's order (here, as the fake lists them), which chose them.
    expect(tableRows(result).map((l) => l.split(' | ')[4])).toEqual(TASKS.map((t) => t.points))
    // Without a sort, Notion's own order.
    const plain = database()
    await query()
    expect(plain.sent.at(-1)!.body).toMatchObject({ loader: { sort: [] } })
  })
})

describe('query_database values', () => {
  it('compares people by name, and shows a checkbox never ticked as No', async () => {
    const rows = TASKS.map(rowRecord)
    delete (rows[3].properties as Record<string, unknown>)['e:e']
    database(rows)
    const result = await query({
      filter: [
        { property: 'Owner', op: 'is', value: 'fixture user' },
        { property: 'Done', op: 'is', value: 'No' },
      ],
    })
    expect(tableRows(result)).toHaveLength(3)
  })

  it('refuses to filter or sort by a formula, which it cannot read', async () => {
    const tab = new FakeNotionTab(`https://app.notion.com/${hex(DB)}`)
      .respond(
        'syncRecordValuesMain',
        200,
        sync('block', [{ id: DB, type: 'collection_view_page', collection_id: COLLECTION, view_ids: [VIEW] }]),
      )
      .respond(
        'syncRecordValuesMain',
        200,
        sync('collection', [
          { id: COLLECTION, name: [['Tasks']], schema: { ...SCHEMA, 'f:f': { name: 'Score', type: 'formula' } } },
        ]),
      )
      .install()
    await expect(query({ filter: [{ property: 'Score', op: 'is_empty' }] })).rejects.toThrow('"Score" is a formula')
    expect(tab.sent.map((r) => r.url.split('/api/v3/')[1])).not.toContain('queryCollection')
  })

  it('reads the view the URL names', async () => {
    const other = 'e0e0e0e0-0000-4000-8000-000000000002'
    const tab = new FakeNotionTab(`https://app.notion.com/${hex(DB)}?v=${hex(other)}`)
      .respond(
        'syncRecordValuesMain',
        200,
        sync('block', [{ id: DB, type: 'collection_view_page', collection_id: COLLECTION, view_ids: [VIEW, other] }]),
      )
      .respond('syncRecordValuesMain', 200, sync('collection', [{ id: COLLECTION, name: [['Tasks']], schema: SCHEMA }]))
      .respond('queryCollection', 200, {
        result: { reducerResults: { collection_group_results: { blockIds: [] } } },
        recordMap: {},
      })
      .install()
    await query()
    expect(tab.sent.at(-1)!.body).toMatchObject({ collectionView: { id: other } })
  })
})

describe('query_database arguments', () => {
  it('names the properties when a filter or sort names one that does not exist', async () => {
    database()
    await expect(query({ filter: [{ property: 'Priority', op: 'is', value: 'High' }] })).rejects.toThrow(
      'Filter 1: no property named "Priority". The properties are: Task (title), Status (status)',
    )
    database()
    await expect(query({ filter: [{ property: 'Status', op: 'like', value: 'x' }] })).rejects.toThrow(
      '`op` must be one of',
    )
    database()
    await expect(query({ filter: [{ property: 'Status', op: 'is' }] })).rejects.toThrow('Filter 1 needs `value`.')
  })

  it('refuses arguments that are not what its schema says, without asking Notion', async () => {
    const tab = database()
    await expect(query({ part: 0 })).rejects.toThrow('`part` must be a whole number from 1.')
    await expect(query({ part: 1.5 })).rejects.toThrow('`part` must be a whole number from 1.')
    await expect(query({ filter: 'Status is Done' })).rejects.toThrow('`filter` must be a list of conditions.')
    await expect(query({ filter: [{ property: 'Status', op: 'is' }, { property: 'Status' }] })).rejects.toThrow(
      'Filter 2: `op` must be one of is, is_not, contains, not_contains, is_empty, is_not_empty, before, after.',
    )
    await expect(query({ filter: [{ op: 'is_empty' }] })).rejects.toThrow(
      "Filter 1 needs `property`: a property's name.",
    )
    await expect(query({ filter: [{ property: 'Status', op: 'is', value: 5 }] })).rejects.toThrow(
      'Filter 1: `value` must be text.',
    )
    await expect(query({ sort: { direction: 'descending' } })).rejects.toThrow(
      '`sort.property`: Invalid input: expected string, received undefined',
    )
    await expect(query({ sort: { property: 'Status', direction: 'down' } })).rejects.toThrow(
      '`sort.direction`: Invalid option: expected one of "ascending"|"descending"',
    )
    await expect(query({ database: 5 })).rejects.toThrow('`database`: Invalid input: expected string, received number')
    await expect(query({ limit: 10 })).rejects.toThrow('Unrecognized key: "limit"')
    // An argument inside a list is named as the model would write it.
    await expect(query({ filter: [{ property: 'Status', op: 'is_empty', values: 'x' }] })).rejects.toThrow(
      '`filter[0]`: Unrecognized key: "values"',
    )
    // Everything wrong with a call is said at once.
    await expect(query({ part: 0, sort: {} })).rejects.toThrow(
      '`sort.property`: Invalid input: expected string, received undefined\n`part` must be a whole number from 1.',
    )
    expect(tab.sent).toEqual([])
  })

  it('tells the model its arguments as before', () => {
    expect(queryDatabase.parameters).toEqual({
      type: 'object',
      properties: {
        database: { type: 'string', description: 'Id or URL of the database. Leave out for the open page.' },
        filter: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              property: { type: 'string', description: 'Property name, as the result lists it.' },
              op: {
                type: 'string',
                enum: ['is', 'is_not', 'contains', 'not_contains', 'is_empty', 'is_not_empty', 'before', 'after'],
              },
              value: {
                type: 'string',
                description: 'What to compare with; not needed for is_empty and is_not_empty.',
              },
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
    })
  })

  it('says when the page is not a database', async () => {
    new FakeNotionTab(PAGE_URL)
      .respond(
        'syncRecordValuesMain',
        200,
        sync('block', [{ id: '1a1a1a1a-0000-4000-8000-000000000010', type: 'page' }]),
      )
      .install()
    await expect(query()).rejects.toThrow(
      "The open page is not a database. Give `database`: a database inside a page has its id in read_page's result.",
    )
  })
})

describe('query_database open page', () => {
  it('reads the database under a row open in side peek', async () => {
    const tab = new FakeNotionTab(`https://app.notion.com/${hex(DB)}?v=${hex(VIEW)}&p=${hex(row(1))}`)
      .respond('syncRecordValuesMain', 200, sync('block', [rowRecord(TASKS[0])]))
      .respond(
        'syncRecordValuesMain',
        200,
        sync('block', [{ id: DB, type: 'collection_view_page', collection_id: COLLECTION, view_ids: [VIEW] }]),
      )
      .respond('syncRecordValuesMain', 200, sync('collection', [{ id: COLLECTION, name: [['Tasks']], schema: SCHEMA }]))
      .respond('queryCollection', 200, {
        result: { reducerResults: { collection_group_results: { blockIds: [] } } },
        recordMap: {},
      })
      .install()
    const result = await query()
    expect(result).toContain(`Database: Tasks ^${hex(DB)}`)
    // The side panel counts what the call touched from this result.
    expect(queryDatabase.touched({}, result)).toEqual({ read: [hex(DB)] })
    expect(tab.sent.at(-1)!.body).toMatchObject({ collectionView: { id: VIEW } })
  })

  it('counts rows Notion listed without their values', async () => {
    database(TASKS.map(rowRecord), false, SCHEMA, [row(99)])
    const result = await query()
    expect(result).toContain('Rows: 4 (showing 1–4).')
    expect(result).toContain('1 more row came without its values and is not shown.')
  })
})

describe('query_database dates and headers', () => {
  it('compares dates with a time by their day', async () => {
    const rows = TASKS.map(rowRecord)
    ;(rows[0].properties as Record<string, unknown>)['b:b'] = [
      ['‣', [['d', { type: 'datetime', start_date: '2026-11-07', start_time: '10:00' }]]],
    ]
    database(rows)
    const result = await query({ filter: [{ property: 'Due', op: 'after', value: '2026-11-07' }] })
    expect(tableRows(result).map((l) => l.split(' | ')[0].slice(2))).toEqual(['Ship beta'])
    // A bare date is a day: the row with a time on that day matches too.
    database(rows)
    const onDay = await query({ filter: [{ property: 'Due', op: 'is', value: '2026-11-07' }] })
    expect(tableRows(onDay).map((l) => l.split(' | ')[0].slice(2))).toEqual(['Write docs', 'Fix login \\| Safari'])
  })
})

describe('query_database options, numbers, and code', () => {
  const TAGGED = { ...SCHEMA, 'g:g': { name: 'Tags', type: 'multi_select' }, 'h:h': { name: 'Notes', type: 'text' } }
  const tagged = (tags: string[], notes: unknown[] = []) =>
    TASKS.map((t, i) => {
      const r = rowRecord(t)
      Object.assign(r.properties, { ...(tags[i] ? { 'g:g': [[tags[i]]] } : {}), 'h:h': notes[i] ?? [] })
      return r
    })
  const titles = (result: string) => tableRows(result).map((l) => l.split(' | ')[0].slice(2))

  it('matches multi-select options one by one', async () => {
    const tags = ['Bug', 'Debug,UI', 'Bug,UI', '']
    database(tagged(tags), false, TAGGED)
    expect(titles(await query({ filter: [{ property: 'Tags', op: 'contains', value: 'bug' }] }))).toEqual([
      'Write docs',
      'Ship beta',
    ])
    database(tagged(tags), false, TAGGED)
    expect(titles(await query({ filter: [{ property: 'Tags', op: 'contains', value: 'UI, Bug' }] }))).toEqual([
      'Ship beta',
    ])
    database(tagged(tags), false, TAGGED)
    expect(titles(await query({ filter: [{ property: 'Tags', op: 'is', value: 'Bug' }] }))).toEqual(['Write docs'])
    database(tagged(tags), false, TAGGED)
    expect(titles(await query({ filter: [{ property: 'Tags', op: 'not_contains', value: 'Bug' }] }))).toEqual([
      'Fix login \\| Safari',
      'Plan retro',
    ])
  })

  it('compares a number property by value in is and is_not', async () => {
    database()
    expect(titles(await query({ filter: [{ property: 'Points', op: 'is', value: '5.0' }] }))).toEqual([
      'Fix login \\| Safari',
    ])
    database()
    expect(tableRows(await query({ filter: [{ property: 'Points', op: 'is_not', value: '5.00' }] }))).toHaveLength(3)
  })

  it('keeps backslashes in code when filtering, and keeps a code cell with a pipe in one cell', async () => {
    const notes = [[['C:\\temp', [['c']]]], [['a\\|b', [['c']]]], [['C:temp']]]
    database(tagged([], notes), false, TAGGED)
    expect(titles(await query({ filter: [{ property: 'Notes', op: 'is', value: 'C:\\temp' }] }))).toEqual([
      'Write docs',
    ])
    database(tagged([], notes), false, TAGGED)
    const result = await query({ filter: [{ property: 'Notes', op: 'contains', value: '|' }] })
    const [line] = tableRows(result)
    // Every pipe in the code is escaped, so the cell holds the code as it is: one cell, not two.
    expect(line).toContain(' | `a\\\\|b` | ')
    const cells = (l: string) => l.split(/(?<!\\)\|/).length
    expect(cells(line)).toBe(cells(result.split('\n').find((l) => l.startsWith('| Task |'))!))
  })

  it('keeps a mentioned page or a link with a pipe in one cell', async () => {
    // The row's notes mention the row titled "Fix login | Safari", and link to a URL with a pipe,
    // once as text and once as code.
    const notes = [
      [
        ['‣', [['p', row(2)]]],
        [' and '],
        ['spec', [['a', 'https://example.com/a|b']]],
        [' '],
        ['a|b', [['c'], ['a', 'https://example.com/c|d']]],
      ],
    ]
    database(tagged([], notes), false, TAGGED)
    const result = await query({ filter: [{ property: 'Notes', op: 'contains', value: 'safari' }] })
    const [line] = tableRows(result)
    expect(line).toContain(
      `[Fix login \\| Safari](${hex(row(2))}) and [spec](https://example.com/a\\|b) ` +
        '[`a\\|b`](https://example.com/c\\|d)',
    )
    const cells = (l: string) => l.split(/(?<!\\)\|/).length
    expect(cells(line)).toBe(cells(result.split('\n').find((l) => l.startsWith('| Task |'))!))
  })

  it('compares a mentioned page by its title, brackets and backslashes included', async () => {
    // Rows 2 and 4 mention rows 1 and 3, whose titles hold `]` and `\`.
    const rows = tagged([], [[], [['‣', [['p', row(1)]]]], [], [['‣', [['p', row(3)]]]]])
    rows[0].properties.title = [['[WIP] Plan']]
    rows[2].properties.title = [['C:\\temp']]
    database(rows, false, TAGGED)
    expect(titles(await query({ filter: [{ property: 'Notes', op: 'is', value: '[WIP] Plan' }] }))).toEqual([
      'Fix login \\| Safari',
    ])
    database(rows, false, TAGGED)
    expect(titles(await query({ filter: [{ property: 'Notes', op: 'is', value: 'C:\\temp' }] }))).toEqual([
      'Plan retro',
    ])
  })

  it('compares colored text and equations as Notion shows them, and prices as text', async () => {
    const notes = [[['Urgent', [['h', 'red']]]], [['Costs 5$ and 6$ total']], [['⁍', [['e', 'a*b']]]], []]
    const filter = async (value: string) => {
      database(tagged([], notes), false, TAGGED)
      return titles(await query({ filter: [{ property: 'Notes', op: 'is', value }] }))
    }
    expect(await filter('urgent')).toEqual(['Write docs'])
    expect(await filter('Costs 5$ and 6$ total')).toEqual(['Fix login \\| Safari'])
    expect(await filter('a*b')).toEqual(['Ship beta'])
  })

  it('[UC-NOTICO-NOTION-006-S06] shows a status never set as the database’s default, and filters by it', async () => {
    const options = ['Not started', 'In progress', 'Done'].map((value) => ({ value }))
    const schema = { ...SCHEMA, 'a:a': { name: 'Status', type: 'status', options, defaultOption: 'Not started' } }
    const rows = TASKS.map(rowRecord)
    delete (rows[3].properties as Record<string, unknown>)['a:a']
    database(rows, false, schema)
    expect(tableRows(await query())[3]).toContain('| Plan retro | Not started |')
    database(rows, false, schema)
    expect(titles(await query({ filter: [{ property: 'Status', op: 'is', value: 'Not started' }] }))).toEqual([
      'Ship beta',
      'Plan retro',
    ])
    // A default that isn't one of the options is not shown.
    database(rows, false, { ...schema, 'a:a': { ...schema['a:a'], defaultOption: 'Gone' } })
    expect(tableRows(await query())[3]).toContain('| Plan retro |  |')
  })

  it('[UC-NOTICO-NOTION-006-S07] shows a relation by the titles of its pages, looked up when the result leaves them out', async () => {
    const REVIEW = 'b1b1b1b1-0000-4000-8000-000000000050'
    const schema = { ...SCHEMA, 'r:r': { name: 'Blocked by', type: 'relation' } }
    const rows = TASKS.map(rowRecord)
    Object.assign(rows[0].properties, { 'r:r': [['‣', [['p', REVIEW]]]] })
    const review = sync('block', [{ id: REVIEW, type: 'page', properties: { title: [['Design review']] } }])
    const tab = database(rows, false, schema).respond('syncRecordValuesMain', 200, review)
    expect(tableRows(await query())[0]).toContain(`| [Design review](${hex(REVIEW)}) |`)
    // One lookup, for the page the result left out.
    expect(tab.sent.at(-1)!.body).toMatchObject({ requests: [{ pointer: { table: 'block', id: REVIEW } }] })
    database(rows, false, schema).respond('syncRecordValuesMain', 200, review)
    expect(titles(await query({ filter: [{ property: 'Blocked by', op: 'is', value: 'design review' }] }))).toEqual([
      'Write docs',
    ])
    // A page the account can't open stays unnamed; the rows still read.
    database(rows, false, schema).respond('syncRecordValuesMain', 403, {})
    expect(tableRows(await query())[0]).toContain(`| [page](${hex(REVIEW)}) |`)
    // Notion turning the lookup away still stops the read.
    database(rows, false, schema).limit('syncRecordValuesMain', 1)
    await expect(query()).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('looks up linked pages before people, and says when some were left unnamed', async () => {
    // More linked pages than one lookup takes: the first ones are named, and the result says so.
    const linked = Array.from({ length: 103 }, (_, i) => `b2b2b2b2-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const schema = { ...SCHEMA, 'r:r': { name: 'Blocked by', type: 'relation' } }
    const rows = TASKS.map(rowRecord)
    Object.assign(rows[0].properties, {
      'c:c': [['‣', [['u', 'f0f0f0f0-0000-4000-8000-000000000099']]]],
      'r:r': linked.map((id) => ['‣', [['p', id]]]),
    })
    const found = sync(
      'block',
      linked.slice(0, 100).map((id, i) => ({ id, type: 'page', properties: { title: [[`P${i}`]] } })),
    )
    const tab = database(rows, false, schema).respond('syncRecordValuesMain', 200, found)
    const result = await query()
    const asked = (tab.sent.at(-1)!.body as { requests: { pointer: { table: string } }[] }).requests
    expect(asked).toHaveLength(100)
    expect(asked.every((r) => r.pointer.table === 'block')).toBe(true)
    expect(result).toContain(
      '4 more linked pages or people were not looked up and show unnamed; filters on their names may miss rows.',
    )
    expect(tableRows(result)[0]).toContain(`[P0](${hex(linked[0])})`)
  })

  it('keeps a person with a pipe in the name in one cell', async () => {
    const rows = TASKS.map((t) => ({ ...rowRecord(t), created_by_id: USER }))
    database(rows, false, { ...SCHEMA, 'i:i': { name: 'Creator', type: 'created_by' } }, [], 'Ana\\ | Ops')
    const result = await query()
    const [line] = tableRows(result)
    // The person property (a mention) and the creator (kept on the row) both escape it, and the
    // backslash before it, which would otherwise undo the pipe's escape.
    expect(line).toContain('| @[Ana\\\\ \\| Ops] | 3 | Yes | @[Ana\\\\ \\| Ops] |')
    // A filter still compares the name as Notion shows it.
    database(rows, false, { ...SCHEMA, 'i:i': { name: 'Creator', type: 'created_by' } }, [], 'Ana\\ | Ops')
    const byName = await query({ filter: [{ property: 'Creator', op: 'is', value: 'ana\\ | ops' }] })
    expect(tableRows(byName)).toHaveLength(4)
    const cells = (l: string) => l.split(/(?<!\\)\|/).length
    expect(cells(line)).toBe(cells(result.split('\n').find((l) => l.startsWith('| Task |'))!))
  })

  it('needs at least one option in a multi-select value', async () => {
    database(tagged([]), false, TAGGED)
    await expect(query({ filter: [{ property: 'Tags', op: 'contains', value: ' , ' }] })).rejects.toThrow(
      'Filter 1 needs `value`.',
    )
  })

  it('escapes a pipe in a property name in the table header', async () => {
    database(TASKS.map(rowRecord), false, { ...SCHEMA, 'd:d': { name: 'Points | est', type: 'number' } })
    expect(await query()).toContain('| Task | Status | Due | Owner | Points \\| est | Done | Row |')
  })
})

describe('query_database numbers and linked views', () => {
  it('compares numbers by value in before and after', async () => {
    database()
    const result = await query({ filter: [{ property: 'Points', op: 'before', value: '5' }] })
    expect(tableRows(result).map((l) => l.split(' | ')[0].slice(2))).toEqual(['Write docs', 'Plan retro'])
    database()
    const over = await query({ filter: [{ property: 'Points', op: 'after', value: '10' }] })
    expect(tableRows(over)).toEqual([])
  })

  it('reads a linked view in the workspace its database lives in', async () => {
    const OTHER = '5b5b5b5b-0000-4000-8000-000000000002'
    const tab = new FakeNotionTab(`https://app.notion.com/${hex(DB)}`)
      .respond(
        'syncRecordValuesMain',
        200,
        sync('block', [
          {
            id: DB,
            type: 'collection_view',
            view_ids: [VIEW],
            format: { collection_pointer: { id: COLLECTION, spaceId: OTHER } },
          },
        ]),
      )
      .respond('syncRecordValuesMain', 200, sync('collection', [{ id: COLLECTION, name: [['Tasks']], schema: SCHEMA }]))
      .respond('queryCollection', 200, {
        result: { reducerResults: { collection_group_results: { blockIds: [] } } },
        recordMap: {},
      })
      .install()
    await query()
    expect(tab.sent.at(-1)!.body).toMatchObject({
      source: { id: COLLECTION, spaceId: OTHER },
      collectionView: { id: VIEW, spaceId: OTHER },
    })
    expect(tab.sent.at(-1)!.headers['x-notion-space-id']).toBe(OTHER)
  })
})
