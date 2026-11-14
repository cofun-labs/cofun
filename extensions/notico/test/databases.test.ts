// Creating databases and changing their properties (create_database and update_database_schema in
// extensions/notico/src/tools/database.ts), against a fake Notion workspace that applies transactions the way
// Notion's web client was seen to make them.
import { afterEach, describe, expect, it } from 'vitest'
import { QUERY_LOAD, createDatabase, queryDatabase, updateDatabaseSchema } from '../src/tools/database'
import { forgetReads } from '../src/tools/memory'
import { createPage } from '../src/tools/write'
import { newSchema } from '../src/notion/schema'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, USER, restoreGlobals } from './notion-tab'

afterEach(() => {
  restoreGlobals()
  forgetReads()
})

const hex = (s: string) => s.replace(/-/g, '')
const DB = 'db0db0db-0000-4000-8000-000000000001'
const COLLECTION = 'c0c0c0c0-0000-4000-8000-000000000001'
const VIEW = 'e0e0e0e0-0000-4000-8000-000000000001'
const OTHER = '2a2a2a2a-0000-4000-8000-000000000020'
const TEXT = '1b1b1b1b-0000-4000-8000-000000000030'
const row = (n: number) => `a1a1a1a1-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const DB_URL = `https://app.notion.com/${hex(DB)}`

type Def = { name: string; type: string; options?: { id: string; value: string; color?: string }[] }
const SCHEMA: Record<string, Def> = {
  title: { name: 'Task', type: 'title' },
  'a:a': {
    name: 'Stage',
    type: 'select',
    options: [
      { id: 'o1', value: 'Idea', color: 'gray' },
      { id: 'o2', value: 'Draft', color: 'blue' },
    ],
  },
  'b:b': {
    name: 'Tags',
    type: 'multi_select',
    options: [
      { id: 't1', value: 'Bug' },
      { id: 't2', value: 'Docs' },
    ],
  },
  'c:c': { name: 'Notes', type: 'text' },
  'd:d': {
    name: 'Status',
    type: 'status',
    options: [{ id: 's1', value: 'Not started' }],
  },
}

function rowRecord(n: number, title: string, props: Record<string, string> = {}) {
  return {
    id: row(n),
    type: 'page',
    parent_id: COLLECTION,
    parent_table: 'collection',
    properties: { title: [[title]], ...Object.fromEntries(Object.entries(props).map(([k, v]) => [k, [[v]]])) },
  }
}

function workspace(
  rows = [
    rowRecord(1, 'Write post', { 'a:a': 'Draft', 'b:b': 'Docs,Bug', 'c:c': 'first' }),
    rowRecord(2, 'Plan launch', { 'a:a': 'Idea', 'b:b': 'Bug' }),
    rowRecord(3, 'Fix login', { 'a:a': 'Draft' }),
  ],
) {
  const ws = new FakeWorkspace(
    [
      {
        id: PAGE,
        type: 'page',
        properties: { title: [['Fixture page']] },
        content: [TEXT],
        parent_id: SPACE,
        parent_table: 'space',
      },
      { id: TEXT, type: 'text', properties: { title: [['Hello']] }, parent_id: PAGE, parent_table: 'block' },
      {
        id: OTHER,
        type: 'page',
        properties: { title: [['Other page']] },
        content: [],
        parent_id: SPACE,
        parent_table: 'space',
      },
      {
        id: DB,
        type: 'collection_view_page',
        collection_id: COLLECTION,
        view_ids: [VIEW],
        parent_id: SPACE,
        parent_table: 'space',
      },
      ...rows,
    ],
    SPACE,
  )
  ws.collections.set(COLLECTION, {
    id: COLLECTION,
    version: 1,
    name: [['Content']],
    schema: structuredClone(SCHEMA),
    space_id: SPACE,
  })
  return ws
}

function open(ws: FakeWorkspace, url = PAGE_URL) {
  const tab = new FakeNotionTab(url)
  tab.workspace = ws
  return tab.install()
}

const schemaOf = (ws: FakeWorkspace, id = COLLECTION) =>
  (ws.collections.get(id) ?? ws.records.get(id))!.schema as Record<string, Def>
const named = (schema: Record<string, Def>, name: string) =>
  Object.entries(schema).find(([, d]) => d.name === name) ?? []
const values = (ws: FakeWorkspace, n: number) => ws.records.get(row(n))!.properties
const change = async (changes: unknown, database: string | undefined = hex(DB)) =>
  (await updateDatabaseSchema.run({ ...(database ? { database } : {}), changes })) as string

describe('UC-NOTICO-NOTION-012 create and change databases', () => {
  it('[UC-NOTICO-NOTION-012-S01] creates a database with its properties and options at the end of the page', async () => {
    const ws = workspace()
    open(ws)
    const result = (await createDatabase.run({
      parent: PAGE_URL,
      title: 'Content calendar',
      title_property: 'Post',
      properties: [
        { name: 'Stage', type: 'select', options: ['Idea', 'Draft', 'Published'] },
        { name: 'Channels', type: 'multi_select', options: ['Blog', 'Newsletter'] },
        { name: 'Publish on', type: 'date' },
        { name: 'Status', type: 'status' },
        { name: 'Words', type: 'number' },
      ],
    })) as string
    expect(ws.transactions).toHaveLength(1)
    const [text, dbId] = ws.records.get(PAGE)!.content as string[]
    expect(text).toBe(TEXT)
    const db = ws.records.get(dbId)!
    expect(db).toMatchObject({ type: 'collection_view_page', parent_id: PAGE, parent_table: 'block', alive: true })
    const collection = ws.records.get(db.collection_id as string)!
    expect(collection.name).toEqual([['Content calendar']])
    const schema = collection.schema as Record<string, Def>
    expect(Object.values(schema).map((d) => [d.name, d.type, d.options?.map((o) => o.value)])).toEqual([
      ['Post', 'title', undefined],
      ['Stage', 'select', ['Idea', 'Draft', 'Published']],
      ['Channels', 'multi_select', ['Blog', 'Newsletter']],
      ['Publish on', 'date', undefined],
      ['Status', 'status', ['Not started', 'In progress', 'Done']],
      ['Words', 'number', undefined],
    ])
    // The view shows every property, in the order given.
    const view = ws.records.get((db.view_ids as string[])[0])!
    expect(
      (view.format as { table_properties: { property: string }[] }).table_properties.map((p) => p.property),
    ).toEqual(Object.keys(schema))
    expect(result).toBe(
      [
        `Created the database “Content calendar” ^${hex(dbId)} at the end of ^${hex(PAGE)}.`,
        'Properties: Post (title), Stage (select), Channels (multi_select), Publish on (date), Status (status), Words (number)',
        `URL: https://app.notion.com/p/${hex(dbId)}`,
      ].join('\n'),
    )
    // The side panel counts what the call touched from this result.
    expect(createDatabase.touched({}, String(result))).toEqual({ changed: [hex(dbId)] })

    // It is a database the other tools can use: a row goes in with its options.
    await createPage.run({ parent: hex(dbId), title: 'Launch post', properties: { Stage: 'Draft' } })
    const added = [...ws.records.values()].find((r) => r.parent_id === db.collection_id)!
    expect(added.properties).toMatchObject({ [named(schema, 'Stage')[0]!]: [['Draft']] })
  })

  it('[UC-NOTICO-NOTION-012-S01] creates it with Name as the title column, in another page, and shows the preview', async () => {
    const ws = workspace()
    open(ws)
    const args = { parent: hex(OTHER), title: 'Reading list', properties: [{ name: 'Done', type: 'checkbox' }] }
    expect(createDatabase.needsConfirmation).toBeUndefined()
    expect(await createDatabase.preview!(args)).toBe(
      [
        'Create a database',
        'Title: Reading list',
        `At the end of: ^${hex(OTHER)}`,
        'Properties:',
        '    Name (title)',
        '    Done (checkbox)',
      ].join('\n'),
    )
    await createDatabase.run(args)
    const [dbId] = ws.records.get(OTHER)!.content as string[]
    const collection = ws.records.get(ws.records.get(dbId)!.collection_id as string)!
    expect(Object.values(collection.schema as object).map((d: Def) => d.name)).toEqual(['Name', 'Done'])
    expect(ws.records.get(PAGE)!.content).toEqual([TEXT])
  })

  it('names the signed-in user as the creator of a new database, and last editor of a changed one', async () => {
    const ws = workspace()
    open(ws)
    await createDatabase.run({ parent: PAGE_URL, title: 'Content calendar' })
    const db = ws.records.get((ws.records.get(PAGE)!.content as string[]).at(-1)!)!
    expect(db).toMatchObject({
      created_by_id: USER,
      created_by_table: 'notion_user',
      last_edited_by_id: USER,
      last_edited_by_table: 'notion_user',
    })
    expect(ws.records.get(db.collection_id as string)).toMatchObject({
      created_by_id: USER,
      created_by_table: 'notion_user',
      last_edited_by_id: USER,
      last_edited_by_table: 'notion_user',
    })
    expect(ws.records.get(PAGE)).toMatchObject({ last_edited_by_id: USER, last_edited_by_table: 'notion_user' })
    await change([{ action: 'add_property', property: 'Owner', type: 'person' }])
    expect(ws.collections.get(COLLECTION) ?? ws.records.get(COLLECTION)).toMatchObject({
      last_edited_by_id: USER,
      last_edited_by_table: 'notion_user',
    })
  })

  it('[UC-NOTICO-NOTION-012-S02] adds and renames properties and adds options in one change, keeping every value', async () => {
    const ws = workspace()
    open(ws)
    const before = [1, 2, 3].map((n) => structuredClone(values(ws, n)))
    const result = await change([
      { action: 'rename_property', property: 'stage', to: 'Phase' },
      { action: 'add_options', property: 'Phase', options: ['Review', 'Published'] },
      { action: 'add_property', property: 'Owner', type: 'person' },
      { action: 'add_property', property: 'Channel', type: 'select', options: ['Blog'] },
      { action: 'add_options', property: 'Tags', options: ['Design'] },
      { action: 'rename_property', property: 'Task', to: 'Title' },
    ])
    expect(ws.transactions).toHaveLength(1)
    const schema = schemaOf(ws)
    expect(schema['a:a']).toMatchObject({ name: 'Phase', type: 'select' })
    expect(schema['a:a'].options!.map((o) => o.value)).toEqual(['Idea', 'Draft', 'Review', 'Published'])
    // Existing options keep their ids and colors.
    expect(schema['a:a'].options!.slice(0, 2)).toEqual(SCHEMA['a:a'].options)
    expect(schema['b:b'].options!.map((o) => o.value)).toEqual(['Bug', 'Docs', 'Design'])
    expect(schema.title.name).toBe('Title')
    expect(named(schema, 'Owner')[1]).toEqual({ name: 'Owner', type: 'person' })
    expect(named(schema, 'Channel')[1]!.options!.map((o) => o.value)).toEqual(['Blog'])
    expect([1, 2, 3].map((n) => values(ws, n))).toEqual(before)
    expect(result).toBe(
      [
        `Changed the properties of “Content” ^${hex(DB)}:`,
        'Rename the property “Stage” to “Phase”',
        'Add options to “Phase”: Review, Published',
        'Add the property “Owner” (person)',
        'Add the property “Channel” (select: Blog)',
        'Add options to “Tags”: Design',
        'Rename the property “Task” to “Title”',
        'Properties now: Title (title), Phase (select), Tags (multi_select), Notes (text), Status (status), ' +
          'Owner (person), Channel (select)',
      ].join('\n'),
    )
    // The side panel names the database from this result.
    expect(updateDatabaseSchema.describe({}, String(result))).toMatchObject({ name: 'Content' })
    expect(updateDatabaseSchema.touched({}, String(result))).toEqual({ changed: [hex(DB)] })
  })

  it('[UC-NOTICO-NOTION-012-S02] changes the open database without asking, in few Notion requests', async () => {
    const ws = workspace()
    const tab = open(ws, DB_URL)
    expect(updateDatabaseSchema.needsConfirmation).toBeUndefined()
    await change([{ action: 'add_property', property: 'Due', type: 'date' }], undefined)
    expect(named(schemaOf(ws), 'Due')[1]).toEqual({ name: 'Due', type: 'date' })
    // The database, its collection, and the change.
    expect(tab.sent.map((r) => r.url.split('/api/v3/')[1])).toEqual([
      'syncRecordValuesMain',
      'syncRecordValuesMain',
      'saveTransactionsFanout',
    ])
  })

  it('[UC-NOTICO-NOTION-012-S03] renames an option in every row that has it, and in no other', async () => {
    const ws = workspace()
    open(ws)
    const result = await change([
      { action: 'rename_option', property: 'Stage', option: 'draft', to: 'Writing' },
      { action: 'rename_option', property: 'Tags', option: 'Bug', to: 'Defect' },
    ])
    expect(schemaOf(ws)['a:a'].options).toEqual([
      { id: 'o1', value: 'Idea', color: 'gray' },
      { id: 'o2', value: 'Writing', color: 'blue' },
    ])
    expect(values(ws, 1)).toMatchObject({ 'a:a': [['Writing']], 'b:b': [['Docs,Defect']], 'c:c': [['first']] })
    expect(values(ws, 2)).toMatchObject({ 'a:a': [['Idea']], 'b:b': [['Defect']] })
    expect(values(ws, 3)).toMatchObject({ 'a:a': [['Writing']] })
    expect(ws.transactions).toHaveLength(1)
    expect(result).toContain('Rename the option “Draft” of “Stage” to “Writing”, in every row that has it')
    expect(result).toContain('Rows renamed with their options: 3.')

    // query_database shows the new names.
    const table = (await queryDatabase.run({ database: hex(DB) })) as string
    expect(table).toContain('| Write post | Writing |')
  })

  it('[UC-NOTICO-NOTION-012-S03] renames several options of one property, even when the names swap', async () => {
    const ws = workspace()
    open(ws)
    await change([
      { action: 'rename_option', property: 'Tags', option: 'Bug', to: 'Defect' },
      { action: 'rename_option', property: 'Tags', option: 'Docs', to: 'Guide' },
    ])
    expect(values(ws, 1)).toMatchObject({ 'b:b': [['Guide,Defect']] })
    expect(values(ws, 2)).toMatchObject({ 'b:b': [['Defect']] })

    // Defect and Guide trade names: each row keeps the option it had, under its new name.
    await change([
      { action: 'rename_option', property: 'Tags', option: 'Defect', to: 'X' },
      { action: 'rename_option', property: 'Tags', option: 'Guide', to: 'Defect' },
      { action: 'rename_option', property: 'Tags', option: 'X', to: 'Guide' },
    ])
    expect(schemaOf(ws)['b:b'].options!.map((o) => [o.id, o.value])).toEqual([
      ['t1', 'Guide'],
      ['t2', 'Defect'],
    ])
    expect(values(ws, 1)).toMatchObject({ 'b:b': [['Defect,Guide']] })
    expect(values(ws, 2)).toMatchObject({ 'b:b': [['Guide']] })
  })

  it('[UC-NOTICO-NOTION-012-S04] refuses removing the title column, and two properties or options with one name', async () => {
    const ws = workspace()
    open(ws)
    const refusals: [unknown[], string][] = [
      [[{ action: 'remove_property', property: 'Task' }], '“Task” is the title column'],
      [[{ action: 'rename_property', property: 'Notes', to: 'stage' }], 'There is already a property “Stage”.'],
      [[{ action: 'add_property', property: 'Tags', type: 'text' }], 'There is already a property “Tags”.'],
      [
        [{ action: 'rename_option', property: 'Stage', option: 'Draft', to: 'idea' }],
        '“Stage” already has an option “Idea”.',
      ],
      [[{ action: 'add_options', property: 'Stage', options: ['Draft'] }], '“Stage” already has an option “Draft”.'],
      [[{ action: 'add_options', property: 'Tags', options: ['A, B'] }], "can't contain commas"],
      [[{ action: 'add_options', property: 'Status', options: ['Blocked'] }], 'can only be changed in Notion'],
      [[{ action: 'add_options', property: 'Notes', options: ['A'] }], 'it has no options'],
      [[{ action: 'add_property', property: 'Score', type: 'formula' }], "can't be a formula type"],
      [[{ action: 'remove_option', property: 'Stage', option: 'Gone' }], '“Stage” has no option “Gone”.'],
      [[{ action: 'change_type', property: 'Notes', type: 'number' }], '`action` must be one of'],
    ]
    for (const [changes, message] of refusals) {
      // A good change first: nothing of it is written either.
      await expect(change([{ action: 'add_property', property: 'Due', type: 'date' }, ...changes])).rejects.toThrow(
        message,
      )
    }
    expect(ws.transactions).toHaveLength(0)
    expect(schemaOf(ws)).toEqual(SCHEMA)
  })

  it('[UC-NOTICO-NOTION-012-S04] refuses renaming an option when not every row can be read', async () => {
    const rows = Array.from({ length: QUERY_LOAD + 1 }, (_, i) => rowRecord(i + 1, `Row ${i + 1}`, { 'a:a': 'Draft' }))
    const ws = workspace(rows)
    open(ws)
    await expect(
      change([{ action: 'rename_option', property: 'Stage', option: 'Draft', to: 'Writing' }]),
    ).rejects.toThrow(`more than ${QUERY_LOAD} rows`)
    expect(ws.transactions).toHaveLength(0)
    expect(values(ws, QUERY_LOAD + 1)).toMatchObject({ 'a:a': [['Draft']] })
  })

  it('[UC-NOTICO-NOTION-012-S04] refuses renaming an option when Notion leaves out a row', async () => {
    const ws = workspace()
    const tab = open(ws)
    // The query lists a row it doesn't return.
    tab.respond('queryCollection', 200, {
      result: {
        reducerResults: {
          collection_group_results: { type: 'results', blockIds: [row(1), row(9)], hasMore: false },
        },
      },
      recordMap: {
        __version__: 3,
        block: {
          [row(1)]: { spaceId: SPACE, value: { role: 'editor', value: { version: 1, ...ws.records.get(row(1)) } } },
        },
      },
    })
    await expect(
      change([{ action: 'rename_option', property: 'Stage', option: 'Draft', to: 'Writing' }]),
    ).rejects.toThrow("didn't return every row")
    expect(ws.transactions).toHaveLength(0)
  })

  it('[UC-NOTICO-NOTION-012-S05] removes a property and an option, and the preview says their values go', async () => {
    const ws = workspace()
    open(ws)
    const changes = [
      { action: 'remove_property', property: 'Notes' },
      { action: 'remove_option', property: 'Tags', option: 'Bug' },
    ]
    expect(await updateDatabaseSchema.preview!({ database: hex(DB), changes })).toBe(
      [
        `Change the properties of ^${hex(DB)}`,
        '    Remove the property “Notes”: its values in every row are lost',
        '    Remove the option “Bug” of “Tags”: rows that have it lose it',
      ].join('\n'),
    )
    const result = await change(changes)
    const collection = ws.collections.get(COLLECTION)!
    expect(named(collection.schema as Record<string, Def>, 'Notes')).toEqual([])
    // As Notion's "Delete property" does: it goes to the deleted properties.
    expect(collection.deleted_schema).toEqual({ 'c:c': SCHEMA['c:c'] })
    expect(schemaOf(ws)['b:b'].options).toEqual([{ id: 't2', value: 'Docs' }])
    expect(result).toContain('Remove the property “Notes”: its values in every row are lost')
    expect(result).toContain('Remove the option “Bug” of “Tags”: rows that have it lose it')
    // The rows still have the other properties' values.
    expect(values(ws, 1)).toMatchObject({ title: [['Write post']], 'a:a': [['Draft']] })
  })
})

describe('create_database and update_database_schema', () => {
  it('never gives a new property an all-digit key, which would move it first', () => {
    // A key of four digits comes first, then letters: ABCD for the first property, EFGH for the second.
    const at = (c: string) => '0123456789ABCDEFGH'.indexOf(c)
    const picks = [...'1111ABCD2222EFGH'].map((c) => (c >= 'A' ? at(c) - 10 : 52 + at(c)) + 0.5)
    const random = () => picks.shift()! / 62
    const schema = newSchema(
      'Name',
      [
        { name: 'A', type: 'text' },
        { name: 'B', type: 'text' },
      ],
      { random },
    )
    expect(Object.keys(schema)).toEqual(['title', 'ABCD', 'EFGH'])
    expect(Object.values(schema).map((d) => d.name)).toEqual(['Name', 'A', 'B'])
  })

  it('refuses a database or a block as the parent, and bad properties, before writing', async () => {
    const ws = workspace()
    open(ws)
    await expect(createDatabase.run({ parent: hex(DB), title: 'Nested' })).rejects.toThrow('That parent is a database')
    await expect(createDatabase.run({ parent: hex(TEXT), title: 'X' })).rejects.toThrow('a block inside a page')
    const bad: [unknown, string][] = [
      [
        [
          { name: 'A', type: 'text' },
          { name: 'a', type: 'number' },
        ],
        'There is already a property “A”.',
      ],
      [[{ name: 'Name', type: 'text' }], 'There is already a property “Name”.'],
      [[{ name: 'Status', type: 'status', options: ['Open'] }], "Notion's options"],
      [[{ name: 'Due', type: 'date', options: ['x'] }], 'only selects and multi-selects have options'],
      [[{ name: 'Who', type: 'people' }], "can't be a people type"],
      [[{ name: ' ', type: 'text' }], 'A property name must not be empty.'],
    ]
    for (const [properties, message] of bad)
      await expect(createDatabase.run({ parent: PAGE_URL, title: 'Tracker', properties })).rejects.toThrow(message)
    expect(ws.transactions).toHaveLength(0)
  })

  it('reports an unknown outcome so the agent looks before trying again', async () => {
    const ws = workspace()
    open(ws)
    ws.failAfterApply = true
    await expect(createDatabase.run({ parent: PAGE_URL, title: 'Tracker' })).rejects.toMatchObject({
      code: 'outcome_unknown',
      message: expect.stringContaining(`Read ^${hex(PAGE)} and check for “Tracker” before trying again.`),
    })
    ws.failAfterApply = true
    await expect(change([{ action: 'add_property', property: 'Due', type: 'date' }])).rejects.toMatchObject({
      code: 'outcome_unknown',
      message: expect.stringContaining(`Query ^${hex(DB)} to see its properties before trying again.`),
    })
  })

  it('renames an option with one read of the rows, in one change', async () => {
    const ws = workspace()
    const tab = open(ws)
    await change([{ action: 'rename_option', property: 'Stage', option: 'Idea', to: 'Someday' }])
    expect(values(ws, 2)).toMatchObject({ 'a:a': [['Someday']] })
    expect(tab.sent.map((r) => r.url.split('/api/v3/')[1])).toEqual([
      'syncRecordValuesMain',
      'syncRecordValuesMain',
      'queryCollection',
      'saveTransactionsFanout',
    ])
  })
})

describe('create_database and update_database_schema arguments', () => {
  it('create_database refuses arguments that are not what its schema says, without asking Notion', async () => {
    const tab = open(workspace())
    const create = (args: Record<string, unknown>) =>
      createDatabase.run({ parent: PAGE_URL, title: 'Tracker', ...args })
    const many = Array.from({ length: 31 }, (_, n) => ({ name: `P${n}`, type: 'text' }))
    const refused: [Record<string, unknown>, string][] = [
      [{ parent: undefined }, '`parent` is required: the URL or id of the page to create it in.'],
      [{ parent: ['x'] }, '`parent` is required'],
      [{ title: undefined }, '`title` must not be empty.'],
      [{ title_property: 5 }, 'The title column must not be empty.'],
      [{ properties: { name: 'A', type: 'text' } }, '`properties` must be a list of properties.'],
      [{ properties: many }, 'A database can be created with at most 30 properties.'],
      [{ properties: [{ type: 'text' }] }, 'A property name must not be empty.'],
      [{ properties: [{ name: 'A', type: 'text' }, { name: 'B' }] }, "Property 2 can't be a property without a type."],
      [{ properties: [{ name: 'A', type: 'Text' }] }, "Property 1 can't be a Text type. Use one of: text, number,"],
      [
        { properties: [{ name: 'A', type: 'select', options: 'x' }] },
        '`properties[0].options`: Invalid input: expected array, received string',
      ],
      [
        { properties: [{ name: 'A', type: 'select', options: Array.from({ length: 31 }, (_, n) => `o${n}`) }] },
        'At most 30 options can be added at once.',
      ],
      [{ properties: [{ name: 'A', type: 'text', color: 'red' }] }, '`properties[0]`: Unrecognized key: "color"'],
      [{ icon: '📋' }, 'Unrecognized key: "icon"'],
    ]
    for (const [args, message] of refused) await expect(create(args)).rejects.toThrow(message)
    expect(createDatabase.preview!({ title: 'Tracker' })).toBeUndefined()
    expect(tab.sent).toEqual([])
  })

  it('update_database_schema refuses arguments that are not what its schema says, without asking Notion', async () => {
    const tab = open(workspace())
    const many = Array.from({ length: 31 }, (_, n) => ({ action: 'remove_property', property: `P${n}` }))
    const refused: [unknown, string][] = [
      [undefined, '`changes` must be a list with at least one change.'],
      [[], '`changes` must be a list with at least one change.'],
      [{ action: 'remove_property', property: 'Notes' }, '`changes` must be a list with at least one change.'],
      [many, 'At most 30 changes can be made in one call.'],
      [[{ property: 'Notes' }], 'Change 1: `action` must be one of add_property, rename_property,'],
      [[{ action: 'remove_property' }], 'Change 1 needs `property`.'],
      [[{ action: 'remove_property', property: ' ' }], 'Change 1 (remove_property) needs `property`.'],
      [[{ action: 'add_property', property: 'Due' }], 'Change 1 (add_property) needs `type`.'],
      [[{ action: 'add_property', property: 'Due', type: 'Date' }], "Change 1: the property can't be a Date type."],
      [[{ action: 'rename_property', property: 'Notes' }], 'Change 1 (rename_property) needs `to`.'],
      [[{ action: 'rename_option', property: 'Stage', to: 'X' }], 'Change 1 (rename_option) needs `option`.'],
      [[{ action: 'remove_option', property: 'Stage' }], 'Change 1 (remove_option) needs `option`.'],
      [[{ action: 'add_options', property: 'Stage' }], 'Change 1 (add_options) needs `options`: a list of names.'],
      [
        [{ action: 'add_options', property: 'Stage', options: 'Draft' }],
        '`changes[0].options`: Invalid input: expected array, received string',
      ],
      [[{ action: 'rename_property', property: 'Notes', to: 5 }], '`changes[0].to`: Invalid input: expected string'],
      [[{ action: 'remove_property', property: 'Notes', force: true }], '`changes[0]`: Unrecognized key: "force"'],
    ]
    for (const [changes, message] of refused) await expect(change(changes)).rejects.toThrow(message)
    expect(updateDatabaseSchema.preview!({ changes: [{ action: 'drop', property: 'Notes' }] })).toBeUndefined()
    expect(tab.sent).toEqual([])
  })
})
