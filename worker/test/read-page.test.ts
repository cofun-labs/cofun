// The read_page tool (extension/src/tools.ts) against a fake Notion tab, with pages built in the
// shape Notion's loadPageChunk returns them (see fixtures/notion/ for recorded examples).
import { afterEach, describe, expect, it } from 'vitest'
import { blockRefs, splitIntoParts } from '../../extension/src/notion/markdown'
import { PART_CHARS, readPage } from '../../extension/src/tools'
import { FakeNotionTab, PAGE, PAGE_URL, SPACE, USER, fixture, restoreGlobals } from './notion-tab'

afterEach(restoreGlobals)

const hex = (id: string) => id.replace(/-/g, '')
const PAGE_HEX = hex(PAGE)
/** A block id whose last 8 hex digits are `n`, so references are easy to read. */
const id = (n: number) => `b0b0b0b0-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const COLLECTION = 'c0c0c0c0-0000-4000-8000-000000000001'

type Fields = Record<string, unknown>
type Records = Record<string, Record<string, unknown>>

/** One record as Notion returns it: `{ spaceId, value: { role, value: <record> } }`. */
function wrapped(record: Fields) {
  return { spaceId: SPACE, value: { role: 'editor', value: { version: 1, alive: true, space_id: SPACE, ...record } } }
}

/** A block under `parent`. Text is a plain string or Notion rich text. */
function block(blockId: string, type: string, text?: string | unknown[], fields: Fields = {}, parent = PAGE) {
  const title = typeof text === 'string' ? [[text]] : text
  return {
    [blockId]: wrapped({
      id: blockId,
      type,
      parent_id: parent,
      parent_table: 'block',
      ...(title ? { properties: { title } } : {}),
      ...fields,
    }),
  }
}

/** A page whose content is `children` (ids), with `records` for its blocks and anything else. */
function chunk(children: string[], records: Records = {}, page: Fields = {}) {
  const { block: blocks, ...tables } = records
  return {
    cursor: { stack: [] },
    recordMap: {
      __version__: 3,
      block: {
        [PAGE]: wrapped({
          id: PAGE,
          type: 'page',
          properties: { title: [['Fixture page']] },
          content: children,
          parent_id: SPACE,
          parent_table: 'space',
          ...page,
        }),
        ...blocks,
      },
      notion_user: { [USER]: wrapped({ id: USER, name: 'Fixture User' }) },
      ...tables,
    },
  }
}

/** Notion's answer when a later part checks the page can still be opened: the page record. */
function stillOpen(page: { recordMap: { block: Record<string, unknown> } }, pageId = PAGE) {
  return { recordMap: { __version__: 3, block: { [pageId]: page.recordMap.block[pageId] } } }
}

function openPage(...pages: unknown[]): FakeNotionTab {
  const tab = new FakeNotionTab(PAGE_URL)
  for (const page of pages) tab.respond('loadPageChunk', 200, page)
  return tab.install()
}

async function read(args: Record<string, unknown> = {}): Promise<string> {
  return (await readPage.run(args)) as string
}

/** The page content of a read_page result, without its header. */
function body(result: string): string {
  return result.slice(result.indexOf('\n\n') + 2)
}

describe('UC-NOTION-001 read a page', () => {
  it('[UC-NOTION-001-S01] reads common content in page order, with its structure and a reference on each block', async () => {
    const blocks = {
      ...block(id(1), 'header', 'Plan'),
      ...block(id(2), 'sub_header', 'Goals'),
      ...block(id(3), 'text', [
        ['Ship '],
        ['fast', [['b']]],
        [' and '],
        ['safe', [['i']]],
        [', see '],
        ['docs', [['a', 'https://example.com/docs']]],
        [' or run '],
        ['pnpm check', [['c']]],
        ['.'],
      ]),
      ...block(id(4), 'text', [
        ['Ask '],
        ['‣', [['u', USER]]],
        [' about '],
        ['‣', [['p', PAGE]]],
        [' by '],
        ['‣', [['d', { type: 'date', start_date: '2026-11-20' }]]],
      ]),
      ...block(id(5), 'bulleted_list', 'First', { content: [id(6)] }),
      ...block(id(6), 'bulleted_list', 'Nested', {}, id(5)),
      ...block(id(7), 'numbered_list', 'One'),
      ...block(id(8), 'numbered_list', 'Two'),
      ...block(id(9), 'to_do', 'Done thing', { properties: { title: [['Done thing']], checked: [['Yes']] } }),
      ...block(id(10), 'to_do', 'Open thing', { properties: { title: [['Open thing']], checked: [['No']] } }),
      ...block(id(11), 'toggle', 'More', { content: [id(12)] }),
      ...block(id(12), 'text', 'Hidden detail', {}, id(11)),
      ...block(id(13), 'quote', 'Quoted'),
      ...block(id(14), 'callout', 'Heads up', { format: { page_icon: '💡' } }),
      ...block(id(15), 'code', undefined, {
        properties: { title: [['const a = 1\nconsole.log(a)']], language: [['TypeScript']] },
      }),
      ...block(id(16), 'divider'),
      ...block(id(17), 'table', undefined, {
        content: [id(18), id(19)],
        format: { table_block_column_order: ['c1', 'c2'], table_block_column_header: true },
      }),
      ...block(id(18), 'table_row', undefined, { properties: { c1: [['Name']], c2: [['Owner']] } }, id(17)),
      ...block(id(19), 'table_row', undefined, { properties: { c1: [['Read']], c2: [['A|B\\C']] } }, id(17)),
      ...block(id(20), 'equation', 'e=mc^2'),
      ...block(id(21), 'bookmark', undefined, {
        properties: { title: [['Example']], link: [['https://example.com']] },
      }),
      ...block(id(22), 'image', undefined, { properties: { caption: [['Diagram']] } }),
      // An empty paragraph is only spacing.
      ...block(id(23), 'text'),
    }
    const top = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 20, 21, 22, 23].map(id)
    openPage(chunk(top, { block: blocks }))

    expect(await read()).toBe(
      [
        `Page: Fixture page ^${PAGE_HEX}`,
        `URL: https://app.notion.com/${PAGE_HEX}`,
        '',
        '# Plan ^00000001',
        '## Goals ^00000002',
        'Ship **fast** and *safe*, see [docs](https://example.com/docs) or run `pnpm check`. ^00000003',
        `Ask @Fixture User about [Fixture page](${PAGE_HEX}) by @2026-11-20 ^00000004`,
        '- First ^00000005',
        '  - Nested ^00000006',
        '1. One ^00000007',
        '2. Two ^00000008',
        '- [x] Done thing ^00000009',
        '- [ ] Open thing ^0000000a',
        '▸ More ^0000000b',
        '  Hidden detail ^0000000c',
        '> Quoted ^0000000d',
        '> [!💡] Heads up ^0000000e',
        '```typescript',
        'const a = 1',
        'console.log(a)',
        '```',
        '^0000000f',
        '--- ^00000010',
        '| Name | Owner |',
        '| --- | --- |',
        '| Read | A\\|B\\\\C |',
        '^00000011',
        '$$e=mc^2$$ ^00000014',
        '[Example](https://example.com) ^00000015',
        '[image: Diagram] ^00000016',
      ].join('\n'),
    )
  })

  it('[UC-NOTION-001-S01] reads the recorded fixture page, following its chunks', async () => {
    new FakeNotionTab(PAGE_URL)
      .respond('loadPageChunk', 200, fixture('load-page-chunk-0'))
      .respond('loadPageChunk', 200, fixture('load-page-chunk-1'))
      .install()
    expect(body(await read())).toBe(
      ['Hello **bold** ^00000011', '- [ ] Ship it ^00000012', '# Next steps ^00000013'].join('\n'),
    )
  })

  it('[UC-NOTION-001-S02] marks content it cannot show, and keeps everything after it', async () => {
    openPage(
      chunk([id(1), id(2), id(3)], {
        block: {
          ...block(id(1), 'text', 'Before'),
          ...block(id(2), 'transclusion_container', undefined, { content: [id(4)] }),
          ...block(id(4), 'text', 'Synced text', {}, id(2)),
          ...block(id(3), 'text', 'After'),
        },
      }),
    )
    expect(body(await read())).toBe(
      [
        'Before ^00000001',
        '[unsupported block: transclusion_container] ^00000002',
        '  Synced text ^00000004',
        'After ^00000003',
      ].join('\n'),
    )
  })

  it('[UC-NOTION-001-S03] reads a long page part by part, and says when there is more', async () => {
    const count = 400
    const ids = Array.from({ length: count }, (_, i) => id(i + 1))
    const blocks = Object.assign({}, ...ids.map((b, i) => block(b, 'text', `Paragraph ${i + 1} ${'x'.repeat(60)}`)))
    const page = chunk(ids, { block: blocks })
    // The page is loaded once: later parts come from the same read, so they fit together.
    const tab = openPage(page)
    for (let i = 0; i < 10; i++) tab.respond('syncRecordValuesMain', 200, stillOpen(page))

    const first = await read()
    const parts = Number(/^Part 1 of (\d+)\. Read part 2 for more\.$/m.exec(first)?.[1])
    expect(parts).toBeGreaterThan(1)
    const texts = [body(first)]
    for (let part = 2; part <= parts; part++) {
      const result = await read({ part })
      expect(result).toContain(
        part < parts ? `Part ${part} of ${parts}. Read part ${part + 1} for more.` : `Part ${part} of ${parts}.`,
      )
      texts.push(body(result))
    }
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(PART_CHARS)
    // Together, the parts are the whole page, in order, each paragraph once.
    const lines = texts.join('\n').split('\n')
    expect(lines).toHaveLength(count)
    expect(lines.map((l) => Number(/^Paragraph (\d+) /.exec(l)?.[1]))).toEqual(ids.map((_, i) => i + 1))

    expect(tab.sent.filter((r) => r.url.endsWith('/loadPageChunk'))).toHaveLength(1)

    await expect(read({ part: parts + 1 })).rejects.toThrow(
      `This page has ${parts} parts; there is no part ${parts + 1}.`,
    )
  })

  it('[UC-NOTION-001-S04] reads a database row with its properties', async () => {
    const collection = {
      [COLLECTION]: wrapped({
        id: COLLECTION,
        name: [['Tasks']],
        schema: {
          title: { name: 'Name', type: 'title' },
          'a:b': { name: 'Status', type: 'select' },
          'c:d': { name: 'Done', type: 'checkbox' },
          'e:f': { name: 'Due', type: 'date' },
          'g:h': { name: 'Owner', type: 'person' },
          'i:j': { name: 'Notes', type: 'text' },
        },
      }),
    }
    const row = chunk(
      [id(1)],
      { block: block(id(1), 'text', 'Row body') },
      {
        parent_id: COLLECTION,
        parent_table: 'collection',
        properties: {
          title: [['Fixture page']],
          'a:b': [['Doing']],
          'c:d': [['Yes']],
          'e:f': [['‣', [['d', { type: 'date', start_date: '2026-11-12' }]]]],
          'g:h': [['‣', [['u', USER]]]],
        },
      },
    )
    // loadPageChunk doesn't always include the row's database; it is then loaded on its own.
    const tab = openPage(row).respond('syncRecordValuesMain', 200, { recordMap: { __version__: 3, collection } })

    expect(body(await read())).toBe(
      [
        '---',
        'Status: Doing',
        'Done: Yes',
        'Due: @2026-11-12',
        'Owner: @Fixture User',
        '---',
        'Row body ^00000001',
      ].join('\n'),
    )
    expect(tab.sent.at(-1)!.body).toEqual({
      requests: [{ pointer: { table: 'collection', id: COLLECTION, spaceId: SPACE }, version: -1 }],
    })
  })

  it('[UC-NOTION-001-S05] shows child pages and databases by name and id, without their content, and opens them by id', async () => {
    const child = id(1)
    const database = id(2)
    const link = id(3)
    const page = chunk([child, database, link], {
      block: {
        ...block(child, 'page', 'Child page', { content: [id(9)] }),
        // The child page's own content, as loadPageChunk may return it: not part of this page.
        ...block(id(9), 'text', 'Inside the child', {}, child),
        ...block(database, 'collection_view', undefined, { collection_id: COLLECTION, view_ids: [] }),
        ...block(link, 'alias', undefined, { format: { alias_pointer: { id: child, table: 'block' } } }),
      },
      collection: { [COLLECTION]: wrapped({ id: COLLECTION, name: [['Tasks']] }) },
    })
    const childPage = {
      cursor: { stack: [] },
      recordMap: {
        __version__: 3,
        block: {
          ...block(child, 'page', 'Child page', { content: [id(9)] }),
          ...block(id(9), 'text', 'Inside the child', {}, child),
        },
      },
    }
    const tab = openPage(page, childPage)

    expect(body(await read())).toBe(
      [
        `📄 Child page ^${hex(child)}`,
        `🗃 Tasks (database) ^${hex(database)}`,
        `↗ [Child page](${hex(child)}) ^00000003`,
      ].join('\n'),
    )
    // The id the result shows opens the child page.
    const opened = await read({ page: `^${hex(child)}` })
    expect(opened.split('\n')[0]).toBe(`Page: Child page ^${hex(child)}`)
    expect(body(opened)).toBe('Inside the child ^00000009')
    expect(tab.sent.at(-1)!.body).toMatchObject({ page: { id: child } })
  })

  it('[UC-NOTION-001-S06] tells the AI a page its Notion account cannot open cannot be read', async () => {
    // Notion answers a page the user can't see with an empty record map, not an error.
    openPage(fixture('empty-record-map'))
    await expect(read()).rejects.toThrow(
      "The Notion page doesn't exist, or the signed-in Notion account has no access to it.",
    )
  })
})

describe('read_page when Notion is limiting requests', () => {
  // The waits and tries are tested in notion.test.ts (UC-NOTION-001-S08), with the wait injected.
  it('tells the AI to have the user wait when Notion asks for a longer wait than a tool call holds', async () => {
    const tab = new FakeNotionTab(PAGE_URL).limit('loadPageChunk', 1, { 'retry-after': '120' }).install()
    await expect(read()).rejects.toThrow(
      'Notion is limiting requests from this account right now, so this was not done. Do not try again or work around it with other tools: tell the user to wait a minute before asking again.',
    )
    expect(tab.sent).toHaveLength(1)
  })
})

describe('read_page arguments', () => {
  it('opens a page by URL or by id, with or without dashes', async () => {
    const page = chunk([id(1)], { block: block(id(1), 'text', 'Hi') })
    const tab = openPage(page, page, page)
    await read({ page: `https://www.notion.so/team/Fixture-page-${PAGE_HEX}` })
    await read({ page: PAGE_HEX.toUpperCase() })
    await read({ page: PAGE })
    expect(tab.sent.map((r) => (r.body.page as { id: string }).id)).toEqual([PAGE, PAGE, PAGE])
  })

  it('refuses URLs of other sites and things that are not ids, without asking Notion', async () => {
    const tab = openPage()
    await expect(read({ page: `https://example.com/${PAGE_HEX}` })).rejects.toThrow('Not a Notion page URL or id')
    await expect(read({ page: 'Roadmap' })).rejects.toThrow('Not a Notion page URL or id: Roadmap')
    await expect(read({ part: 0 })).rejects.toThrow('`part` must be a whole number from 1.')
    await expect(read({ part: 1.5 })).rejects.toThrow('`part` must be a whole number from 1.')
    expect(tab.sent).toEqual([])
  })

  it('treats an empty page or a null part as not given', async () => {
    const page = chunk([id(1)], { block: block(id(1), 'text', 'Hi') })
    openPage(page)
    expect(body(await read({ page: ' ', part: null }))).toBe('Hi ^00000001')
  })

  it('asks for a page when the Notion tab shows none', async () => {
    new FakeNotionTab('https://www.notion.so/').install()
    await expect(read()).rejects.toThrow('The Notion tab does not show a page.')
  })

  it('says so when the page is empty', async () => {
    openPage(chunk([]))
    expect(body(await read())).toBe('(This page is empty.)')
  })

  it('says a full-page database is a database', async () => {
    openPage(
      chunk(
        [],
        { collection: { [COLLECTION]: wrapped({ id: COLLECTION, name: [['Tasks']] }) } },
        {
          type: 'collection_view_page',
          collection_id: COLLECTION,
          properties: undefined,
        },
      ),
    )
    const result = await read()
    expect(result.split('\n').slice(0, 3)).toEqual([
      `Page: Tasks ^${PAGE_HEX}`,
      `URL: https://app.notion.com/${PAGE_HEX}`,
      'This page is a database: read its rows with query_database.',
    ])
  })
})

describe('block references', () => {
  it('use the last 8 hex digits, or the whole id when another block shares them', () => {
    const a = 'aaaaaaaa-0000-4000-8000-000012345678'
    const b = 'bbbbbbbb-0000-4000-8000-000012345678'
    const c = 'cccccccc-0000-4000-8000-0000000000ff'
    expect(blockRefs([a, b, c])).toEqual(
      new Map([
        [a, hex(a)],
        [b, hex(b)],
        [c, '000000ff'],
      ]),
    )
  })
})

describe('parts', () => {
  it('break between blocks, and inside a block only when it alone is too long', () => {
    expect(splitIntoParts(['aaaa', 'bbbb', 'cc'], 10)).toEqual(['aaaa\nbbbb', 'cc'])
    expect(splitIntoParts(['x', 'l1\nl2\nl3\nl4'], 5)).toEqual(['x', 'l1\nl2', 'l3\nl4'])
    expect(splitIntoParts([], 10)).toEqual([''])
    // A line longer than a part is cut, so no part is longer than the limit.
    expect(splitIntoParts(['x'.repeat(12)], 5)).toEqual(['xxxxx', 'xxxxx', 'xx'])
    // A blank line that starts a part is kept.
    expect(splitIntoParts(['abc\n\nde'], 3)).toEqual(['abc', '\nde'])
  })
})

describe('converter details', () => {
  it('fences code with more backticks than the code has, and puts the reference after the fence', async () => {
    openPage(
      chunk([id(1)], {
        block: block(id(1), 'code', undefined, { properties: { title: [['a\n```\nb']], language: [['Plain Text']] } }),
      }),
    )
    expect(body(await read())).toBe(['````', 'a', '```', 'b', '````', '^00000001'].join('\n'))
  })

  it('keeps table rows on one line each, and marks rows that were not loaded', async () => {
    openPage(
      chunk([id(1)], {
        block: {
          ...block(id(1), 'table', undefined, {
            content: [id(2), id(3), id(4)],
            format: { table_block_column_order: ['c1', 'c2'] },
          }),
          ...block(id(2), 'table_row', undefined, { properties: { c1: [['Step']], c2: [['Notes']] } }, id(1)),
          ...block(id(3), 'table_row', undefined, { properties: { c1: [['One']], c2: [['line 1\nline 2']] } }, id(1)),
        },
      }),
    )
    expect(body(await read())).toBe(
      ['| Step | Notes |', '| --- | --- |', '| One | line 1<br>line 2 |', '| [row not loaded] |  |', '^00000001'].join(
        '\n',
      ),
    )
  })

  it('shows computed properties as such, and times and people the row keeps itself', async () => {
    const collection = {
      [COLLECTION]: wrapped({
        id: COLLECTION,
        name: [['Tasks']],
        schema: {
          title: { name: 'Name', type: 'title' },
          'a:a': { name: 'Score', type: 'formula' },
          'b:b': { name: 'Total', type: 'rollup' },
          'c:c': { name: 'Created', type: 'created_time' },
          'd:d': { name: 'Edited by', type: 'last_edited_by' },
        },
      }),
    }
    openPage(
      chunk(
        [],
        { block: {}, collection },
        {
          parent_id: COLLECTION,
          parent_table: 'collection',
          created_time: Date.UTC(2026, 10, 9, 8, 30),
          last_edited_by_id: USER,
        },
      ),
    )
    expect(
      body(await read())
        .split('\n')
        .slice(0, 6),
    ).toEqual([
      '---',
      'Score: [formula, not shown]',
      'Total: [rollup, not shown]',
      'Created: 2026-11-09 08:30 UTC',
      'Edited by: @Fixture User',
      '---',
    ])
  })

  it('still reads a database row whose database the account cannot open, without its properties', async () => {
    openPage(
      chunk(
        [id(1)],
        { block: block(id(1), 'text', 'Row body') },
        { parent_id: COLLECTION, parent_table: 'collection' },
      ),
    ).respond('syncRecordValuesMain', 200, fixture('empty-record-map'))
    const result = await read()
    expect(result).toContain(
      "This is a database row, but its database can't be opened, so its properties are not shown.",
    )
    expect(body(result)).toBe('Row body ^00000001')
  })

  it('names a linked database view after the database it shows', async () => {
    openPage(
      chunk([id(1)], {
        block: block(id(1), 'collection_view', undefined, {
          view_ids: [],
          format: { collection_pointer: { id: COLLECTION, table: 'collection', spaceId: SPACE } },
        }),
        collection: { [COLLECTION]: wrapped({ id: COLLECTION, name: [['Tasks']] }) },
      }),
    )
    expect(body(await read())).toBe(`🗃 Tasks (database) ^${hex(id(1))}`)
  })
})

describe('more converter and argument details', () => {
  it('keeps the lines and children of quotes and callouts inside the blockquote', async () => {
    openPage(
      chunk([id(1), id(2)], {
        block: {
          ...block(id(1), 'quote', 'Line one\nLine two'),
          ...block(id(2), 'callout', 'Note', { format: { page_icon: 'notion://custom_emoji/abc' }, content: [id(3)] }),
          ...block(id(3), 'bulleted_list', 'Inside', {}, id(2)),
        },
      }),
    )
    expect(body(await read())).toBe(
      ['> Line one', '> Line two ^00000001', '> [!callout] Note ^00000002', '> - Inside ^00000003'].join('\n'),
    )
  })

  it('refuses an id of a block that is not a page', async () => {
    openPage({
      cursor: { stack: [] },
      recordMap: { __version__: 3, block: { ...block(PAGE, 'text', 'Just a paragraph', {}, id(9)) } },
    })
    await expect(read()).rejects.toThrow('That id is a block inside a page, not a page.')
  })

  it('accepts Notion links without https:// and page slugs ending in the id', async () => {
    const page = chunk([])
    const tab = openPage(page, page, page, page)
    await read({ page: `notion.so/x`.replace('notion.so', 'www.notion.so') + `/Fixture-page-${PAGE_HEX}` })
    await read({ page: `Fixture-page-${PAGE_HEX}` })
    await read({ page: `notion.so/Fixture-page-${PAGE_HEX}` })
    await read({ page: `https://notion.so/Fixture-page-${PAGE_HEX}` })
    expect(tab.sent.map((r) => (r.body.page as { id: string }).id)).toEqual([PAGE, PAGE, PAGE, PAGE])
  })

  it('keeps several long pages for their later parts', async () => {
    const long = (pageId: string) => {
      const ids = Array.from({ length: 300 }, (_, i) => id(i + 1))
      const blocks = Object.assign({}, ...ids.map((b, i) => block(b, 'text', `P${i} ${'y'.repeat(60)}`, {}, pageId)))
      blocks[pageId] = wrapped({ id: pageId, type: 'page', properties: { title: [['Long']] }, content: ids })
      return { cursor: { stack: [] }, recordMap: { __version__: 3, block: blocks } }
    }
    const a = '2a2a2a2a-0000-4000-8000-000000000021'
    const b = '2a2a2a2a-0000-4000-8000-000000000022'
    const c = '2a2a2a2a-0000-4000-8000-000000000023'
    const tab = openPage(long(a), long(b), long(c))
      .respond('syncRecordValuesMain', 200, stillOpen(long(a), a))
      .respond('syncRecordValuesMain', 200, stillOpen(long(b), b))
    await read({ page: a })
    await read({ page: b })
    // Part 2 of each comes from its first read, though another page was read in between.
    expect(await read({ page: a, part: 2 })).not.toContain('new read')
    expect(await read({ page: b, part: 2 })).not.toContain('new read')
    expect(tab.sent.filter((r) => r.url.endsWith('/loadPageChunk'))).toHaveLength(2)
    // A later part read fresh says so: the model may hold parts of another read.
    expect(await read({ page: c, part: 2 })).toContain(
      'This part comes from a new read of the page; parts you have from an earlier read may not match it.',
    )
  })

  it('[UC-NOTION-001-S06] checks the account in the tab can still open the page before giving a later part', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => id(i + 1))
    const page = chunk(ids, {
      block: Object.assign({}, ...ids.map((b, i) => block(b, 'text', `P${i} ${'z'.repeat(60)}`))),
    })
    // Between the parts, the tab switched to a Notion account that can't open the page.
    openPage(page).respond('syncRecordValuesMain', 200, fixture('empty-record-map'))
    await read({ page: PAGE })
    await expect(read({ page: PAGE, part: 2 })).rejects.toThrow(
      "The Notion page doesn't exist, or the signed-in Notion account has no access to it.",
    )
  })

  it('shows links to Notion pages as /<page id>, which read_page opens', async () => {
    const target = '3a3a3a3a-0000-4000-8000-000000000031'
    openPage(
      chunk([id(1)], {
        block: block(id(1), 'text', [
          ['See '],
          ['plan', [['a', `/Plan-${hex(target)}?pvs=4`]]],
          [' and '],
          ['site', [['a', 'https://example.com/x']]],
        ]),
      }),
    )
    expect(body(await read())).toBe(`See [plan](/${hex(target)}) and [site](https://example.com/x) ^00000001`)
  })
})
