// The list_pages tool (extension/src/tools.ts) against a fake Notion tab that answers in the
// shapes Notion's getSpaces and syncRecordValuesMain return.
import { afterEach, describe, expect, it } from 'vitest'
import { LIST_LIMIT, SECTION_LIMIT, listPages } from '../../extension/src/tools'
import { FakeNotionTab, PAGE, PAGE_URL, SPACE, USER, notionError, restoreGlobals } from './notion-tab'
import { NO_USER_MAP } from '../../extension/src/notion/api'

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

const VIEW = 'b0b0b0b0-0000-4000-8000-000000000001'
/** getSpaces' answer for the tab's user: the workspace (teamspaces on) and their view of it. */
function spaces(space: Rec, view: Rec, user = USER) {
  return {
    [user]: {
      __version__: 3,
      space: {
        [SPACE]: wrapped({ id: SPACE, name: 'Fixture workspace', settings: { is_teams_enabled: true }, ...space }),
      },
      space_view: { [VIEW]: wrapped({ id: VIEW, space_id: SPACE, ...view }) },
    },
  }
}
const teamId = (n: number) => `d0d0d0d0-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
/** A teamspace record as getTeamsV2 returns it: its sidebar pages are `team_pages`. */
const team = (n: number, name: string, pages: string[], extra: Rec = {}) => ({
  id: teamId(n),
  name,
  team_pages: pages,
  team_page_id: id(9000 + n),
  parent_table: 'space',
  parent_id: SPACE,
  ...extra,
})
/** getTeamsV2's answer: the teamspaces in the sidebar's order, and their records. */
function teams(list: Rec[]) {
  return {
    teams: list.map((t) => ({ id: t.id, type: 'Joined', title: t.name, teamRole: 'member' })),
    recordMap: { __version__: 3, team: Object.fromEntries(list.map((t) => [t.id, wrapped(t)])) },
    hasUnjoinedActiveTeams: false,
  }
}
const endpoints = (tab: FakeNotionTab) => tab.sent.map((r) => r.url.split('/api/v3/')[1])

describe('UC-NOTION-005 browse the workspace', () => {
  it('[UC-NOTION-005-S01] lists the top level by section, with titles and ids and no content', async () => {
    const tab = new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond(
        'getSpaces',
        200,
        spaces({ pages: [id(5)] }, { private_pages: [id(1), id(2)], shared_pages_manual_sort: [id(3)] }),
      )
      .respond('getTeamsV2', 200, teams([team(1, 'Engineering', [id(4)])]))
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
    expect(endpoints(tab)).not.toContain('loadPageChunk')
  })

  it('[UC-NOTION-005-S05] lists the teamspaces the user joined, in the order Notion gives them, without archived ones', async () => {
    const tab = new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
      .respond(
        'getTeamsV2',
        200,
        teams([
          team(2, 'Design', [id(21), id(22)]),
          team(3, 'Old team', [id(31)], { archived_by: USER, archived_at: 1 }),
          team(1, 'Engineering', [id(11)]),
        ]),
      )
      .respond('syncRecordValuesMain', 200, records([page(1, 'Notes')]))
      .respond('syncRecordValuesMain', 200, records([page(21, 'Brand'), page(22, 'Icons')]))
      .respond('syncRecordValuesMain', 200, records([page(11, 'Eng handbook')]))
      .install()

    expect(await run()).toBe(
      [
        'Pages in the workspace “Fixture workspace”:',
        '',
        'Private',
        `- 📄 Notes ^${hex(id(1))}`,
        '',
        'Teamspace: Design',
        `- 📄 Brand ^${hex(id(21))}`,
        `- 📄 Icons ^${hex(id(22))}`,
        '',
        'Teamspace: Engineering',
        `- 📄 Eng handbook ^${hex(id(11))}`,
      ].join('\n'),
    )
    // Only teamspaces the user joined are asked for, and the archived one's pages never are.
    const asked = tab.sent.find((r) => r.url.endsWith('/getTeamsV2'))!
    expect(asked.body).toEqual({ spaceId: SPACE, teamTypes: ['Joined'] })
    expect(asked.headers['x-notion-space-id']).toBe(SPACE)
    expect(JSON.stringify(tab.sent.map((r) => r.body))).not.toContain(id(31))
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
    expect(result).toContain(`(Cut off: more entries follow. List them with \`offset: ${LIST_LIMIT}\`.)`)
  })

  it('[UC-NOTION-005-S06] lists the entries after the ones a cut-off list showed', async () => {
    // A text block among the children counts as an entry, so the offset lines up with the page's own list.
    const many = [id(99), ...Array.from({ length: LIST_LIMIT + 20 }, (_, i) => id(100 + i))]
    const root = page(10, 'Big', many)
    const blocks = [
      { id: id(99), type: 'text', properties: { title: [['Intro']] } },
      ...many.slice(1).map((m, i) => ({ ...page(0, `Page ${i}`), id: m })),
    ]
    const tab = () =>
      new FakeNotionTab(PAGE_URL)
        .respond('syncRecordValuesMain', 200, records([root]))
        // The children are looked up 100 at a time, to see through columns.
        .respond('syncRecordValuesMain', 200, records(blocks.slice(0, 100)))
        .respond('syncRecordValuesMain', 200, records(blocks.slice(100)))
        .install()
    tab()
    const first = await run({ page: hex(id(10)) })
    const next = LIST_LIMIT + 1
    expect(first).toContain(`List them with \`offset: ${next}\`.`)
    tab()
    const result = await run({ page: hex(id(10)), offset: next })
    expect(result.split('\n')[0]).toBe(`Pages under “Big” ^${hex(id(10))}, from entry ${next}:`)
    expect(result.split('\n').filter((l) => l.startsWith('- '))).toEqual(
      many.slice(next).map((m, i) => `- 📄 Page ${LIST_LIMIT + i} ^${hex(m)}`),
    )
    expect(result).not.toContain('Cut off')
  })

  it('[UC-NOTION-005-S06] lists one top-level section from where it was cut off', async () => {
    const many = Array.from({ length: SECTION_LIMIT + 10 }, (_, i) => id(200 + i))
    const workspace = () =>
      new FakeNotionTab(PAGE_URL)
        .respond('syncRecordValuesMain', 200, OPEN_PAGE)
        .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
        .respond('getTeamsV2', 200, teams([team(1, 'Engineering', many)]))
    workspace()
      .respond('syncRecordValuesMain', 200, records([page(1, 'Notes')]))
      .respond('syncRecordValuesMain', 200, records(many.map((m, i) => ({ ...page(0, `Eng ${i}`), id: m }))))
      .install()
    const first = await run()
    expect(first).toContain(
      `(Cut off: more entries follow. List them with \`section: "Teamspace: Engineering"\` and \`offset: ${SECTION_LIMIT}\`.)`,
    )

    workspace()
      .respond(
        'syncRecordValuesMain',
        200,
        records(many.slice(SECTION_LIMIT).map((m, i) => ({ ...page(0, `Eng ${SECTION_LIMIT + i}`), id: m }))),
      )
      .install()
    const rest = await run({ section: 'Teamspace: Engineering', offset: SECTION_LIMIT })
    expect(rest).toBe(
      [
        `Teamspace: Engineering, in the workspace “Fixture workspace”, from entry ${SECTION_LIMIT}:`,
        '',
        ...many.slice(SECTION_LIMIT).map((m, i) => `- 📄 Eng ${SECTION_LIMIT + i} ^${hex(m)}`),
      ].join('\n'),
    )
  })
})

describe('list_pages sections', () => {
  it('gives each top-level section its own limit, so a long one hides no other', async () => {
    const many = Array.from({ length: SECTION_LIMIT + 10 }, (_, i) => id(200 + i))
    // A shared page that is also private is listed under Private only.
    const getSpaces = spaces({}, { private_pages: many, shared_pages_manual_sort: [id(3), many[0]] })
    new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, getSpaces)
      .respond('getTeamsV2', 200, teams([]))
      .respond('syncRecordValuesMain', 200, records(many.map((m, i) => ({ ...page(0, `Private ${i}`), id: m }))))
      .respond('syncRecordValuesMain', 200, records([page(3, 'Shared plan')]))
      .install()
    const result = await run()
    expect(result).toContain(
      `(Cut off: more entries follow. List them with \`section: "Private"\` and \`offset: ${SECTION_LIMIT}\`.)`,
    )
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

  it('checks section and offset before asking Notion', async () => {
    const tab = new FakeNotionTab(PAGE_URL).install()
    await expect(run({ offset: 5 })).rejects.toThrow('`offset` needs `page` or `section`.')
    await expect(run({ page: hex(id(10)), section: 'Private' })).rejects.toThrow('Give `page` or `section`, not both.')
    await expect(run({ page: hex(id(10)), offset: -1 })).rejects.toThrow(
      '`offset` must be a whole number of at least 0.',
    )
    expect(tab.sent).toEqual([])
  })

  it('names the sections there are when asked for one that is not', async () => {
    new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
      .respond('getTeamsV2', 200, teams([team(1, 'Engineering', [id(11)])]))
      .install()
    await expect(run({ section: 'Marketing' })).rejects.toThrow(
      'No section “Marketing”. The sections are: Private, Shared, Workspace, Teamspace: Engineering.',
    )
  })

  it('tells apart teamspaces named like a built-in section or like each other', async () => {
    const workspace = () =>
      new FakeNotionTab(PAGE_URL)
        .respond('syncRecordValuesMain', 200, OPEN_PAGE)
        .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
        .respond(
          'getTeamsV2',
          200,
          teams([
            team(1, 'Private', [id(11)]),
            team(2, 'Design', [id(21)]),
            team(3, 'Design', [id(31)]),
            team(4, 'Design (1)', [id(41)]),
          ]),
        )
    workspace().install()
    await expect(run({ section: 'nope' })).rejects.toThrow(
      'The sections are: Private, Shared, Workspace, Teamspace: Private, Teamspace: Design (1), Teamspace: Design (2), ' +
        'Teamspace: Design (1) (1).',
    )
    const listed = async (section: string, page: Rec) => {
      workspace()
        .respond('syncRecordValuesMain', 200, records([page]))
        .install()
      return (await run({ section })).split('\n').slice(2)
    }
    expect(await listed('Private', page(1, 'Notes'))).toEqual([`- 📄 Notes ^${hex(id(1))}`])
    expect(await listed('Teamspace: Private', page(11, 'Team notes'))).toEqual([`- 📄 Team notes ^${hex(id(11))}`])
    expect(await listed('teamspace: design (2)', page(31, 'Second'))).toEqual([`- 📄 Second ^${hex(id(31))}`])
    expect(await listed('Teamspace: Design (1) (1)', page(41, 'Third'))).toEqual([`- 📄 Third ^${hex(id(41))}`])
    // A teamspace's own name picks it, even when another teamspace's label looks the same.
    expect(await listed('Design (1)', page(41, 'Third'))).toEqual([`- 📄 Third ^${hex(id(41))}`])
    // A name two teamspaces share names neither.
    workspace().install()
    await expect(run({ section: 'Design' })).rejects.toThrow('No section “Design”.')
  })

  it('tells apart teamspaces whose names differ only in case', async () => {
    const workspace = () =>
      new FakeNotionTab(PAGE_URL)
        .respond('syncRecordValuesMain', 200, OPEN_PAGE)
        .respond('getSpaces', 200, spaces({}, {}))
        .respond('getTeamsV2', 200, teams([team(1, 'Design', [id(11)]), team(2, 'design', [id(21)])]))
    workspace().install()
    await expect(run({ section: 'nope' })).rejects.toThrow(
      'The sections are: Private, Shared, Workspace, Teamspace: Design (1), Teamspace: design (2).',
    )
    workspace()
      .respond('syncRecordValuesMain', 200, records([page(21, 'Lower')]))
      .install()
    expect((await run({ section: 'Teamspace: design (2)' })).split('\n').slice(2)).toEqual([
      `- 📄 Lower ^${hex(id(21))}`,
    ])
  })

  it('says a page with nothing under it has no pages', async () => {
    new FakeNotionTab(PAGE_URL).respond('syncRecordValuesMain', 200, records([page(10, 'Empty')])).install()
    expect(await run({ page: hex(id(10)) })).toBe(`Pages under “Empty” ^${hex(id(10))}:\n\n(no pages)`)
  })
})

describe('list_pages at the limit', () => {
  it('looks into only as many parents as there is room left for', async () => {
    const kids = Array.from({ length: LIST_LIMIT - 2 }, (_, i) => id(300 + i))
    const root = page(10, 'Nearly full', kids)
    const tab = new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, records([root]))
      .respond(
        'syncRecordValuesMain',
        200,
        records(kids.map((k, i) => ({ ...page(0, `Child ${i}`, [id(1000 + i)]), id: k }))),
      )
      .respond('syncRecordValuesMain', 200, records([page(1000, 'Grandchild 0'), page(1001, 'Grandchild 1')]))
      .install()
    const result = await run({ page: hex(id(10)), depth: 2 })
    // Only the first two children's blocks were asked for.
    const asked = (tab.sent.at(-1)!.body as { requests: { pointer: { id: string } }[] }).requests
    expect(asked.map((r) => r.pointer.id)).toEqual([id(1000), id(1001)])
    expect(result.split('\n').filter((l) => l.trimStart().startsWith('- '))).toHaveLength(LIST_LIMIT)
    expect(result).toContain('To see what is under a listed page, list it by its id.')
  })

  it('says pages under the ones shown are left out too when the top level is cut off deeper than one level', async () => {
    const kids = Array.from({ length: LIST_LIMIT + 1 }, (_, i) => id(300 + i))
    const root = page(10, 'Too many', kids)
    new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, records([root]))
      .respond(
        'syncRecordValuesMain',
        200,
        records(kids.slice(0, 100).map((k, i) => ({ ...page(0, `Child ${i}`), id: k }))),
      )
      .respond('syncRecordValuesMain', 200, records(kids.slice(100).map((k) => ({ ...page(0, 'Last'), id: k }))))
      .install()
    expect(await run({ page: hex(id(10)), depth: 2 })).toContain(
      `List them with \`offset: ${LIST_LIMIT}\`. Pages under the ones shown may be left out too. To see what is under a listed page, list it by its id.)`,
    )
  })

  it("gives a section's own limit when the section fills up before the asked depth", async () => {
    const kids = Array.from({ length: SECTION_LIMIT }, (_, i) => id(500 + i))
    new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, spaces({}, { private_pages: kids }))
      .respond('getTeamsV2', 200, teams([]))
      .respond(
        'syncRecordValuesMain',
        200,
        records(kids.map((k, i) => ({ ...page(0, `Child ${i}`, [id(900)]), id: k }))),
      )
      .install()
    expect(await run({ depth: 2 })).toContain(`(Cut off: this list shows at most ${SECTION_LIMIT} pages,`)
  })

  it('[UC-NOTION-005-S03] says the list was cut off when it fills up before the asked depth', async () => {
    const kids = Array.from({ length: LIST_LIMIT }, (_, i) => id(300 + i))
    const root = page(10, 'Exactly full', kids)
    new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, records([root]))
      .respond(
        'syncRecordValuesMain',
        200,
        records(kids.slice(0, 100).map((k, i) => ({ ...page(0, `Child ${i}`, [id(900)]), id: k }))),
      )
      .install()
    const result = await run({ page: hex(id(10)), depth: 2 })
    expect(result.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(LIST_LIMIT)
    // Every child is listed, so the way to the rest is through them, not an offset.
    expect(result).toContain('To see what is under a listed page, list it by its id.')
    expect(result).not.toContain('offset')
  })
})

describe('list_pages workspace', () => {
  it("reads the tab's own user's view when several signed-in users share the workspace", async () => {
    const OTHER = '0e0e0e0e-0000-4000-8000-000000000099'
    new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      // The other account comes first, as Notion may list it.
      .respond('getSpaces', 200, {
        ...spaces({}, { private_pages: [id(2)] }, OTHER),
        ...spaces({}, { private_pages: [id(1)] }),
      })
      .respond('getTeamsV2', 200, teams([]))
      .respond('syncRecordValuesMain', 200, records([page(1, 'Mine')]))
      .install()
    expect(await run()).toContain(`Private\n- 📄 Mine ^${hex(id(1))}`)
  })

  it("says so when Notion's answer has nothing for the tab's own user", async () => {
    const OTHER = '0e0e0e0e-0000-4000-8000-000000000099'
    new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(2)] }, OTHER))
      .install()
    const err = await notionError(run())
    expect(err.code).toBe('notion_error')
    expect(err.message).toBe(NO_USER_MAP)
  })

  it('says the tab is signed out when it has no Notion user, and reads no account', async () => {
    new FakeNotionTab(PAGE_URL, 'notion_browser_id=b')
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
      .install()
    expect((await notionError(run())).code).toBe('signed_out')
  })

  it('finds the tab user when Notion keys it without hyphens', async () => {
    const answer = spaces({}, { private_pages: [id(1)] }, USER.replace(/-/g, ''))
    new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, answer)
      .respond('getTeamsV2', 200, teams([]))
      .respond('syncRecordValuesMain', 200, records([page(1, 'Mine')]))
      .install()
    expect(await run()).toContain(`Private\n- 📄 Mine ^${hex(id(1))}`)
  })

  it('finds the tab user by an undashed cookie id', async () => {
    new FakeNotionTab(PAGE_URL, `notion_user_id=${USER.replace(/-/g, '')}`)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
      .respond('getTeamsV2', 200, teams([]))
      .respond('syncRecordValuesMain', 200, records([page(1, 'Mine')]))
      .install()
    expect(await run()).toContain(`Private\n- 📄 Mine ^${hex(id(1))}`)
  })

  it('keeps a page in its first section only, even where that section is cut off before it', async () => {
    const many = Array.from({ length: SECTION_LIMIT + 1 }, (_, i) => id(600 + i))
    const last = many.at(-1)!
    new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, spaces({}, { private_pages: many, shared_pages_manual_sort: [last, id(3)] }))
      .respond('getTeamsV2', 200, teams([]))
      .respond('syncRecordValuesMain', 200, records(many.map((m, i) => ({ ...page(0, `Private ${i}`), id: m }))))
      .respond('syncRecordValuesMain', 200, records([page(3, 'Shared plan')]))
      .install()
    const result = await run()
    // The last private page is cut from Private and isn't moved to Shared; Private's offset reaches it.
    expect(result).toContain(`List them with \`section: "Private"\` and \`offset: ${SECTION_LIMIT}\`.)`)
    expect(result.split('Shared\n')[1]).toBe(`- 📄 Shared plan ^${hex(id(3))}`)
  })

  it('asks for teamspaces when the workspace does not say whether it has them', async () => {
    new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, spaces({ settings: {} }, {}))
      .respond('getTeamsV2', 200, teams([team(1, 'Engineering', [id(11)])]))
      .respond('syncRecordValuesMain', 200, records([page(11, 'Eng handbook')]))
      .install()
    expect(await run()).toContain(`Teamspace: Engineering\n- 📄 Eng handbook ^${hex(id(11))}`)
  })

  it('leaves out teams that getTeamsV2 lists as anything but joined', async () => {
    const answer = teams([team(1, 'Engineering', [id(11)]), team(2, 'Elsewhere', [id(21)])])
    answer.teams[1].type = 'Archived'
    new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, spaces({}, {}))
      .respond('getTeamsV2', 200, answer)
      .respond('syncRecordValuesMain', 200, records([page(11, 'Eng handbook')]))
      .install()
    const result = await run()
    expect(result).toContain('Teamspace: Engineering')
    expect(result).not.toContain('Elsewhere')
  })

  it('lists a section alone as the overview does, without pages an earlier section has', async () => {
    // The private page is also in Shared. Shared leaves it out, alone and in the overview, so their offsets agree.
    const shared = [id(1), ...Array.from({ length: SECTION_LIMIT + 5 }, (_, i) => id(400 + i))]
    const blocks = shared.slice(1).map((m, i) => ({ ...page(0, `Shared ${i}`), id: m }))
    const workspace = () =>
      new FakeNotionTab(PAGE_URL)
        .respond('syncRecordValuesMain', 200, OPEN_PAGE)
        .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)], shared_pages_manual_sort: shared }))
        .respond('getTeamsV2', 200, teams([]))
    workspace()
      .respond('syncRecordValuesMain', 200, records([page(1, 'Notes')]))
      .respond('syncRecordValuesMain', 200, records(blocks))
      .install()
    expect(await run()).toContain(`List them with \`section: "Shared"\` and \`offset: ${SECTION_LIMIT}\`.)`)
    workspace()
      .respond('syncRecordValuesMain', 200, records(blocks.slice(SECTION_LIMIT)))
      .install()
    const rest = (await run({ section: 'Shared', offset: SECTION_LIMIT })).split('\n').slice(2)
    expect(rest).toEqual(blocks.slice(SECTION_LIMIT).map((b, i) => `- 📄 Shared ${SECTION_LIMIT + i} ^${hex(b.id)}`))
  })

  it('still lists the other sections when the teamspaces fail to load', async () => {
    new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
      .respond('getTeamsV2', 400, { name: 'ValidationError', debugMessage: 'Invalid input.' })
      .respond('syncRecordValuesMain', 200, records([page(1, 'Notes')]))
      .install()
    expect(await run()).toBe(
      [
        'Pages in the workspace “Fixture workspace”:',
        '',
        'Private',
        `- 📄 Notes ^${hex(id(1))}`,
        '',
        '(Teamspaces could not be listed: Notion returned an error (400 ValidationError): Invalid input.)',
      ].join('\n'),
    )
  })

  it('asks for no teamspaces in a workspace that has them turned off', async () => {
    const getSpaces = spaces({ settings: { is_teams_enabled: false } }, { private_pages: [id(1)] })
    const tab = new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, OPEN_PAGE)
      .respond('getSpaces', 200, getSpaces)
      .respond('syncRecordValuesMain', 200, records([page(1, 'Notes')]))
      .install()
    expect(await run()).toBe(
      ['Pages in the workspace “Fixture workspace”:', '', 'Private', `- 📄 Notes ^${hex(id(1))}`].join('\n'),
    )
    expect(endpoints(tab)).not.toContain('getTeamsV2')
  })
})
