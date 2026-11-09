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
      results: [{ id: FOUND, highlight: { title: 'Use <q1W2>Array</q1W2><string>', text: 'a <b> c' } }],
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
