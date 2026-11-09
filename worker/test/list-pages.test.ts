// The list_pages tool (extension/src/tools.ts) against a fake Notion tab that answers in the
// shapes Notion's getSpaces and syncRecordValuesMain return.
import { afterEach, describe, expect, it } from 'vitest'
import { LIST_LIMIT, SECTION_LIMIT, listPages } from '../../extension/src/tools'
import { FakeNotionTab, PAGE, PAGE_URL, SPACE, USER, restoreGlobals } from './notion-tab'

afterEach(restoreGlobals)

const hex = (id: string) => id.replace(/-/g, '')
const id = (n: number) => `a0a0a0a0-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const COLLECTION = 'c0c0c0c0-0000-4000-8000-000000000001'

type Rec = Record<string, unknown>
function wrapped(record: Rec) {
  return { spaceId: SPACE, value: { role: 'editor', value: { version: 1, alive: true, space_id: SPACE, ...record } } }
}
const page = (n: number, title: string, content: string[] = []) => ({
  id: id(n),
  type: 'page',
  properties: { title: [[title]] },
  content,
})
/** syncRecordValuesMain's answer holding `blocks` (and collections). */
function records(blocks: Rec[], collections: Rec[] = []) {
  return {
    recordMap: {
      __version__: 3,
      block: Object.fromEntries(blocks.map((b) => [b.id, wrapped(b)])),
      ...(collections.length ? { collection: Object.fromEntries(collections.map((c) => [c.id, wrapped(c)])) } : {}),
    },
  }
}
const OPEN_PAGE = records([{ id: PAGE, type: 'page', properties: { title: [['Fixture page']] } }])

const run = async (args: Rec = {}) => (await listPages.run(args)) as string

describe('UC-NOTION-005 browse the workspace', () => {
  it('[UC-NOTION-005-S01] lists the top level by section, with titles and ids and no content', async () => {
    const getSpaces = {
      [USER]: {
        __version__: 3,
        space: { [SPACE]: wrapped({ id: SPACE, name: 'Fixture workspace', pages: [id(5)] }) },
        space_view: {
          'b0b0b0b0-0000-4000-8000-000000000001': wrapped({
            id: 'b0b0b0b0-0000-4000-8000-000000000001',
            space_id: SPACE,
            private_pages: [id(1), id(2)],
            shared_pages_manual_sort: [id(3)],
          }),
        },
        team: {
          'd0d0d0d0-0000-4000-8000-000000000001': wrapped({
            id: 'd0d0d0d0-0000-4000-8000-000000000001',
            space_id: SPACE,
            name: 'Engineering',
            pages: [id(4)],
          }),
        },
      },
    }
    const tab = new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, getSpaces)
      // One lookup per section, plus the database's name.
      .respond(
        'syncRecordValuesMain',
        200,
        records([page(1, 'Notes', [id(9)]), { id: id(2), type: 'collection_view_page', collection_id: COLLECTION }]),
      )
      .respond('syncRecordValuesMain', 200, records([], [{ id: COLLECTION, name: [['Tasks']] }]))
      .respond('syncRecordValuesMain', 200, records([page(3, 'Shared plan')]))
      .respond('syncRecordValuesMain', 200, records([page(5, 'Company home')]))
      .respond('syncRecordValuesMain', 200, records([page(4, 'Eng handbook')]))
      .install()

    expect(await run()).toBe(
      [
        'Pages in the workspace “Fixture workspace”:',
        '',
        'Private',
        `- 📄 Notes ^${hex(id(1))}`,
        `- 🗃 Tasks ^${hex(id(2))}`,
        '',
        'Shared',
        `- 📄 Shared plan ^${hex(id(3))}`,
        '',
        'Workspace',
        `- 📄 Company home ^${hex(id(5))}`,
        '',
        'Teamspace: Engineering',
        `- 📄 Eng handbook ^${hex(id(4))}`,
      ].join('\n'),
    )
    // No page content was loaded.
    expect(tab.sent.map((r) => r.url.split('/api/v3/')[1])).not.toContain('loadPageChunk')
  })

  it('[UC-NOTION-005-S02] lists the pages under a page, as deep as asked and no deeper', async () => {
    const root = page(10, 'Projects', [id(11), id(12), id(13)])
    const level1 = [
      page(11, 'Alpha', [id(21)]),
      { id: id(12), type: 'text', properties: { title: [['Just text']] } },
      { id: id(13), type: 'column_list', content: [id(14)] },
    ]
    const column = { id: id(14), type: 'column', content: [id(15)] }
    const beta = page(15, 'Beta')
    const level2 = [page(21, 'Alpha notes', [id(31)])]
    const tab = new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, records([root]))
      .respond('syncRecordValuesMain', 200, records(level1))
      .respond('syncRecordValuesMain', 200, records([column]))
      .respond('syncRecordValuesMain', 200, records([beta]))
      .respond('syncRecordValuesMain', 200, records(level2))
      .install()

    expect(await run({ page: hex(id(10)), depth: 2 })).toBe(
      [
        `Pages under “Projects” ^${hex(id(10))}:`,
        '',
        `- 📄 Alpha ^${hex(id(11))}`,
        `  - 📄 Alpha notes ^${hex(id(21))}`,
        `- 📄 Beta ^${hex(id(15))}`,
      ].join('\n'),
    )
    // Alpha notes' own child (a third level) was never asked for.
    expect(JSON.stringify(tab.sent.map((r) => r.body))).not.toContain(id(31))
  })

  it('[UC-NOTION-005-S03] says when the list was cut off', async () => {
    const many = Array.from({ length: LIST_LIMIT + 20 }, (_, i) => id(100 + i))
    const root = page(10, 'Big', many)
    new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, records([root]))
      // The children are looked up 100 at a time.
      .respond(
        'syncRecordValuesMain',
        200,
        records(many.slice(0, 100).map((m, i) => ({ ...page(0, `Page ${i}`), id: m }))),
      )
      .respond(
        'syncRecordValuesMain',
        200,
        records(many.slice(100).map((m, i) => ({ ...page(0, `Page ${100 + i}`), id: m }))),
      )
      .install()
    const result = await run({ page: hex(id(10)) })
    expect(result.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(LIST_LIMIT)
    expect(result).toContain(`Only the first ${LIST_LIMIT} pages are listed; the rest can't be listed yet.`)
  })
})

describe('list_pages sections', () => {
  it('gives each top-level section its own limit, so a long one hides no other', async () => {
    const many = Array.from({ length: SECTION_LIMIT + 10 }, (_, i) => id(200 + i))
    const getSpaces = {
      [USER]: {
        __version__: 3,
        space: { [SPACE]: wrapped({ id: SPACE, name: 'Fixture workspace' }) },
        space_view: {
          'b0b0b0b0-0000-4000-8000-000000000001': wrapped({
            id: 'b0b0b0b0-0000-4000-8000-000000000001',
            space_id: SPACE,
            private_pages: many,
            // A shared page that is also private is listed under Private only.
            shared_pages_manual_sort: [id(3), many[0]],
          }),
        },
      },
    }
    new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, getSpaces)
      .respond('syncRecordValuesMain', 200, records(many.map((m, i) => ({ ...page(0, `Private ${i}`), id: m }))))
      .respond('syncRecordValuesMain', 200, records([page(3, 'Shared plan')]))
      .install()
    const result = await run()
    expect(result).toContain(`(Only the first ${SECTION_LIMIT} entries of this section are listed.)`)
    // The shared section is still there, and a page already listed isn't listed twice.
    expect(result.split('Shared\n')[1]).toBe(`- 📄 Shared plan ^${hex(id(3))}`)
  })
})

describe('list_pages arguments', () => {
  it('checks depth and the page before asking Notion', async () => {
    const tab = new FakeNotionTab(PAGE_URL).install()
    await expect(run({ depth: 4 })).rejects.toThrow('`depth` must be a whole number from 1 to 3.')
    await expect(run({ page: 'Roadmap' })).rejects.toThrow('Not a Notion page URL or id: Roadmap')
    expect(tab.sent).toEqual([])
  })

  it('says a page with nothing under it has no pages', async () => {
    new FakeNotionTab(PAGE_URL).respond('syncRecordValuesMain', 200, records([page(10, 'Empty')])).install()
    expect(await run({ page: hex(id(10)) })).toBe(`Pages under “Empty” ^${hex(id(10))}:\n\n(no pages)`)
  })
})
