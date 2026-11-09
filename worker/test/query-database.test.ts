// The query_database tool (extension/src/tools.ts) against a fake Notion tab answering in the
// shapes Notion's syncRecordValuesMain and queryCollection return (see the #64 spike).
import { afterEach, describe, expect, it } from 'vitest'
import { QUERY_LOAD, QUERY_PART, localDate, queryDatabase } from '../../extension/src/tools'
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

function database(rows = TASKS.map(rowRecord), hasMore = false) {
  return new FakeNotionTab(`https://app.notion.com/${hex(DB)}?v=${hex(VIEW)}`)
    .respond(
      'syncRecordValuesMain',
      200,
      sync('block', [{ id: DB, type: 'collection_view_page', collection_id: COLLECTION, view_ids: [VIEW] }]),
    )
    .respond('syncRecordValuesMain', 200, sync('collection', [{ id: COLLECTION, name: [['Tasks']], schema: SCHEMA }]))
    .respond('queryCollection', 200, {
      result: {
        reducerResults: { collection_group_results: { type: 'results', blockIds: rows.map((r) => r.id), hasMore } },
      },
      recordMap: {
        __version__: 3,
        block: Object.fromEntries(rows.map((r) => [r.id, wrapped(r)])),
        notion_user: { [USER]: wrapped({ id: USER, name: 'Fixture User' }) },
      },
    })
    .install()
}

const query = async (args: Record<string, unknown> = {}) => (await queryDatabase.run(args)) as string
const tableRows = (result: string) =>
  result.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Task | Status |') && !l.startsWith('| ---'))
const today = localDate(new Date())

describe('UC-NOTION-006 read a database', () => {
  it('[UC-NOTION-006-S01] reads the open database: its properties, and each row with its values and id', async () => {
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
        `| Write docs | Done | @2026-11-05 | @Fixture User | 3 | Yes | ^${hex(row(1))} |`,
        `| Fix login \\| Safari | In progress | @2026-11-07 | @Fixture User | 5 | No | ^${hex(row(2))} |`,
        `| Ship beta | Not started | @2026-11-20 | @Fixture User | 8 | No | ^${hex(row(3))} |`,
        `| Plan retro | Not started |  | @Fixture User | 1 | No | ^${hex(row(4))} |`,
      ].join('\n'),
    )
    // The rows came from the database's view, as the tab's Notion user.
    expect(tab.sent.at(-1)!.body).toMatchObject({
      source: { type: 'collection', id: COLLECTION, spaceId: SPACE },
      collectionView: { id: VIEW, spaceId: SPACE },
      loader: { reducers: { collection_group_results: { type: 'results', limit: QUERY_LOAD } } },
    })
  })

  it('[UC-NOTION-006-S02] keeps only the rows that match every condition, in the asked order', async () => {
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
      `| Fix login \\| Safari | In progress | @2026-11-07 | @Fixture User | 5 | No | ^${hex(row(2))} |`,
    ])

    // Against the text as Notion shows it, not as escaped for Markdown.
    database()
    const piped = await query({ filter: [{ property: 'Task', op: 'is', value: 'fix login | safari' }] })
    expect(tableRows(piped).map((l) => l.split(' | ')[0])).toEqual(['| Fix login \\| Safari'])
    database()
    const empty = await query({ filter: [{ property: 'Due', op: 'is_empty' }] })
    expect(tableRows(empty).map((l) => l.split(' | ')[0])).toEqual(['| Plan retro'])
  })

  it('[UC-NOTION-006-S02] orders the rows, empty values last in either direction', async () => {
    const titles = (result: string) => tableRows(result).map((l) => l.split(' | ')[0].slice(2))
    database()
    expect(titles(await query({ sort: { property: 'Due', direction: 'descending' } }))).toEqual([
      'Ship beta',
      'Fix login \\| Safari',
      'Write docs',
      'Plan retro',
    ])
    database()
    expect(titles(await query({ sort: { property: 'Points' } }))).toEqual([
      'Plan retro',
      'Write docs',
      'Fix login \\| Safari',
      'Ship beta',
    ])
  })

  it('[UC-NOTION-006-S03] reads many rows part by part, and says when there are more than it read', async () => {
    const many = Array.from({ length: QUERY_PART + 10 }, (_, i) =>
      rowRecord({ ...TASKS[0], n: 100 + i, task: `Task ${i}` }),
    )
    database(many, true)
    const first = await query()
    expect(first).toContain(`Rows: ${QUERY_PART + 10} (showing 1–${QUERY_PART}). Read part 2 for more.`)
    expect(first).toContain(`Only the first ${QUERY_LOAD} rows of the database were read; filters apply to those.`)
    expect(tableRows(first)).toHaveLength(QUERY_PART)
    database(many, true)
    expect(tableRows(await query({ part: 2 }))).toHaveLength(10)
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

  it('says when the page is not a database', async () => {
    new FakeNotionTab(PAGE_URL)
      .respond(
        'syncRecordValuesMain',
        200,
        sync('block', [{ id: '1a1a1a1a-0000-4000-8000-000000000010', type: 'page' }]),
      )
      .install()
    await expect(query()).rejects.toThrow('The open page is not a database. Give `database`.')
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
  })
})

describe('query_database numbers and linked views', () => {
  it('sorts negative and decimal numbers by value', async () => {
    const values = ['-5', '-10', '1.5', '1.25']
    database(TASKS.map((t, i) => rowRecord({ ...t, points: values[i] })))
    const result = await query({ sort: { property: 'Points' } })
    expect(tableRows(result).map((l) => l.split(' | ')[4])).toEqual(['-10', '-5', '1.25', '1.5'])
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
    expect(tab.sent.at(-1)!.body).toMatchObject({ source: { id: COLLECTION, spaceId: OTHER } })
  })
})
