// The search_pages tool (extension/src/tools.ts) against a fake Notion tab answering with search
// results in the shape Notion's /api/v3/search returns (see the #64 spike).
import { afterEach, describe, expect, it } from 'vitest'
import { readPage, searchPages } from '../../extension/src/tools'
import { FakeNotionTab, PAGE, PAGE_URL, SPACE, restoreGlobals } from './notion-tab'

afterEach(restoreGlobals)

const hex = (id: string) => id.replace(/-/g, '')
const FOUND = 'f1f1f1f1-0000-4000-8000-000000000001'
const DATABASE = 'f1f1f1f1-0000-4000-8000-000000000002'

function wrapped(record: Record<string, unknown>) {
  return { spaceId: SPACE, value: { role: 'editor', value: { version: 1, alive: true, space_id: SPACE, ...record } } }
}

/** The open page, as syncRecordValuesMain returns it: search needs its workspace. */
const OPEN_PAGE = {
  recordMap: {
    __version__: 3,
    block: { [PAGE]: wrapped({ id: PAGE, type: 'page', properties: { title: [['Fixture page']] } }) },
  },
}

const SEARCH = {
  results: [
    {
      id: FOUND,
      score: 12.3,
      highlight: {
        title: 'Launch <gzkNfoUU>plan</gzkNfoUU>',
        text: 'We will ship the <gzkNfoUU>beta</gzkNfoUU> on Friday.',
        pathText: 'Fixture workspace / Projects / Launch <gzkNfoUU>plan</gzkNfoUU>',
      },
    },
    { id: DATABASE, score: 3.1, highlight: { pathText: 'Fixture workspace' } },
  ],
  total: 5,
  recordMap: {
    __version__: 3,
    block: {
      [FOUND]: wrapped({
        id: FOUND,
        type: 'page',
        properties: { title: [['Launch plan']] },
        last_edited_time: Date.UTC(2026, 10, 8, 9),
      }),
      [DATABASE]: wrapped({ id: DATABASE, type: 'collection_view_page', last_edited_time: Date.UTC(2026, 10, 1) }),
    },
  },
}

function open(): FakeNotionTab {
  return new FakeNotionTab(PAGE_URL).respond('syncRecordValuesMain', 200, OPEN_PAGE).install()
}

const search = async (args: Record<string, unknown>) => (await searchPages.run(args)) as string

describe('UC-NOTION-004 find and read other pages', () => {
  it('[UC-NOTION-004-S01] finds pages with their titles, where they are, the matching text, and their ids', async () => {
    const tab = open().respond('search', 200, SEARCH)
    expect(await search({ query: 'beta plan' })).toBe(
      [
        'Pages found for "beta plan" (5 in all; showing 2):',
        '',
        `1. 📄 Launch plan ^${hex(FOUND)}`,
        '   In: Fixture workspace / Projects',
        '   Edited: 2026-11-08',
        '   Match: “We will ship the beta on Friday.”',
        `   URL: https://app.notion.com/${hex(FOUND)}`,
        `2. 🗃 Untitled database ^${hex(DATABASE)}`,
        '   In: Fixture workspace',
        '   Edited: 2026-11-01',
        `   URL: https://app.notion.com/${hex(DATABASE)}`,
      ].join('\n'),
    )
    // It searched the open page's workspace, as the tab's Notion user.
    const sent = tab.sent.at(-1)!
    expect(sent.url).toBe('https://app.notion.com/api/v3/search')
    expect(sent.body).toMatchObject({ type: 'BlocksInSpace', query: 'beta plan', spaceId: SPACE, limit: 10 })
    expect(sent.headers['x-notion-space-id']).toBe(SPACE)
  })

  it('[UC-NOTION-004-S02] says when nothing was found', async () => {
    open().respond('search', 200, { results: [], total: 0, recordMap: { __version__: 3 } })
    expect(await search({ query: 'zebra' })).toBe('No pages found for "zebra".')
  })

  it('[UC-NOTION-004-S03] reads a page the search found, by the id it showed', async () => {
    const tab = open().respond('search', 200, SEARCH)
    const result = await search({ query: 'plan' })
    const ref = /\^([0-9a-f]{32})/.exec(result)![1]
    tab.respond('loadPageChunk', 200, {
      cursor: { stack: [] },
      recordMap: {
        __version__: 3,
        block: {
          [FOUND]: wrapped({
            id: FOUND,
            type: 'page',
            properties: { title: [['Launch plan']] },
            content: ['f1f1f1f1-0000-4000-8000-0000000000aa'],
          }),
          'f1f1f1f1-0000-4000-8000-0000000000aa': wrapped({
            id: 'f1f1f1f1-0000-4000-8000-0000000000aa',
            type: 'text',
            parent_id: FOUND,
            parent_table: 'block',
            properties: { title: [['Ship on Friday.']] },
          }),
        },
      },
    })
    const page = (await readPage.run({ page: `^${ref}` })) as string
    expect(page.split('\n')[0]).toBe(`Page: Launch plan ^${hex(FOUND)}`)
    expect(page).toContain('Ship on Friday. ^000000aa')
  })
})

describe('search_pages results', () => {
  it('removes only the highlight tag, keeping other <…> text', async () => {
    open().respond('search', 200, {
      results: [{ id: FOUND, highlight: { title: 'Use <q1W2e3R4>Array</q1W2e3R4><string>', text: 'a <b> c' } }],
      total: 1,
      recordMap: { __version__: 3 },
    })
    const result = await search({ query: 'array' })
    expect(result).toContain(`1. 📄 Use Array<string> ^${hex(FOUND)}`)
    expect(result).toContain('Match: “a <b> c”')
  })

  it('reports a failed search as a Notion error', async () => {
    open().respond('search', 500, { isNotionError: true, name: 'InternalServerError', debugMessage: 'Boom.' })
    await expect(search({ query: 'x' })).rejects.toThrow('Notion returned an error (500 InternalServerError): Boom.')
  })
})

describe('search_pages arguments', () => {
  it('asks for words and a sensible limit, without asking Notion', async () => {
    const tab = open()
    await expect(search({ query: '  ' })).rejects.toThrow('`query` must be some words to search for.')
    await expect(search({ query: 'x', limit: 0 })).rejects.toThrow('`limit` must be a whole number from 1 to 20.')
    await expect(search({ query: 'x', limit: 21 })).rejects.toThrow('`limit` must be a whole number from 1 to 20.')
    expect(tab.sent).toEqual([])
  })

  it('passes the limit, and treats an empty one as not given', async () => {
    const tab = open()
      .respond('search', 200, SEARCH)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('search', 200, SEARCH)
    await search({ query: 'x', limit: 3 })
    expect(tab.sent.at(-1)!.body).toMatchObject({ limit: 3 })
    await search({ query: 'x', limit: null })
    expect(tab.sent.at(-1)!.body).toMatchObject({ limit: 10 })
  })

  it('needs a page open to know which workspace to search', async () => {
    new FakeNotionTab('https://www.notion.so/').install()
    await expect(search({ query: 'x' })).rejects.toThrow('Open a page of the workspace to search it.')
  })
})

describe('search_pages, more results', () => {
  it("names databases from their collection, and picks Notion's tag over literal markup", async () => {
    const COLLECTION = 'c0c0c0c0-0000-4000-8000-000000000009'
    // Another open page, so its workspace is looked up afresh (it is remembered per page).
    const here = 'f3f3f3f3-0000-4000-8000-000000000001'
    new FakeNotionTab(`https://app.notion.com/${hex(here)}`)
      .respond('syncRecordValuesMain', 200, {
        recordMap: { __version__: 3, block: { [here]: wrapped({ id: here, type: 'page' }) } },
      })
      .install()
      .respond('search', 200, {
        results: [
          {
            id: FOUND,
            highlight: {
              title: 'Use <b>bold</b> here',
              text: 'a <Zx81Qa7p>beta</Zx81Qa7p> b <Zx81Qa7p>plan</Zx81Qa7p>',
            },
          },
          {
            id: DATABASE,
            highlight: { text: 'the <Zx81Qa7p>beta</Zx81Qa7p> board', pathText: 'Fixture workspace / Q3 / Q4 plan' },
          },
        ],
        total: 2,
        recordMap: {
          __version__: 3,
          block: {
            [FOUND]: wrapped({ id: FOUND, type: 'page', properties: { title: [['Use <b>bold</b> here']] } }),
            [DATABASE]: wrapped({ id: DATABASE, type: 'collection_view_page', collection_id: COLLECTION }),
          },
        },
      })
      .respond('syncRecordValuesMain', 200, {
        recordMap: {
          __version__: 3,
          collection: { [COLLECTION]: wrapped({ id: COLLECTION, name: [['Q3 / Q4 plan']] }) },
        },
      })
    const result = await search({ query: 'beta' })
    expect(result).toContain(`1. 📄 Use <b>bold</b> here ^${hex(FOUND)}`)
    expect(result).toContain('Match: “a beta b plan”')
    expect(result).toContain(`2. 🗃 Q3 / Q4 plan ^${hex(DATABASE)}`)
    // The database's own name is cut from the end of its path, slashes and all.
    expect(result).toContain('In: Fixture workspace\n')
  })

  it('says so when the open page is in the trash', async () => {
    const trashed = 'f2f2f2f2-0000-4000-8000-000000000001'
    new FakeNotionTab(`https://app.notion.com/${hex(trashed)}`)
      .respond('syncRecordValuesMain', 200, {
        recordMap: { __version__: 3, block: { [trashed]: wrapped({ id: trashed, type: 'page', alive: false }) } },
      })
      .install()
    await expect(search({ query: 'x' })).rejects.toThrow(
      'The open page is in the trash. Open another page of the workspace to search it.',
    )
  })
})

describe('search_pages, partial lookups', () => {
  it('names the databases it can, when another one cannot be looked up', async () => {
    const here = 'f4f4f4f4-0000-4000-8000-000000000001'
    const A = 'c1c1c1c1-0000-4000-8000-000000000001'
    const B = 'c1c1c1c1-0000-4000-8000-000000000002'
    const dbA = 'f4f4f4f4-0000-4000-8000-00000000000a'
    const dbB = 'f4f4f4f4-0000-4000-8000-00000000000b'
    new FakeNotionTab(`https://app.notion.com/${hex(here)}`)
      .respond('syncRecordValuesMain', 200, {
        recordMap: { __version__: 3, block: { [here]: wrapped({ id: here, type: 'page' }) } },
      })
      .respond('search', 200, {
        results: [{ id: dbA }, { id: dbB }],
        total: 2,
        recordMap: {
          __version__: 3,
          block: {
            [dbA]: wrapped({ id: dbA, type: 'collection_view_page', collection_id: A }),
            [dbB]: wrapped({ id: dbB, type: 'collection_view', format: { collection_pointer: { id: B } } }),
          },
        },
      })
      .respond('syncRecordValuesMain', 200, {
        recordMap: { __version__: 3, collection: { [A]: wrapped({ id: A, name: [['Roadmap']] }) } },
      })
      // The other database's source is out of reach: Notion answers with nothing.
      .respond('syncRecordValuesMain', 200, { recordMap: { __version__: 3 } })
      .install()
    const result = await search({ query: 'x' })
    expect(result).toContain(`1. 🗃 Roadmap ^${hex(dbA)}`)
    expect(result).toContain(`2. 🗃 Untitled database ^${hex(dbB)}`)
  })

  it("removes no tag when the response has none in Notion's shape", async () => {
    const here = 'f5f5f5f5-0000-4000-8000-000000000001'
    new FakeNotionTab(`https://app.notion.com/${hex(here)}`)
      .respond('syncRecordValuesMain', 200, {
        recordMap: { __version__: 3, block: { [here]: wrapped({ id: here, type: 'page' }) } },
      })
      .respond('search', 200, {
        results: [{ id: FOUND, highlight: { title: 'Use <b>bold</b> here' } }],
        total: 1,
        recordMap: { __version__: 3 },
      })
      .install()
    expect(await search({ query: 'bold' })).toContain(`1. 📄 Use <b>bold</b> here ^${hex(FOUND)}`)
  })
})

describe('search_pages, tags and trash', () => {
  it('strips a highlight tag that starts with a digit, and leaves out trashed pages', async () => {
    const here = 'f6f6f6f6-0000-4000-8000-000000000001'
    const gone = 'f6f6f6f6-0000-4000-8000-000000000002'
    new FakeNotionTab(`https://app.notion.com/${hex(here)}`)
      .respond('syncRecordValuesMain', 200, {
        recordMap: { __version__: 3, block: { [here]: wrapped({ id: here, type: 'page' }) } },
      })
      .respond('search', 200, {
        results: [
          { id: FOUND, highlight: { title: 'Launch <3kQ9aZpx>plan</3kQ9aZpx>' } },
          { id: gone, highlight: { title: 'Old <3kQ9aZpx>plan</3kQ9aZpx>' } },
        ],
        total: 2,
        recordMap: { __version__: 3, block: { [gone]: wrapped({ id: gone, type: 'page', alive: false }) } },
      })
      .install()
    const result = await search({ query: 'plan' })
    expect(result).toContain(`1. 📄 Launch plan ^${hex(FOUND)}`)
    expect(result).not.toContain(hex(gone))
  })
})
