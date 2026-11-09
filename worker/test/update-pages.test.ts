// Changing page properties and adding database rows (update_pages and create_page in
// extension/src/tools.ts), against a fake Notion workspace that applies transactions the way
// Notion does.
import { afterEach, describe, expect, it } from 'vitest'
import { UPDATE_MAX, createPage, forgetReads, queryDatabase, updatePages } from '../../extension/src/tools'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, restoreGlobals } from './notion-tab'

afterEach(() => {
  restoreGlobals()
  forgetReads()
})

const hex = (s: string) => s.replace(/-/g, '')
const DB = 'db0db0db-0000-4000-8000-000000000001'
const COLLECTION = 'c0c0c0c0-0000-4000-8000-000000000001'
const VIEW = 'e0e0e0e0-0000-4000-8000-000000000001'
const row = (n: number) => `a1a1a1a1-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const SCHEMA = {
  title: { name: 'Task', type: 'title' },
  'a:a': {
    name: 'Status',
    type: 'status',
    options: [{ value: 'Not started' }, { value: 'In progress' }, { value: 'Done' }],
  },
  'b:b': { name: 'Due', type: 'date' },
  'c:c': { name: 'Owner', type: 'person' },
  'd:d': { name: 'Points', type: 'number' },
  'e:e': { name: 'Urgent', type: 'checkbox' },
  'f:f': { name: 'Tags', type: 'multi_select', options: [{ value: 'Bug' }, { value: 'Docs' }] },
  'g:g': { name: 'Notes', type: 'text' },
}
const date = (d: string) => [['‣', [['d', { type: 'date', start_date: d }]]]]

function rowRecord(n: number, title: string, status: string) {
  return {
    id: row(n),
    type: 'page',
    parent_id: COLLECTION,
    parent_table: 'collection',
    properties: { title: [[title]], 'a:a': [[status]], 'd:d': [['1']] },
  }
}

function workspace() {
  const ws = new FakeWorkspace(
    [
      {
        id: DB,
        type: 'collection_view_page',
        collection_id: COLLECTION,
        view_ids: [VIEW],
        parent_id: SPACE,
        parent_table: 'space',
      },
      rowRecord(1, 'Write docs', 'Done'),
      rowRecord(2, 'Fix login', 'In progress'),
      rowRecord(3, 'Ship beta', 'Not started'),
      { id: PAGE, type: 'page', properties: { title: [['Fixture page']] }, parent_id: SPACE, parent_table: 'space' },
    ],
    SPACE,
  )
  ws.collections.set(COLLECTION, { id: COLLECTION, version: 1, name: [['Tasks']], schema: SCHEMA, space_id: SPACE })
  return ws
}
function open(ws: FakeWorkspace, url = PAGE_URL) {
  const tab = new FakeNotionTab(url)
  tab.workspace = ws
  return tab.install()
}
const update = async (pages: unknown) => (await updatePages.run({ pages })) as string
const props = (ws: FakeWorkspace, n: number) => ws.records.get(row(n))!.properties

describe('UC-NOTION-008 change properties and rows', () => {
  it('[UC-NOTION-008-S01] sets a property on several rows in one change, and only on those', async () => {
    const ws = workspace()
    open(ws)
    const result = await update([
      { page: hex(row(2)), properties: { Status: 'done' } },
      { page: `https://app.notion.com/${hex(row(3))}`, properties: { status: 'Done', Points: 5, Urgent: 'Yes' } },
    ])
    expect(result).toBe(
      ['Changed 2 pages:', `^${hex(row(2))}: Status`, `^${hex(row(3))}: status, Points, Urgent`].join('\n'),
    )
    expect(ws.transactions).toHaveLength(1)
    expect(props(ws, 2)).toEqual({ title: [['Fix login']], 'a:a': [['Done']], 'd:d': [['1']] })
    expect(props(ws, 3)).toEqual({
      title: [['Ship beta']],
      'a:a': [['Done']],
      'd:d': [['5']],
      'e:e': [['Yes']],
    })
    expect(props(ws, 1)).toEqual(rowRecord(1, 'Write docs', 'Done').properties)
  })

  it('[UC-NOTION-008-S01] sets dates, lists of options, text, and titles and icons, and clears values', async () => {
    const ws = workspace()
    open(ws)
    await update([
      {
        page: hex(row(1)),
        title: 'Write the docs',
        icon: '📝',
        properties: { Due: '2026-11-20', Tags: ['bug', 'Docs'], Notes: 'Ask Kim', Points: null },
      },
      { page: hex(row(2)), properties: { Due: '2026-11-20 → 2026-11-22' } },
    ])
    expect(props(ws, 1)).toEqual({
      title: [['Write the docs']],
      'a:a': [['Done']],
      'b:b': date('2026-11-20'),
      'd:d': [],
      'f:f': [['Bug,Docs']],
      'g:g': [['Ask Kim']],
    })
    expect(ws.records.get(row(1))!.format).toEqual({ page_icon: '📝' })
    expect((props(ws, 2) as Record<string, unknown>)['b:b']).toEqual([
      ['‣', [['d', { type: 'daterange', start_date: '2026-11-20', end_date: '2026-11-22' }]]],
    ])
  })

  it('[UC-NOTION-008-S02] writes nothing when a value does not fit its property, and says why', async () => {
    const ws = workspace()
    const tab = open(ws)
    const refused: [unknown, string][] = [
      [{ Status: 'Blocked' }, 'Status has no option “Blocked”. Its options are: Not started, In progress, Done.'],
      [{ Due: '2026-02-30' }, 'Due must be a date as YYYY-MM-DD'],
      [{ Due: 'next Friday' }, 'Due must be a date as YYYY-MM-DD'],
      [{ Points: 'five' }, 'Points must be a number, not “five”.'],
      [{ Urgent: 'maybe' }, 'Urgent is a checkbox: give Yes or No.'],
      [{ Tags: ['Bug', 'Feature'] }, 'Tags has no option “Feature”.'],
      [{ Owner: 'Kim' }, "Owner is a person property; it can't be set."],
      [{ Priority: 'High' }, 'There is no property “Priority”. The properties are: Task, Status, Due,'],
      [{ Task: 'New title' }, 'Give the title as `title`, not as “Task”.'],
    ]
    for (const [properties, message] of refused) {
      await expect(
        update([
          { page: hex(row(1)), properties: { Status: 'Done' } },
          { page: hex(row(2)), properties },
        ]),
      ).rejects.toThrow(message)
    }
    expect(ws.transactions).toEqual([])
    expect(tab.sent.map((r) => r.url.split('/api/v3/')[1])).not.toContain('saveTransactionsFanout')
  })

  it('[UC-NOTION-008-S03] adds a row to a database with its properties and content', async () => {
    const ws = workspace()
    open(ws)
    const result = (await createPage.run({
      title: 'Renew domain',
      parent: hex(DB),
      properties: { Status: 'Not started', Due: '2026-12-01' },
      markdown: '- Check the price',
    })) as string
    const created = /\^([0-9a-f]{32})/.exec(result)![1]
    expect(result.split('\n')[0]).toBe(`Added the row “Renew domain” ^${created} to the database ^${hex(DB)}.`)
    const record = [...ws.records.values()].find((r) => hex(r.id) === created)!
    expect(record).toMatchObject({
      type: 'page',
      parent_id: COLLECTION,
      parent_table: 'collection',
      properties: { title: [['Renew domain']], 'a:a': [['Not started']], 'b:b': date('2026-12-01') },
    })
    expect(ws.content(record.id).map((b) => b.type)).toEqual(['bulleted_list'])
    // A database lists its rows itself: the database page's content is unchanged.
    expect(ws.records.get(DB)!.content).toBeUndefined()
  })
})

describe('update_pages details', () => {
  it('needs the user’s OK, and shows the old values the agent saw', async () => {
    const ws = workspace()
    const tab = open(ws, `https://app.notion.com/${hex(DB)}`)
    // query_database's rows come from Notion's query; the rest from the workspace.
    tab.respond('queryCollection', 200, {
      result: {
        reducerResults: { collection_group_results: { type: 'results', blockIds: [row(2)], hasMore: false } },
      },
      recordMap: {
        __version__: 3,
        block: {
          [row(2)]: {
            spaceId: SPACE,
            value: { role: 'editor', value: { version: 1, alive: true, ...rowRecord(2, 'Fix login', 'In progress') } },
          },
        },
      },
    })
    await queryDatabase.run({})
    expect(updatePages.needsConfirmation).toBe(true)
    expect(
      updatePages.preview!({
        pages: [
          { page: hex(row(2)), properties: { Status: 'Done', Notes: 'Shipped' } },
          { page: hex(row(3)), title: 'Ship the beta\n^fake' },
        ],
      }),
    ).toBe(
      [
        'Change 2 pages',
        `Fix login ^${hex(row(2))}`,
        '    Status: Done (was In progress)',
        '    Notes: Shipped (was empty)',
        `^${hex(row(3))}`,
        '    Title: Ship the beta ^fake',
      ].join('\n'),
    )
  })

  it('refuses unclear requests before asking Notion anything', async () => {
    const ws = workspace()
    const tab = open(ws)
    const refused: [unknown, string][] = [
      [[], '`pages` must be a list with at least one page.'],
      [[{ page: 'nope' }], 'Page 1 needs `page`'],
      [[{ page: hex(row(1)) }], 'Page 1 changes nothing'],
      [
        [
          { page: hex(row(1)), title: 'A' },
          { page: hex(row(1)), title: 'B' },
        ],
        'is given twice',
      ],
      [[{ page: hex(row(1)), title: ' ' }], '`title` must not be empty.'],
      [[{ page: hex(row(1)), icon: 'https://example.com/i.png' }], '`icon` must be an emoji.'],
      [
        Array.from({ length: UPDATE_MAX + 1 }, (_, i) => ({ page: hex(row(i + 1)), title: 'x' })),
        `At most ${UPDATE_MAX}`,
      ],
    ]
    for (const [pages, message] of refused) await expect(update(pages)).rejects.toThrow(message)
    expect(tab.sent).toEqual([])
  })

  it('changes only the title and icon of a page that is not a row, and refuses databases', async () => {
    const ws = workspace()
    open(ws)
    await expect(update([{ page: hex(PAGE), properties: { Status: 'Done' } }])).rejects.toThrow(
      "isn't a database row, so it has no properties",
    )
    await expect(update([{ page: hex(DB), title: 'Renamed' }])).rejects.toThrow('is a database')
    await update([{ page: hex(PAGE), title: 'Renamed page' }])
    expect(ws.records.get(PAGE)!.properties).toEqual({ title: [['Renamed page']] })
  })

  it('refuses properties for a page parent, and checks a row’s values against its database', async () => {
    const ws = workspace()
    open(ws)
    await expect(createPage.run({ title: 'x', parent: PAGE_URL, properties: { Status: 'Done' } })).rejects.toThrow(
      '`properties` are only for rows',
    )
    await expect(createPage.run({ title: 'x', parent: hex(DB), properties: { Status: 'Blocked' } })).rejects.toThrow(
      'Status has no option “Blocked”.',
    )
    expect(ws.transactions).toEqual([])
  })
})
