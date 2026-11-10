// The search_pages tool (extension/src/tools.ts) against a fake Notion tab answering with search
// results in the shape Notion's /api/v3/search returns (see the #64 spike).
import { afterEach, describe, expect, it } from 'vitest'
import { LIMITED_STOP, NO_ACCESS } from '../src/notion/api'
import { forgetReads, readPage, searchPages } from '../src/tools'
import { FakeNotionTab, PAGE, PAGE_URL, SPACE, notionError, restoreGlobals } from './notion-tab'

afterEach(restoreGlobals)

const hex = (id: string) => id.replace(/-/g, '')
const FOUND = 'f1f1f1f1-0000-4000-8000-000000000001'
const DATABASE = 'f1f1f1f1-0000-4000-8000-000000000002'
const COLLECTION_A = 'c1c1c1c1-0000-4000-8000-000000000001'

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
    // Notion has more than the two asked for.
    expect(await search({ query: 'beta plan', limit: 2 })).toBe(
      [
        'Pages found for "beta plan" (5 in all; showing 2):',
        '',
        `1. 📄 Launch plan ^${hex(FOUND)}`,
        '   In: Fixture workspace / Projects',
        '   Edited: 2026-11-08',
        '   Match: “We will ship the beta on Friday.”',
        `   URL: https://app.notion.com/p/${hex(FOUND)}`,
        `2. 🗃 Untitled database ^${hex(DATABASE)}`,
        '   In: Fixture workspace',
        '   Edited: 2026-11-01',
        `   URL: https://app.notion.com/p/${hex(DATABASE)}`,
      ].join('\n'),
    )
    // It searched the open page's workspace, as the tab's Notion user.
    const sent = tab.sent.at(-1)!
    expect(sent.url).toBe('https://app.notion.com/api/v3/search')
    expect(sent.body).toMatchObject({ type: 'BlocksInSpace', query: 'beta plan', spaceId: SPACE, limit: 2 })
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

  it('refuses arguments that are not what its schema says, without asking Notion', async () => {
    const tab = open()
    await expect(search({})).rejects.toThrow('`query` must be some words to search for.')
    await expect(search({ query: 5 })).rejects.toThrow('`query` must be some words to search for.')
    await expect(search({ query: 'x', limit: 1.5 })).rejects.toThrow('`limit` must be a whole number from 1 to 20.')
    await expect(search({ query: 'x', limit: '3' })).rejects.toThrow('`limit` must be a whole number from 1 to 20.')
    await expect(search({ query: 'x', page: 'y' })).rejects.toThrow('Unrecognized key: "page"')
    expect(tab.sent).toEqual([])
  })

  // A null is dropped before a tool gets its arguments: see "read_page gets the model's arguments
  // as its schema reads them" in worker/test/extension.test.ts.
  it('passes the limit, and uses the default without one', async () => {
    const tab = open()
      .respond('search', 200, SEARCH)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('search', 200, SEARCH)
    await search({ query: 'x', limit: 3 })
    expect(tab.sent.at(-1)!.body).toMatchObject({ limit: 3 })
    await search({ query: 'x' })
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
      'The open page is in the trash. Open another page of the workspace.',
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
      // The other database's source is out of reach: Notion leaves it out of the answer.
      .respond('syncRecordValuesMain', 200, {
        recordMap: { __version__: 3, collection: { [A]: wrapped({ id: A, name: [['Roadmap']] }) } },
      })
      .install()
    const result = await search({ query: 'x' })
    expect(result).toContain(`1. 🗃 Roadmap ^${hex(dbA)}`)
    expect(result).toContain(`2. 🗃 Untitled database ^${hex(dbB)}`)
  })

  it('stops the question when Notion turns a database lookup away, instead of leaving the name out', async () => {
    // A page of its own: the workspace of an open page is looked up once.
    const here = 'f6f6f6f6-0000-4000-8000-000000000001'
    const A = 'c1c1c1c1-0000-4000-8000-000000000001'
    const dbA = 'f4f4f4f4-0000-4000-8000-00000000000a'
    new FakeNotionTab(`https://app.notion.com/${hex(here)}`)
      .respond('syncRecordValuesMain', 200, {
        recordMap: { __version__: 3, block: { [here]: wrapped({ id: here, type: 'page' }) } },
      })
      .respond('search', 200, {
        results: [{ id: dbA }],
        total: 1,
        recordMap: {
          __version__: 3,
          block: { [dbA]: wrapped({ id: dbA, type: 'collection_view_page', collection_id: A }) },
        },
      })
      .limit('syncRecordValuesMain', 1)
      .install()
    expect((await notionError(search({ query: 'x' }))).stopsQuestion).toBe(LIMITED_STOP)
  })

  it('looks up every database name in one request, without assuming the workspace', async () => {
    const here = 'f7f7f7f7-0000-4000-8000-000000000001'
    const dbs = Array.from({ length: 6 }, (_, i) => `f7f7f7f7-0000-4000-8000-0000000000a${i}`)
    const collection = (i: number) => `c7c7c7c7-0000-4000-8000-0000000000a${i}`
    const tab = new FakeNotionTab(`https://app.notion.com/${hex(here)}`)
      .respond('syncRecordValuesMain', 200, {
        recordMap: { __version__: 3, block: { [here]: wrapped({ id: here, type: 'page' }) } },
      })
      .respond('search', 200, {
        results: dbs.map((id) => ({ id })),
        total: dbs.length,
        recordMap: {
          __version__: 3,
          block: Object.fromEntries(
            dbs.map((id, i) => [id, wrapped({ id, type: 'collection_view_page', collection_id: collection(i) })]),
          ),
        },
      })
      .respond('syncRecordValuesMain', 200, {
        recordMap: {
          __version__: 3,
          collection: Object.fromEntries(
            [0, 1, 2, 3, 4, 5].map((i) => [collection(i), wrapped({ id: collection(i), name: [[`Board ${i}`]] })]),
          ),
        },
      })
      .install()
    const result = await search({ query: 'x' })
    for (let i = 0; i < 6; i++) expect(result).toContain(`${i + 1}. 🗃 Board ${i} ^${hex(dbs[i])}`)
    // The open page's workspace, then one lookup for all six names.
    const lookups = tab.sent.filter((r) => r.url.endsWith('/syncRecordValuesMain'))
    expect(lookups).toHaveLength(2)
    expect(lookups[1].headers['x-notion-space-id']).toBeUndefined()
    expect(lookups[1].body).toEqual({
      requests: [0, 1, 2, 3, 4, 5].map((i) => ({ pointer: { table: 'collection', id: collection(i) }, version: -1 })),
    })
  })

  it('still lists the databases, unnamed, when Notion refuses the name lookup as a whole', async () => {
    const here = 'f7f7f7f7-0000-4000-8000-000000000002'
    const dbA = 'f4f4f4f4-0000-4000-8000-00000000000a'
    new FakeNotionTab(`https://app.notion.com/${hex(here)}`)
      .respond('syncRecordValuesMain', 200, {
        recordMap: { __version__: 3, block: { [here]: wrapped({ id: here, type: 'page' }) } },
      })
      .respond('search', 200, {
        results: [{ id: dbA }],
        total: 1,
        recordMap: {
          __version__: 3,
          block: { [dbA]: wrapped({ id: dbA, type: 'collection_view_page', collection_id: COLLECTION_A }) },
        },
      })
      .respond('syncRecordValuesMain', 403, { isNotionError: true, name: 'PermissionError' })
      .install()
    expect(await search({ query: 'x' })).toContain(`1. 🗃 Untitled database ^${hex(dbA)}`)
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

describe('search_pages, the open page’s workspace', () => {
  afterEach(forgetReads)

  /** A tab showing `id` as `user`, whose workspace lookup answers with `block` (none: no access). */
  function openAs(id: string, user: string, block?: Record<string, unknown>): FakeNotionTab {
    return new FakeNotionTab(`https://app.notion.com/${hex(id)}`, `notion_user_id=${user}`)
      .respond('syncRecordValuesMain', 200, {
        recordMap: { __version__: 3, ...(block ? { block: { [id]: wrapped({ id, type: 'page', ...block }) } } : {}) },
      })
      .install()
  }
  const NOTHING = { results: [], total: 0, recordMap: { __version__: 3 } }
  const lookups = (tab: FakeNotionTab) => tab.sent.filter((r) => r.url.endsWith('/syncRecordValuesMain')).length
  const ME = '0e0e0e0e-0000-4000-8000-0000000000a1'
  const OTHER = '0e0e0e0e-0000-4000-8000-0000000000a2'
  const here = 'f8f8f8f8-0000-4000-8000-000000000001'

  it('looks the workspace up once per page and Notion user, and again after the tab switched accounts', async () => {
    const tab = openAs(here, ME, {}).respond('search', 200, NOTHING).respond('search', 200, NOTHING)
    await search({ query: 'x' })
    await search({ query: 'y' })
    expect(lookups(tab)).toBe(1)
    // Signed in to another account, which can't open the page: it is told so, not that nothing was found.
    const switched = openAs(here, OTHER)
    expect(await notionError(search({ query: 'x' }))).toMatchObject({ code: 'no_access', message: NO_ACCESS })
    expect(switched.sent.map((r) => r.url.split('/api/v3/')[1])).toEqual(['syncRecordValuesMain'])
  })

  it('looks it up again in a new conversation', async () => {
    openAs(here, ME, {}).respond('search', 200, NOTHING)
    await search({ query: 'x' })
    forgetReads()
    const tab = openAs(here, ME, {}).respond('search', 200, NOTHING)
    await search({ query: 'x' })
    expect(lookups(tab)).toBe(1)
  })

  it('remembers the workspaces of the last 20 pages only', async () => {
    const pages = Array.from(
      { length: 21 },
      (_, i) => `f8f8f8f8-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
    )
    for (const id of pages) {
      openAs(id, ME, {}).respond('search', 200, NOTHING)
      await search({ query: 'x' })
    }
    // The last one is still known; the first one was forgotten.
    const last = openAs(pages[20], ME, {}).respond('search', 200, NOTHING)
    await search({ query: 'x' })
    expect(lookups(last)).toBe(0)
    const first = openAs(pages[0], ME, {}).respond('search', 200, NOTHING)
    await search({ query: 'x' })
    expect(lookups(first)).toBe(1)
  })

  it('remembers nothing when no Notion user is signed in to the tab', async () => {
    const tab = new FakeNotionTab(`https://app.notion.com/${hex(here)}`, 'notion_browser_id=b')
      .respond('syncRecordValuesMain', 200, { recordMap: { __version__: 3 } })
      .install()
    expect((await notionError(search({ query: 'x' }))).code).toBe('signed_out')
    expect(lookups(tab)).toBe(1)
  })
})

describe('search_pages, the count of results', () => {
  afterEach(forgetReads)

  const here = 'f9f9f9f9-0000-4000-8000-000000000001'
  const gone = 'f9f9f9f9-0000-4000-8000-000000000002'
  function found(total: number) {
    return new FakeNotionTab(`https://app.notion.com/${hex(here)}`)
      .respond('syncRecordValuesMain', 200, {
        recordMap: { __version__: 3, block: { [here]: wrapped({ id: here, type: 'page' }) } },
      })
      .respond('search', 200, {
        results: [{ id: FOUND }, { id: gone }, { id: DATABASE }],
        total,
        recordMap: {
          __version__: 3,
          block: {
            [FOUND]: wrapped({ id: FOUND, type: 'page', properties: { title: [['Launch plan']] } }),
            [gone]: wrapped({ id: gone, type: 'page', alive: false }),
            [DATABASE]: wrapped({ id: DATABASE, type: 'page', properties: { title: [['Beta notes']] } }),
          },
        },
      })
      .install()
  }

  it('takes trashed results off the total, which is then only an upper bound', async () => {
    found(9)
    expect((await search({ query: 'x', limit: 3 })).split('\n')[0]).toBe(
      'Pages found for "x" (up to 8 in all; showing 2):',
    )
  })

  it('gives no total when the trashed results were the only ones left out', async () => {
    found(3)
    expect((await search({ query: 'x', limit: 3 })).split('\n')[0]).toBe('Pages found for "x":')
  })

  it('gives no total when Notion returned fewer results than asked for, whatever its total says', async () => {
    found(4)
    expect((await search({ query: 'x', limit: 4 })).split('\n')[0]).toBe('Pages found for "x":')
  })
})
