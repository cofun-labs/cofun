// Changing page properties and adding database rows (update_pages and create_page in
// extension/src/tools.ts), against a fake Notion workspace that applies transactions the way
// Notion does.
import { afterEach, describe, expect, it } from 'vitest'
import { UPDATE_MAX, createPage, forgetReads, queryDatabase, readPage, updatePages } from '../src/tools'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, USER, restoreGlobals } from './notion-tab'

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
  'f:f': {
    name: 'Tags',
    type: 'multi_select',
    options: [{ value: 'Bug' }, { value: 'Docs' }, { value: 'Needs [review]' }],
  },
  'g:g': { name: 'Notes', type: 'text' },
}
const date = (d: string) => [['‣', [['d', { type: 'date', start_date: d }]]]]

function rowRecord(n: number, title: string, status: string, more: Record<string, unknown> = {}) {
  return {
    id: row(n),
    type: 'page',
    parent_id: COLLECTION,
    parent_table: 'collection',
    properties: { title: [[title]], 'a:a': [[status]], 'd:d': [['1']], ...more },
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
/** Has query_database show these rows of the database, as the agent would before changing them. */
async function query(tab: FakeNotionTab, rows: ReturnType<typeof rowRecord>[]) {
  tab.respond('queryCollection', 200, {
    result: {
      reducerResults: {
        collection_group_results: { type: 'results', blockIds: rows.map((r) => r.id), hasMore: false },
      },
    },
    recordMap: {
      __version__: 3,
      block: Object.fromEntries(
        rows.map((r) => [
          r.id,
          { spaceId: SPACE, value: { role: 'editor', value: { version: 1, alive: true, ...r } } },
        ]),
      ),
    },
  })
  return (await queryDatabase.run({})) as string
}
/** The cells of a row as query_database's table shows them, by column name. */
function shownCells(table: string, id: string): Record<string, string> {
  const cells = (line: string) =>
    line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((c) => c.trim())
  const lines = table.split('\n')
  const header = cells(lines.find((l) => l.startsWith('| Task'))!)
  const row = cells(lines.find((l) => l.includes(hex(id)))!)
  return Object.fromEntries(header.map((name, n) => [name, row[n]]))
}
const update = async (pages: unknown) => (await updatePages.run({ pages })) as string
const props = (ws: FakeWorkspace, n: number) => ws.records.get(row(n))!.properties
const prop = (ws: FakeWorkspace, n: number, key: string) => (props(ws, n) as Record<string, unknown>)[key]

describe('UC-NOTION-008 change properties and rows', () => {
  it('[UC-NOTION-008-S06] sets a property on several rows in one change, and only on those', async () => {
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

  it('names the signed-in user as the last editor of the pages it changes', async () => {
    const ws = workspace()
    open(ws)
    await update([{ page: hex(row(2)), properties: { Status: 'done' } }])
    expect(ws.records.get(row(2))).toMatchObject({ last_edited_by_id: USER, last_edited_by_table: 'notion_user' })
    expect(ws.records.get(row(1))).not.toHaveProperty('last_edited_by_id')
  })

  it('[UC-NOTION-008-S06] sets dates, lists of options, text, and titles and icons, and clears values', async () => {
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

  it('[UC-NOTION-008-S07] adds a row to a database with its properties and content', async () => {
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
  const ANN = 'f0f0f0f0-0000-4000-8000-000000000001'
  const ANN2 = 'f0f0f0f0-0000-4000-8000-000000000002'
  const SPEC = 'b2b2b2b2-0000-4000-8000-000000000001'
  /** The workspace with a member named Ann and a page named Spec, for values that mention them. */
  function mentionable() {
    const ws = workspace()
    ws.put('notion_user', { id: ANN, name: 'Ann' })
    ws.records.set(SPEC, {
      ...ws.records.get(PAGE)!,
      id: SPEC,
      properties: { title: [['Spec']] },
    })
    ws.collections.get(COLLECTION)!.schema = {
      ...SCHEMA,
      'i:i': { name: 'Link', type: 'url' },
      'j:j': { name: 'Mail', type: 'email' },
      'k:k': { name: 'Phone', type: 'phone_number' },
    }
    return ws
  }
  /** Bold, a person, a link, a page, and a date, as Notion stores them. */
  const NOTES = [
    ['Done', [['b']]],
    [' by '],
    ['‣', [['u', ANN]]],
    [', see '],
    ['the plan', [['a', 'https://x.example/plan']]],
    [' and '],
    ['‣', [['p', SPEC]]],
    [' on '],
    ['‣', [['d', { type: 'date', start_date: '2026-11-20' }]]],
  ]

  it('[UC-NOTION-008-S10] stores the Markdown of a text value and a title as formatting, links, and mentions', async () => {
    const ws = mentionable()
    const tab = open(ws)
    await update([
      {
        page: hex(row(1)),
        title: 'Write *the* docs',
        properties: {
          Notes: `**Done** by @[Ann], see [the plan](https://x.example/plan) and [Spec](${hex(SPEC)}) on @2026-11-20`,
        },
      },
      { page: hex(row(2)), properties: { Status: 'Done' } },
    ])
    expect(props(ws, 1)).toMatchObject({
      title: [['Write '], ['the', [['i']]], [' docs']],
      'g:g': NOTES,
    })
    expect(props(ws, 2)).toMatchObject({ title: [['Fix login']], 'a:a': [['Done']] })
    // The members are looked up once, and only because a value mentions someone.
    expect(tab.sent.filter((r) => r.url.endsWith('/getVisibleUsers'))).toHaveLength(1)
  })

  it('[UC-NOTION-008-S10] stores the Markdown of a new row’s title and text', async () => {
    const ws = mentionable()
    open(ws)
    const result = (await createPage.run({
      title: '**Renew** the domain with @[Ann]',
      parent: hex(DB),
      properties: { Notes: `Ask @[ann] about [Spec](${hex(SPEC)})`, Link: 'https://x.example/a_b_c' },
    })) as string
    const created = /\^([0-9a-f]{32})/.exec(result)![1]
    expect(result.split('\n')[0]).toBe(
      `Added the row “Renew the domain with Ann” ^${created} to the database ^${hex(DB)}.`,
    )
    expect([...ws.records.values()].find((r) => hex(r.id) === created)!.properties).toEqual({
      title: [['Renew', [['b']]], [' the domain with '], ['‣', [['u', ANN]]]],
      'g:g': [['Ask '], ['‣', [['u', ANN]]], [' about '], ['‣', [['p', SPEC]]]],
      'i:i': [['https://x.example/a_b_c']],
    })
  })

  it('[UC-NOTION-008-S11] stores a text value and a title written back as query_database shows them as they were', async () => {
    const ws = mentionable()
    const tab = open(ws, `https://app.notion.com/${hex(DB)}`)
    const title = [['Write '], ['the', [['i']]], [' a|b [docs] with '], ['‣', [['u', ANN]]]]
    const notes = [
      ...NOTES,
      [' for $5 '],
      ['x|y', [['c']]],
      [' and '],
      ['red', [['h', 'red'], ['b']]],
      [' '],
      ['⁍', [['e', 'a|b\\|c']]],
    ]
    ws.edit(row(1), { properties: { title, 'a:a': [['Done']], 'g:g': notes } })
    const stored = structuredClone(props(ws, 1))
    const shown = shownCells(await query(tab, [ws.records.get(row(1)) as never]), row(1))
    expect(shown.Notes).toContain('**Done** by @[Ann], see [the plan](https://x.example/plan) and [Spec](')
    const pages = [{ page: hex(row(1)), title: shown.Task, properties: { Notes: shown.Notes } }]
    expect(updatePages.preview!({ pages })).toBe(
      [
        'Change 1 page',
        `Write the a|b [docs] with Ann ^${hex(row(1))}`,
        '    Title: Write the a|b [docs] with Ann (unchanged)',
        '    Notes: Done by Ann, see the plan and Spec on 2026-11-20 for $5 x|y and red a|b\\|c (unchanged)',
      ].join('\n'),
    )
    await update(pages)
    expect(props(ws, 1)).toEqual(stored)
  })

  it('[UC-NOTION-008-S12] writes nothing when a text value or a title mentions a name no member has', async () => {
    const ws = mentionable()
    const tab = open(ws)
    for (const change of [{ properties: { Notes: 'Ask @[Bob]' } }, { title: 'For @[Bob]' }]) {
      await expect(
        update([
          { page: hex(row(1)), properties: { Status: 'Not started' } },
          { page: hex(row(2)), ...change },
        ]),
      ).rejects.toThrow('@[Bob]: no workspace member has that name.')
    }
    await expect(
      createPage.run({ title: 'For @[Bob]', parent: hex(DB), properties: { Notes: 'Ask @[Bob]' } }),
    ).rejects.toThrow('@[Bob]: no workspace member has that name.')
    expect(ws.transactions).toEqual([])
    expect(tab.sent.map((r) => r.url.split('/api/v3/')[1])).not.toContain('saveTransactionsFanout')
  })

  it('keeps the person a text value already mentions when two members share the name, and what its dates stored', async () => {
    const ws = mentionable()
    ws.put('notion_user', { id: ANN2, name: 'Ann' })
    const tab = open(ws)
    const day = {
      type: 'date',
      start_date: '2026-11-20',
      time_zone: 'Europe/Paris',
      reminder: { unit: 'day', value: 1 },
    }
    ws.edit(row(1), {
      properties: { title: [['Write docs']], 'g:g': [['‣', [['u', ANN2]]], [' on '], ['‣', [['d', day]]]] },
    })
    await update([{ page: hex(row(1)), properties: { Notes: 'Ask @[Ann] before @2026-11-20' } }])
    expect(props(ws, 1)).toMatchObject({
      'g:g': [['Ask '], ['‣', [['u', ANN2]]], [' before '], ['‣', [['d', day]]]],
    })
    // The name alone can't tell the two apart where the old value doesn't mention either.
    await expect(update([{ page: hex(row(2)), properties: { Notes: 'Ask @[Ann]' } }])).rejects.toThrow(
      '2 workspace members are named “Ann”',
    )
    expect(ws.transactions).toHaveLength(1)
    expect(tab.sent.filter((r) => r.url.endsWith('/getVisibleUsers'))).toHaveLength(1)
  })

  it('refuses to write @someone over a person whose name it could not read', async () => {
    const ws = mentionable()
    const tab = open(ws, `https://app.notion.com/${hex(DB)}`)
    const gone = 'f0f0f0f0-0000-4000-8000-00000000dead'
    ws.edit(row(1), { properties: { title: [['Write docs']], 'g:g': [['Ask '], ['‣', [['u', gone]]]] } })
    const shown = shownCells(await query(tab, [ws.records.get(row(1)) as never]), row(1))
    expect(shown.Notes).toBe('Ask @someone')
    await expect(update([{ page: hex(row(1)), properties: { Notes: shown.Notes } }])).rejects.toThrow(
      'Notes mentions a person whose name could not be read, shown as @someone.',
    )
    expect(ws.transactions).toEqual([])
    // Other text replaces the value as usual, and text that already said @someone stays.
    ws.edit(row(2), { properties: { title: [['Fix login']], 'g:g': [['@someone said, '], ['‣', [['u', ANN]]]] } })
    await update([
      { page: hex(row(1)), properties: { Notes: 'Ask @[Ann]' } },
      { page: hex(row(2)), properties: { Notes: '@someone said, @[Ann]' } },
    ])
    expect(props(ws, 1)).toMatchObject({ 'g:g': [['Ask '], ['‣', [['u', ANN]]]] })
    expect(props(ws, 2)).toMatchObject({ 'g:g': [['@someone said, '], ['‣', [['u', ANN]]]] })
  })

  /** A comment thread anchored on text, a web page shown as a preview, and another workspace. */
  const THREAD = 'd1d1d1d1-0000-4000-8000-000000000001'
  const PREVIEW = { href: 'https://x.example/pr/7', title: 'Fix the build', icon_url: 'https://x.example/icon.png' }
  const OTHER_SPACE = '5a5a5a5a-0000-4000-8000-000000000009'
  /** Each thing query_database's Markdown doesn't show, on its own run. */
  const UNSHOWN = {
    underline: ['key', [['_']]],
    comment: ['budget', [['m', THREAD]]],
    preview: ['‣', [['lm', PREVIEW]]],
    linkedPerson: [
      '‣',
      [
        ['u', ANN],
        ['a', 'https://x.example/ann'],
      ],
    ],
    pageSpace: ['‣', [['p', SPEC, OTHER_SPACE]]],
  }
  const HIDDEN = [
    ['The '],
    UNSHOWN.underline,
    [' '],
    UNSHOWN.comment,
    [' is in '],
    UNSHOWN.preview,
    [', ask '],
    UNSHOWN.linkedPerson,
    [' about '],
    UNSHOWN.pageSpace,
    [' soon'],
  ]

  it('[UC-NOTION-008-S13] stores a text value and a title written back as shown with what the Markdown does not show', async () => {
    const ws = mentionable()
    const tab = open(ws, `https://app.notion.com/${hex(DB)}`)
    const title = [['Write '], ['the', [['_'], ['b']]], [' docs']]
    ws.edit(row(1), { properties: { title, 'a:a': [['Done']], 'g:g': HIDDEN } })
    const stored = structuredClone(props(ws, 1))
    const shown = shownCells(await query(tab, [ws.records.get(row(1)) as never]), row(1))
    expect(shown.Notes).toBe(
      `The key budget is in [Fix the build](https://x.example/pr/7), ask @[Ann] about [Spec](${hex(SPEC)}) soon`,
    )
    expect(shown.Task).toBe('Write **the** docs')
    const pages = [{ page: hex(row(1)), title: shown.Task, properties: { Notes: shown.Notes } }]
    expect((await updatePages.preview!({ pages }))?.split('\n').slice(2)).toEqual([
      '    Title: Write the docs (unchanged)',
      '    Notes: The key budget is in Fix the build, ask Ann about Spec soon (unchanged)',
    ])
    await update(pages)
    expect(props(ws, 1)).toEqual(stored)
  })

  it('[UC-NOTION-008-S13] keeps what the Markdown does not show on the text a change leaves as it was', async () => {
    const ws = mentionable()
    open(ws)
    ws.edit(row(1), { properties: { title: [['Write docs']], 'g:g': HIDDEN } })
    // Changes at the start, in the middle, and at the end, around every run that holds something.
    await update([
      {
        page: hex(row(1)),
        properties: {
          Notes:
            `Our key budget is **now** in [Fix the build](https://x.example/pr/7), ask @[Ann] or ` +
            `@[Ann] about [Spec](${hex(SPEC)}) today`,
        },
      },
    ])
    expect(prop(ws, 1, 'g:g')).toEqual([
      ['Our '],
      UNSHOWN.underline,
      [' '],
      UNSHOWN.comment,
      [' is '],
      ['now', [['b']]],
      [' in '],
      UNSHOWN.preview,
      [', ask '],
      UNSHOWN.linkedPerson,
      [' or '],
      ['‣', [['u', ANN]]],
      [' about '],
      UNSHOWN.pageSpace,
      [' today'],
    ])
    // Text that is gone takes what was on it along; the rest stays.
    await update([{ page: hex(row(1)), properties: { Notes: 'Our key' } }])
    expect(prop(ws, 1, 'g:g')).toEqual([['Our '], UNSHOWN.underline])
    // So does one of two equal words, when it is the one that goes.
    ws.edit(row(2), { properties: { title: [['Fix login']], 'g:g': [['the', [['_']]], [' cat and the dog']] } })
    await update([{ page: hex(row(2)), properties: { Notes: 'cat and the dog' } }])
    expect(prop(ws, 2, 'g:g')).toEqual([['cat and the dog']])
    await update([{ page: hex(row(1)), properties: { Notes: '' } }])
    expect(prop(ws, 1, 'g:g')).toEqual([])
  })

  it.each([
    ['an underline', UNSHOWN.underline, '**key**', 'an underline on “key”'],
    ['a comment on the text', UNSHOWN.comment, '*budget*', 'a comment on the text on “budget”'],
    [
      'a link preview',
      UNSHOWN.preview,
      '**[Fix the build](https://x.example/pr/7)**',
      'a link preview (it would become an ordinary link) on “[Fix the build](https://x.example/pr/7)”',
    ],
    ['a link on a person', UNSHOWN.linkedPerson, '**@[Ann]**', 'a link on a mention of a person on “@[Ann]”'],
    [
      'a mentioned page’s workspace',
      UNSHOWN.pageSpace,
      `**[Spec](${hex(SPEC)})**`,
      `the workspace of a mentioned page on “[…](${hex(SPEC)})”`,
    ],
    [
      'a color on a mention',
      [
        '‣',
        [
          ['p', SPEC],
          ['h', 'red'],
        ],
      ],
      `**[Spec](${hex(SPEC)})**`,
      `a color on a mention on “[…](${hex(SPEC)})”`,
    ],
    ['a mark it doesn’t know', ['odd', [['zz', 1]]], '**odd**', 'formatting of a kind that is not known on “odd”'],
  ])(
    '[UC-NOTION-008-S14] writes nothing when a change would remove %s from text that stays',
    async (_kind, run, markdown, lost) => {
      const ws = mentionable()
      open(ws)
      const notes = [['See '], run, [' first']]
      ws.edit(row(1), { properties: { title: [['Write docs']], 'g:g': notes } })
      ws.edit(row(3), { properties: { title: [['Ship '], run] } })
      // The same text with other formatting: only the Markdown could say what it should hold now.
      await expect(
        update([
          { page: hex(row(2)), properties: { Status: 'Done' } },
          { page: hex(row(1)), properties: { Notes: `See ${markdown} first` } },
        ]),
      ).rejects.toThrow(
        `^${hex(row(1))}: Notes holds ${lost}. Reading the value doesn’t show that, and this change would remove it.`,
      )
      await expect(update([{ page: hex(row(3)), title: `Ship ${markdown} now` }])).rejects.toThrow(
        `^${hex(row(3))}: the title holds ${lost}.`,
      )
      expect(ws.transactions).toEqual([])
      expect(prop(ws, 1, 'g:g')).toEqual(notes)
      expect(prop(ws, 2, 'a:a')).toEqual([['In progress']])
    },
  )

  it('keeps a comment on text that two edits surround, and on the right one of two equal words', async () => {
    const ws = mentionable()
    open(ws)
    ws.edit(row(1), {
      properties: { title: [['Write docs']], 'g:g': [['cost and '], ['cost', [['m', THREAD]]], [' and more']] },
    })
    await update([{ page: hex(row(1)), properties: { Notes: 'cost and cost and less' } }])
    expect(prop(ws, 1, 'g:g')).toEqual([['cost and '], ['cost', [['m', THREAD]]], [' and less']])
    await update([{ page: hex(row(1)), properties: { Notes: 'The cost and cost or less' } }])
    expect(prop(ws, 1, 'g:g')).toEqual([['The cost and '], ['cost', [['m', THREAD]]], [' or less']])
    // Text changed inside what the comment is on is no longer the text as it was shown.
    for (const notes of ['The cost and co-st or less', 'The cost and cos or less', 'The cost and **co**st or less']) {
      await expect(update([{ page: hex(row(1)), properties: { Notes: notes } }])).rejects.toThrow(
        'Notes holds a comment on the text on “cost”',
      )
    }
    expect(ws.transactions).toHaveLength(2)
  })

  it('refuses an edit inside text that holds a comment or an underline, when part of that text stays', async () => {
    const ws = mentionable()
    open(ws)
    for (const [mark, lost, was, now] of [
      [['m', THREAD], 'a comment on the text', 'helo world', 'hello world'],
      [['m', THREAD], 'a comment on the text', 'hello world', 'hello big world'],
      [['_'], 'an underline', 'hello world', 'hello there'],
      [['m', THREAD], 'a comment on the text', 'the quarterly budget review', 'the budget'],
      [['_'], 'an underline', 'quarterly budget review', 'our budget'],
    ] as const) {
      ws.edit(row(1), { properties: { title: [['Write docs']], 'g:g': [['see '], [was, [mark]], [' end']] } })
      await expect(update([{ page: hex(row(1)), properties: { Notes: `see ${now} end` } }])).rejects.toThrow(
        `Notes holds ${lost} on “${was}”`,
      )
    }
    expect(ws.transactions).toEqual([])
  })

  it('reads only what is a run in a stored value, and still keeps what the Markdown does not show', async () => {
    const ws = mentionable()
    open(ws)
    ws.edit(row(1), {
      properties: { title: [['Write docs']], 'g:g': [['odd'], [' '], ['key', [['_']]], 7, [' end']] },
    })
    await update([{ page: hex(row(1)), properties: { Notes: 'odd key end' } }])
    expect(prop(ws, 1, 'g:g')).toEqual([['odd '], ['key', [['_']]], [' end']])
  })

  it('writes a word that replaces one holding a comment or an underline, and refuses one that only moved', async () => {
    const ws = mentionable()
    open(ws)
    const set = (notes: unknown, title: unknown = [['Write docs']]) =>
      ws.edit(row(1), { properties: { title, 'g:g': notes } })
    // The old word is gone, so what was on it goes with it.
    for (const [notes, markdown] of [
      [[['Status: '], ['blocked', [['m', THREAD]]], [' on review']], 'Status: done on review'],
      [[['see '], ['hello', [['_']]], [' end']], 'see goodbye end'],
      [[['Draft', [['_']]]], 'Final'],
      [[['Budget review', [['m', THREAD]]]], 'Hiring'],
      [[['Ask about the '], ['budget', [['m', THREAD]]], [' today.']], 'Tell Bob to get us the numbers by Friday.'],
    ] as const) {
      set(notes)
      await update([{ page: hex(row(1)), properties: { Notes: markdown } }])
      expect(prop(ws, 1, 'g:g')).toEqual([[markdown]])
    }
    set([], [['Q3 '], ['plan', [['_']]]])
    await update([{ page: hex(row(1)), title: 'Q4 roadmap' }])
    expect(prop(ws, 1, 'title')).toEqual([['Q4 roadmap']])
    // The same word somewhere else is still there, without what was on it.
    const written = ws.transactions.length
    for (const [notes, markdown, lost] of [
      [[['hello', [['_']]], [' world foo bar']], 'world foo bar hello', 'an underline on “hello”'],
      [[['ab', [['m', THREAD]]], [' cd']], 'cd ab', 'a comment on the text on “ab”'],
      [[['alpha', [['_']]], [' and beta']], 'beta and alpha', 'an underline on “alpha”'],
      [[['Design', [['m', THREAD]]], [' then Build']], 'Build then Design', 'a comment on the text on “Design”'],
      [[['design '], ['draft', [['_']]], [' invoice']], 'draft design invoice', 'an underline on “draft”'],
      [
        [['Review '], ['spec', [['m', THREAD]]], [' then ship']],
        'Ship, then review spec',
        'a comment on the text on “spec”',
      ],
    ] as const) {
      set(notes)
      await expect(update([{ page: hex(row(1)), properties: { Notes: markdown } }])).rejects.toThrow(
        `Notes holds ${lost}`,
      )
    }
    expect(ws.transactions).toHaveLength(written)
  })

  it('stores two link previews of one page side by side as they were', async () => {
    const ws = mentionable()
    open(ws)
    const notes = [UNSHOWN.preview, UNSHOWN.preview]
    ws.edit(row(1), { properties: { title: [['Write docs']], 'g:g': notes } })
    const link = '[Fix the build](https://x.example/pr/7)'
    await update([{ page: hex(row(1)), properties: { Notes: link + link } }])
    expect(prop(ws, 1, 'g:g')).toEqual(notes)
  })

  it('refuses a link preview whose link text grows, instead of leaving a second link beside it', async () => {
    const ws = mentionable()
    open(ws)
    ws.edit(row(1), { properties: { title: [['Write docs']], 'g:g': [['See '], UNSHOWN.preview] } })
    for (const text of ['Fix the builds', 'Re: Fix the build']) {
      await expect(
        update([{ page: hex(row(1)), properties: { Notes: `See [${text}](https://x.example/pr/7)` } }]),
      ).rejects.toThrow('Notes holds a link preview')
    }
    expect(ws.transactions).toEqual([])
    // Another link to the same page next to it is a link of its own.
    await update([
      {
        page: hex(row(1)),
        properties: { Notes: 'See [Fix the build](https://x.example/pr/7) and [more](https://x.example/pr/7)' },
      },
    ])
    expect(prop(ws, 1, 'g:g')).toEqual([
      ['See '],
      UNSHOWN.preview,
      [' and '],
      ['more', [['a', 'https://x.example/pr/7']]],
    ])
  })

  it('refuses instead of guessing where an underline went in a text too long to compare', async () => {
    const ws = mentionable()
    open(ws)
    const filler = 'lorem ipsum '.repeat(100)
    ws.edit(row(1), {
      properties: { title: [['Write docs']], 'g:g': [[`A ${filler}`], ['key', [['_']]], [` ${filler}end`]] },
    })
    await expect(
      update([{ page: hex(row(1)), properties: { Notes: `B ${filler}key ${filler}done` } }]),
    ).rejects.toThrow('Notes holds an underline on “key”')
    expect(ws.transactions).toEqual([])
  })

  it('does not call a text value unchanged when writing it back removes its line breaks', async () => {
    const ws = mentionable()
    const tab = open(ws, `https://app.notion.com/${hex(DB)}`)
    ws.edit(row(1), { properties: { title: [['Write docs']], 'g:g': [['First\nSecond']] } })
    const shown = shownCells(await query(tab, [ws.records.get(row(1)) as never]), row(1))
    expect(shown.Notes).toBe('First Second')
    const preview = await updatePages.preview!({ pages: [{ page: hex(row(1)), properties: { Notes: shown.Notes } }] })
    expect(preview?.split('\n')[2]).toBe('    Notes: First Second (same text; its formatting changes)')
  })

  it('stores a page title written back as read_page shows it as it was', async () => {
    const ws = mentionable()
    open(ws)
    const title = [['*Draft* plan [v2] with '], ['‣', [['u', ANN]]], [' and @[name] syntax']]
    ws.edit(PAGE, { properties: { title } })
    const shown = /^Page: (.*) \^[0-9a-f]{32}$/.exec(((await readPage.run({})) as string).split('\n')[0])![1]
    expect(shown).toBe('\\*Draft\\* plan \\[v2\\] with @[Ann] and @\\[name\\] syntax')
    await update([{ page: hex(PAGE), title: shown, icon: '📝' }])
    expect(ws.records.get(PAGE)!.properties).toEqual({ title })
  })

  it('stores URLs, emails, and phone numbers as plain text, and numbers given for text', async () => {
    const ws = mentionable()
    open(ws)
    await update([
      {
        page: hex(row(1)),
        properties: {
          Link: 'https://x.example/a_b_c?q=*x*',
          Mail: '\\_ann\\_@x.example',
          Phone: '+1 555 **',
          Notes: 42,
        },
      },
    ])
    expect(props(ws, 1)).toMatchObject({
      'i:i': [['https://x.example/a_b_c?q=*x*']],
      'j:j': [['_ann_@x.example']],
      'k:k': [['+1 555 **']],
      'g:g': [['42']],
    })
  })

  it('refuses Markdown it can’t store in a text value or a title, and shows it as given in the preview', async () => {
    const ws = mentionable()
    const tab = open(ws, `https://app.notion.com/${hex(DB)}`)
    await query(tab, [rowRecord(2, 'Fix login', 'In progress')])
    const pages = [{ page: hex(row(2)), properties: { Notes: '<span color="neon">Hi</span>' } }]
    expect((await updatePages.preview!({ pages }))?.split('\n')[2]).toBe('    Notes: <span color="neon">Hi</span>')
    await expect(update(pages)).rejects.toThrow('Notes: "neon" isn\'t a Notion color.')
    await expect(update([{ page: hex(row(2)), title: '<span color="neon">Hi</span>' }])).rejects.toThrow(
      'The title: "neon" isn\'t a Notion color.',
    )
    expect(ws.transactions).toEqual([])
  })

  it('runs without asking, and shows the values it stores and the old ones the agent saw', async () => {
    const ws = workspace()
    const tab = open(ws, `https://app.notion.com/${hex(DB)}`)
    await query(tab, [
      rowRecord(2, 'Fix login', 'In progress'),
      rowRecord(4, '', 'Not started'),
      rowRecord(5, 'Fix [urgent]', 'Done', { 'b:b': date('2026-11-20') }),
    ])
    expect(updatePages.needsConfirmation).toBeUndefined()
    expect(
      updatePages.preview!({
        pages: [
          {
            page: hex(row(2)),
            properties: {
              Status: 'done',
              Urgent: true,
              Tags: ['bug', 'docs'],
              Due: '2026-11-20 -> 2026-11-22',
              Notes: 'Shipped',
              Points: 1,
              Owner: 'Kim',
              Task: 'Renamed',
            },
          },
          { page: hex(row(4)), title: 'Named at last' },
          { page: hex(row(5)), title: 'Fix \\[urgent\\]', properties: { Due: '2026-11-20' } },
          { page: hex(row(3)), title: 'Ship the beta\n^fake', properties: { Urgent: true } },
        ],
      }),
    ).toBe(
      [
        'Change 4 pages',
        `Fix login ^${hex(row(2))}`,
        '    Status: Done (was In progress)',
        '    Urgent: Yes (was No)',
        '    Tags: Bug, Docs (was empty)',
        '    Due: 2026-11-20 → 2026-11-22 (was empty)',
        '    Notes: Shipped (was empty)',
        '    Points: 1 (unchanged)',
        // Refused when it runs (a person, the title among properties): shown as given.
        '    Owner: Kim',
        '    Task: Renamed',
        `^${hex(row(4))}`,
        '    Title: Named at last (was empty)',
        `Fix [urgent] ^${hex(row(5))}`,
        '    Title: Fix [urgent] (unchanged)',
        '    Due: 2026-11-20 (unchanged)',
        // A row the agent didn't see: its database's schema is unknown.
        `^${hex(row(3))}`,
        '    Title: Ship the beta ^fake',
        '    Urgent: true',
      ].join('\n'),
    )
  })

  it('says when a text value or a title reads the same but loses its formatting', async () => {
    const ws = workspace()
    const tab = open(ws, `https://app.notion.com/${hex(DB)}`)
    const notes = [
      ['See '],
      ['code', [['c']]],
      [', '],
      ['old', [['s']]],
      [', '],
      ['red', [['h', 'red']]],
      [', '],
      ['⁍', [['e', 'a*b']]],
      [' and '],
      ['docs', [['a', 'https://x.example']]],
      [' @kitfun'],
    ]
    await query(tab, [
      rowRecord(6, '', 'Done', {
        title: [
          ['@home ', [['b'], ['h', 'red']]],
          ['Bold', [['b'], ['h', 'red']]],
        ],
        'g:g': notes,
      }),
    ])
    expect(
      updatePages.preview!({
        pages: [
          { page: hex(row(6)), title: '@home Bold', properties: { Notes: 'See code, old, red, a*b and docs @kitfun' } },
        ],
      }),
    ).toBe(
      [
        'Change 1 page',
        `@home Bold ^${hex(row(6))}`,
        '    Title: @home Bold (same text; its formatting changes)',
        '    Notes: See code, old, red, a*b and docs @kitfun (same text; its formatting changes)',
      ].join('\n'),
    )
  })

  it('[UC-NOTION-008-S09] says a date’s reminder is removed, the same day or another', async () => {
    const ws = workspace()
    const tab = open(ws, `https://app.notion.com/${hex(DB)}`)
    const reminded = [
      ['‣', [['d', { type: 'date', start_date: '2026-11-20', reminder: { unit: 'day', value: 1, time: '09:00' } }]]],
    ]
    await query(tab, [
      rowRecord(6, 'Launch', 'Done', { 'b:b': reminded }),
      rowRecord(7, 'Review', 'Done', { 'b:b': reminded }),
      rowRecord(8, 'Retro', 'Done', { 'b:b': date('2026-11-20') }),
    ])
    expect(
      updatePages.preview!({
        pages: [
          { page: hex(row(6)), properties: { Due: '2026-11-20' } },
          { page: hex(row(7)), properties: { Due: '2026-11-21' } },
          { page: hex(row(8)), properties: { Due: '2026-11-20' } },
        ],
      }),
    ).toBe(
      [
        'Change 3 pages',
        `Launch ^${hex(row(6))}`,
        '    Due: 2026-11-20 (same date; its reminder is removed)',
        `Review ^${hex(row(7))}`,
        '    Due: 2026-11-21 (was 2026-11-20; its reminder is removed)',
        `Retro ^${hex(row(8))}`,
        '    Due: 2026-11-20 (unchanged)',
      ].join('\n'),
    )
  })

  it('keeps every value on its line in the preview', async () => {
    const preview = await updatePages.preview!({
      pages: [{ page: hex(row(1)), properties: { Tags: ['Bug\n^abcdabcd\n    Status: Done'] } }],
    })
    expect(preview?.split('\n')).toEqual(['Change 1 page', `^${hex(row(1))}`, '    Tags: Bug ^abcdabcd Status: Done'])
  })

  it('takes options as query_database shows them, Markdown escapes and all', async () => {
    const ws = workspace()
    open(ws)
    await update([{ page: hex(row(1)), properties: { Tags: ['Needs \\[review\\]'] } }])
    expect(props(ws, 1)!['f:f' as never]).toEqual([['Needs [review]']])
  })

  it('stores escaped marks copied from query_database as text, a doubled backslash as one, and numbers as options', async () => {
    const ws = workspace()
    ws.collections.get(COLLECTION)!.schema = {
      ...SCHEMA,
      'h:h': { name: 'Priority', type: 'select', options: [{ value: '1' }, { value: '2' }] },
    }
    open(ws)
    await update([
      // Copied from query_database, then added to.
      {
        page: hex(row(1)),
        title: 'Fix \\[urgent\\] \\_now\\_',
        properties: { Notes: 'a \\* b \\| c, done', Priority: 1 },
      },
      // A backslash itself, written as the tools say.
      { page: hex(row(2)), title: 'Clean C:\\\\_tmp' },
    ])
    expect(props(ws, 1)).toMatchObject({
      title: [['Fix [urgent] _now_']],
      'g:g': [['a * b | c, done']],
      'h:h': [['1']],
    })
    expect(props(ws, 2)).toMatchObject({ title: [['Clean C:\\_tmp']] })
  })

  it('stores a dollar sign and an @ before a date as query_database escapes them, without the backslash', async () => {
    const ws = workspace()
    open(ws)
    await update([{ page: hex(row(1)), title: 'Cost \\$5', properties: { Notes: 'Due \\@2026-11-12' } }])
    expect(props(ws, 1)).toMatchObject({ title: [['Cost $5']], 'g:g': [['Due @2026-11-12']] })
  })

  it('takes one emoji as an icon, flags and keycaps included, and nothing else', async () => {
    const ws = workspace()
    open(ws)
    await update([
      { page: hex(row(1)), icon: '🇯🇵' },
      { page: hex(row(2)), icon: '1️⃣' },
    ])
    expect(ws.records.get(row(1))!.format).toEqual({ page_icon: '🇯🇵' })
    expect(ws.records.get(row(2))!.format).toEqual({ page_icon: '1️⃣' })
    await expect(update([{ page: hex(row(3)), icon: '📝 notes' }])).rejects.toThrow('`icon` must be an emoji.')
  })

  it('keeps the old title in previews when Notion refuses the rename', async () => {
    const ws = workspace()
    open(ws)
    await readPage.run({ page: hex(PAGE) })
    ws.reject = true
    await expect(update([{ page: hex(PAGE), title: 'Renamed page' }])).rejects.toThrow()
    expect((await createPage.preview!({ title: 'T', parent: hex(PAGE) }))?.split('\n')[2]).toBe(
      `At the end of: Fixture page ^${hex(PAGE)}`,
    )
  })

  it('shows a renamed page by its new title in later previews', async () => {
    const ws = workspace()
    open(ws)
    await readPage.run({ page: hex(PAGE) })
    await update([{ page: hex(PAGE), title: 'Renamed page' }])
    expect((await createPage.preview!({ title: 'T', parent: hex(PAGE) }))?.split('\n')[2]).toBe(
      `At the end of: Renamed page ^${hex(PAGE)}`,
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

  it('refuses arguments that are not what its schema says, without asking Notion', async () => {
    const tab = open(workspace())
    const refused: [unknown, string][] = [
      [undefined, '`pages` must be a list with at least one page.'],
      [{ page: hex(row(1)), title: 'A' }, '`pages` must be a list with at least one page.'],
      [[hex(row(1))], 'Page 1 needs `page`: the id or URL of a page or row.'],
      [[{ page: hex(row(1)), title: 'A' }, { title: 'B' }], 'Page 2 needs `page`: the id or URL of a page or row.'],
      [[{ page: hex(row(1)), title: 5 }], 'Page 1: `title` must not be empty.'],
      [[{ page: hex(row(1)), icon: 5 }], 'Page 1: `icon` must be an emoji.'],
      [[{ page: hex(row(1)), properties: 'Status: Done' }], '`properties` must be an object of values by name.'],
      [
        [{ page: hex(row(1)), properties: { Status: { name: 'Done' } } }],
        'The value for “Status” must be text, a number, Yes/No, or a list.',
      ],
      [[{ page: hex(row(1)), title: 'A', cover: 'x' }], '`pages[0]`: Unrecognized key: "cover"'],
    ]
    for (const [pages, message] of refused) await expect(update(pages)).rejects.toThrow(message)
    expect(updatePages.preview!({ pages: [{ title: 'B' }] })).toBeUndefined()
    expect(tab.sent).toEqual([])
  })

  it('refuses a property named __proto__ instead of leaving it out, and writes nothing', async () => {
    const ws = workspace()
    const tab = open(ws)
    // As the model's JSON gives it: a key of the object's own, which an object literal would not make.
    const pages = JSON.parse(`[{"page":"${hex(row(1))}","properties":{"__proto__":"x","Status":"Done"}}]`)
    await expect(update(pages)).rejects.toThrow(
      '`pages[0].properties.__proto__`: "__proto__" can\'t be used as a name.',
    )
    expect(updatePages.preview!({ pages })).toBeUndefined()
    expect(tab.sent).toEqual([])
    expect(ws.transactions).toEqual([])
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

  it('says what happens when the parent may be a page or a database', async () => {
    expect((await createPage.preview!({ title: 'T', parent: hex(DB) }))?.split('\n')[2]).toBe(
      `In: ^${hex(DB)} (at its end if it is a page; as a new row if it is a database)`,
    )
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
