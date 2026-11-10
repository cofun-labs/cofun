// Moving, duplicating, and trashing pages (move_page, duplicate_page, and trash_page in
// extension/src/tools.ts), against a fake Notion workspace that applies them the way Notion does.
import { afterEach, describe, expect, it } from 'vitest'
import { PREVIEW_LOOKUP_MS, duplicatePage, forgetReads, movePage, readPage, trashPage } from '../../extension/src/tools'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, notionError, restoreGlobals } from './notion-tab'

afterEach(() => {
  restoreGlobals()
  forgetReads()
})

const hex = (s: string) => s.replace(/-/g, '')
const id = (n: number) => `b0b0b0b0-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
// PAGE (top level) holds PROJECTS and ARCHIVE; PROJECTS holds PLAN, which holds DRAFT.
const PROJECTS = id(1)
const ARCHIVE = id(2)
const PLAN = id(3)
const DRAFT = id(4)
const NOTE = id(5)
const TEXT = id(6)
const DB = id(7)
const ROW = id(8)
const COLLECTION = 'c0c0c0c0-0000-4000-8000-000000000009'
const TEAM = 'ee0e0e0e-0000-4000-8000-000000000001'
const TEAM_PAGE = id(10)

const page = (pageId: string, title: string, parent: string, content: string[] = []) => ({
  id: pageId,
  type: 'page',
  properties: { title: [[title]] },
  parent_id: parent,
  parent_table: 'block',
  content,
})

function workspace() {
  const ws = new FakeWorkspace(
    [
      { id: SPACE, pages: [PAGE] },
      {
        ...page(PAGE, 'Fixture page', SPACE, [PROJECTS, ARCHIVE, DB]),
        parent_table: 'space',
      },
      page(PROJECTS, 'Projects', PAGE, [PLAN, NOTE]),
      page(ARCHIVE, 'Archive', PAGE),
      page(PLAN, 'Launch plan', PROJECTS, [TEXT, DRAFT]),
      { id: TEXT, type: 'text', properties: { title: [['Ship in May']] }, parent_id: PLAN, parent_table: 'block' },
      page(DRAFT, 'Draft', PLAN),
      page(NOTE, 'Note', PROJECTS),
      {
        id: DB,
        type: 'collection_view_page',
        collection_id: COLLECTION,
        parent_id: PAGE,
        parent_table: 'block',
      },
      { ...page(ROW, 'A task', COLLECTION), parent_table: 'collection' },
      { ...page(TEAM_PAGE, 'Team wiki', TEAM), parent_table: 'team' },
    ],
    SPACE,
  )
  ws.collections.set(COLLECTION, {
    id: COLLECTION,
    version: 1,
    name: [['Tasks']],
    schema: {},
    space_id: SPACE,
    parent_id: DB,
    parent_table: 'block',
  })
  return ws
}

function open(ws: FakeWorkspace) {
  const tab = new FakeNotionTab(PAGE_URL)
  tab.workspace = ws
  return tab.install()
}

const contentOf = (ws: FakeWorkspace, parent: string) => ws.records.get(parent)!.content as string[]
const titleOf = (ws: FakeWorkspace, pageId: string) =>
  (ws.records.get(pageId)!.properties as { title: string[][] }).title[0][0]

describe('UC-NOTION-010 reorganize pages', () => {
  it('[UC-NOTION-010-S01] moves a page with its content to the end of another page, without asking', async () => {
    const ws = workspace()
    open(ws)
    expect(movePage.needsConfirmation).toBeFalsy()
    const result = await movePage.run({ pages: [hex(PLAN)], to: ARCHIVE })
    expect(result).toBe(`Moved 1 page to the end of ^${hex(ARCHIVE)}: ^${hex(PLAN)}.`)
    expect(contentOf(ws, ARCHIVE)).toEqual([PLAN])
    expect(contentOf(ws, PROJECTS)).toEqual([NOTE])
    expect(ws.records.get(PLAN)).toMatchObject({ parent_id: ARCHIVE, alive: true, content: [TEXT, DRAFT] })
    expect(ws.transactions).toHaveLength(1)
  })

  it('[UC-NOTION-010-S01] moves several pages in one change, in the order given', async () => {
    const ws = workspace()
    open(ws)
    await movePage.run({ pages: [NOTE, PLAN], to: `${PAGE_URL.replace(hex(PAGE), hex(ARCHIVE))}` })
    expect(contentOf(ws, ARCHIVE)).toEqual([NOTE, PLAN])
    expect(contentOf(ws, PROJECTS)).toEqual([])
    expect(ws.transactions).toHaveLength(1)
  })

  it('[UC-NOTION-010-S04] refuses to move a page into itself or a page inside it', async () => {
    const ws = workspace()
    open(ws)
    await expect(movePage.run({ pages: [PLAN], to: PLAN })).rejects.toThrow("can't be moved into itself")
    await expect(movePage.run({ pages: [PROJECTS], to: DRAFT })).rejects.toThrow(
      `^${hex(PROJECTS)} can't be moved into ^${hex(DRAFT)}: that page is inside it.`,
    )
    // One page of several is enough to refuse them all.
    await expect(movePage.run({ pages: [NOTE, PLAN], to: DRAFT })).rejects.toThrow('that page is inside it')
    expect(ws.transactions).toEqual([])
    expect(ws.records.get(PLAN)!.parent_id).toBe(PROJECTS)
  })

  it('[UC-NOTION-010-S04] refuses to move a page into a row of a database inside it', async () => {
    const ws = workspace()
    open(ws)
    // ROW is a row of the database DB, which is inside PAGE.
    await expect(movePage.run({ pages: [PAGE], to: ROW })).rejects.toThrow(
      `^${hex(PAGE)} can't be moved into ^${hex(ROW)}: that page is inside it.`,
    )
    expect(ws.transactions).toEqual([])
  })

  it('[UC-NOTION-010-S03] duplicates a page with its content right after it, without asking', async () => {
    const ws = workspace()
    open(ws)
    expect(duplicatePage.needsConfirmation).toBeFalsy()
    const result = (await duplicatePage.run({ page: hex(PLAN) })) as string
    const [, copy] = contentOf(ws, PROJECTS)
    expect(contentOf(ws, PROJECTS)).toEqual([PLAN, copy, NOTE])
    expect(result).toBe(
      `Duplicated ^${hex(PLAN)} as ^${hex(copy)}, right after it in ^${hex(PROJECTS)}.\n` +
        `URL: https://app.notion.com/${hex(copy)}`,
    )
    expect(titleOf(ws, copy)).toBe('Launch plan (1)')
    // The copy has its own blocks, with the same content, child pages included.
    const [text, draft] = contentOf(ws, copy)
    expect([text, draft]).not.toContain(TEXT)
    expect(titleOf(ws, text)).toBe('Ship in May')
    expect(titleOf(ws, draft)).toBe('Draft')
    expect(ws.records.get(PLAN)).toMatchObject({ content: [TEXT, DRAFT], properties: { title: [['Launch plan']] } })
  })

  it('[UC-NOTION-010-S02] trashing asks first, and names each page as Notion has it now', async () => {
    const ws = workspace()
    open(ws)
    expect(trashPage.needsConfirmation).toBe(true)
    // Renamed in Notion after the agent read it: the user sees the name it has now.
    await readPage.run({ page: hex(PAGE) })
    ws.edit(NOTE, { properties: { title: [['Old note']] } })
    expect(await trashPage.preview!({ pages: [hex(NOTE), DB, PLAN] })).toBe(
      [
        'Move 3 pages to the trash, with everything in them',
        `    Old note ^${hex(NOTE)}`,
        `    Tasks ^${hex(DB)}`,
        `    Launch plan ^${hex(PLAN)}`,
        "They stay in Notion's trash, where they can be restored.",
      ].join('\n'),
    )
  })

  it('[UC-NOTION-010-S02] puts the pages in the trash, out of their parents, where they can be restored', async () => {
    const ws = workspace()
    open(ws)
    const result = await trashPage.run({ pages: [hex(NOTE), DB] })
    expect(result).toBe(
      `Moved 2 pages to Notion's trash: ^${hex(NOTE)}, ^${hex(DB)}.\nThey can be restored from Notion's trash.`,
    )
    expect(contentOf(ws, PROJECTS)).toEqual([PLAN])
    expect(contentOf(ws, PAGE)).toEqual([PROJECTS, ARCHIVE])
    // Still there, and marked as trashed, not deleted: Notion can restore them.
    expect(ws.records.get(NOTE)).toMatchObject({
      alive: false,
      parent_id: PROJECTS,
      moved_to_trash_time: expect.any(Number),
    })
    expect(ws.records.get(DB)).toMatchObject({ alive: false, parent_id: PAGE })
    expect(ws.transactions).toHaveLength(1)
    expect(ws.contentDeletes).toEqual([
      {
        records: [
          { id: NOTE, table: 'block', spaceId: SPACE },
          { id: DB, table: 'block', spaceId: SPACE },
        ],
        permanentlyDelete: false,
      },
    ])
    // A trashed page can't be read any more.
    await expect(readPage.run({ page: NOTE })).rejects.toThrow('in the trash')
  })
})

describe('moving pages', () => {
  it('refuses rows, blocks, teamspace top-level pages, and other workspaces, and moves only into a page', async () => {
    const ws = workspace()
    ws.records.set(id(20), { ...page(id(20), 'Elsewhere', SPACE), id: id(20), version: 1, space_id: 'other' })
    open(ws)
    await expect(movePage.run({ pages: [ROW], to: ARCHIVE })).rejects.toThrow('is a database row')
    await expect(movePage.run({ pages: [TEXT], to: ARCHIVE })).rejects.toThrow('is a block inside a page')
    await expect(movePage.run({ pages: [PLAN], to: DB })).rejects.toThrow('is a database: pages can only be moved')
    await expect(movePage.run({ pages: [PLAN], to: TEXT })).rejects.toThrow('is a block inside a page')
    await expect(movePage.run({ pages: [id(20)], to: ARCHIVE })).rejects.toThrow('in another workspace')
    await expect(movePage.run({ pages: [TEAM_PAGE], to: ARCHIVE })).rejects.toThrow('at the top of a teamspace')
    await expect(movePage.run({ pages: [], to: ARCHIVE })).rejects.toThrow('at least one page')
    await expect(movePage.run({ pages: ['nope'], to: ARCHIVE })).rejects.toThrow('not a Notion page URL or id')
    await expect(movePage.run({ pages: [PLAN] })).rejects.toThrow('`to` is required')
    expect(ws.transactions).toEqual([])
  })

  it('moves a database that is a page of its own, and a page from the top of the sidebar', async () => {
    const ws = workspace()
    const TOP = id(21)
    ws.records.set(TOP, {
      ...page(TOP, 'Loose page', SPACE),
      parent_table: 'space',
      version: 1,
      alive: true,
      space_id: SPACE,
    })
    ws.edit(SPACE, { pages: [PAGE, TOP] })
    open(ws)
    await movePage.run({ pages: [DB, TOP], to: ARCHIVE })
    expect(contentOf(ws, ARCHIVE)).toEqual([DB, TOP])
    expect(ws.records.get(SPACE)!.pages).toEqual([PAGE])
    expect(ws.records.get(TOP)).toMatchObject({ parent_id: ARCHIVE, parent_table: 'block' })
  })

  it('moves a page inside another moving page along with it, where it is', async () => {
    const ws = workspace()
    open(ws)
    const result = await movePage.run({ pages: [DRAFT, PROJECTS], to: ARCHIVE })
    expect(result).toBe(
      `Moved 1 page to the end of ^${hex(ARCHIVE)}: ^${hex(PROJECTS)}.\n^${hex(DRAFT)} went along inside ^${hex(PROJECTS)}.`,
    )
    expect(contentOf(ws, ARCHIVE)).toEqual([PROJECTS])
    expect(contentOf(ws, PLAN)).toEqual([TEXT, DRAFT])
  })

  it('names the pages it has seen in the preview', async () => {
    const ws = workspace()
    open(ws)
    await readPage.run({ page: hex(ARCHIVE) })
    expect(movePage.preview!({ pages: [hex(PLAN), 'nonsense'], to: hex(ARCHIVE) })).toBe(
      ['Move 2 pages', `To the end of: Archive ^${hex(ARCHIVE)}`, `    ^${hex(PLAN)}`, '    nonsense'].join('\n'),
    )
  })
})

describe('duplicating pages', () => {
  it('refuses rows, blocks, and pages at the top of the sidebar', async () => {
    const ws = workspace()
    open(ws)
    await expect(duplicatePage.run({ page: ROW })).rejects.toThrow('is a database row')
    await expect(duplicatePage.run({ page: TEXT })).rejects.toThrow('is a block inside a page')
    await expect(duplicatePage.run({ page: PAGE })).rejects.toThrow('at the top of the sidebar')
    await expect(duplicatePage.run({ page: TEAM_PAGE })).rejects.toThrow('at the top of the sidebar')
    expect(ws.tasks.size).toBe(0)
  })

  it('keeps checking on the copy when one check fails', async () => {
    const ws = workspace()
    const tab = open(ws)
    tab.respond('getTasks', 502, { name: 'BadGateway' })
    await duplicatePage.run({ page: PLAN })
    expect(contentOf(ws, PROJECTS)).toHaveLength(3)
  })

  it('stops checking at once when Notion refuses the check, and says the copy may still appear', async () => {
    const ws = workspace()
    const tab = open(ws)
    tab.respond('getTasks', 400, { name: 'ValidationError', debugMessage: 'Unknown task.' })
    const err = await notionError(duplicatePage.run({ page: PLAN }))
    expect(err.code).toBe('outcome_unknown')
    expect(tab.sent.filter((r) => r.url.endsWith('/getTasks'))).toHaveLength(1)
  })

  it('says the copy may still appear when the account is signed out while Notion copies', async () => {
    const ws = workspace()
    const tab = open(ws)
    tab.respond('getTasks', 401, { name: 'UnauthorizedError' })
    const err = await notionError(duplicatePage.run({ page: PLAN }))
    expect(err.code).toBe('outcome_unknown')
    expect(err.message).toContain('it may still appear')
  })

  it('says so when Notion fails to copy the page', async () => {
    const ws = workspace()
    ws.failTask = true
    open(ws)
    const err = await notionError(duplicatePage.run({ page: PLAN }))
    expect(err.code).toBe('notion_error')
    expect(err.message).toBe('Notion could not copy the page: Copy failed.')
  })

  it('stopped while Notion copies, says the copy may still appear and where to look', async () => {
    const ws = workspace()
    open(ws)
    const stop = new AbortController()
    const running = duplicatePage.run({ page: PLAN }, stop.signal)
    setTimeout(() => stop.abort(), 20)
    const err = await notionError(running)
    expect(err.code).toBe('outcome_unknown')
    expect(err.message).toContain('it may still appear')
    expect(err.message).toContain(`List the pages of ^${hex(PROJECTS)}`)
  })

  it('names the page workspace on the request, so Notion copies it where it lives', async () => {
    const ws = workspace()
    const tab = open(ws)
    await duplicatePage.run({ page: PLAN })
    const sent = tab.sent.find((r) => r.url.endsWith('/enqueueTask'))!
    expect(sent.headers['x-notion-space-id']).toBe(SPACE)
    expect(sent.body).toMatchObject({
      task: {
        eventName: 'duplicateSubtree',
        request: {
          source: { ids: [PLAN], spaceId: SPACE },
          destination: { type: 'block', parent: { table: 'block', id: PROJECTS, spaceId: SPACE }, siblingId: PLAN },
        },
        cellRouting: { spaceIds: [SPACE] },
      },
    })
  })
})

describe('trashing pages', () => {
  it('leaves a page inside another page being trashed where it is, so restoring brings both back', async () => {
    const ws = workspace()
    open(ws)
    const result = await trashPage.run({ pages: [PLAN, PROJECTS, DRAFT] })
    expect(result).toContain(`^${hex(PLAN)} went inside ^${hex(PROJECTS)}.`)
    expect(result).toContain(`^${hex(DRAFT)} went inside ^${hex(PROJECTS)}.`)
    expect(contentOf(ws, PAGE)).toEqual([ARCHIVE, DB])
    expect(contentOf(ws, PROJECTS)).toEqual([PLAN, NOTE])
    expect(contentOf(ws, PLAN)).toEqual([TEXT, DRAFT])
    expect(ws.records.get(PROJECTS)!.alive).toBe(false)
  })

  it('names the pages already in the trash, and trashes nothing', async () => {
    const ws = workspace()
    open(ws)
    await trashPage.run({ pages: [NOTE] })
    const err = await notionError(trashPage.run({ pages: [ARCHIVE, NOTE] }))
    expect(err.message).toBe(
      `^${hex(NOTE)} is in the trash, or can't be opened with this Notion account. Nothing was changed.`,
    )
    expect(ws.records.get(ARCHIVE)!.alive).toBe(true)
  })

  it('lists each page once in the preview, as it is trashed once', async () => {
    const ws = workspace()
    open(ws)
    expect(await trashPage.preview!({ pages: [NOTE, hex(NOTE), PLAN] })).toBe(
      [
        'Move 2 pages to the trash, with everything in them',
        `    Note ^${hex(NOTE)}`,
        `    Launch plan ^${hex(PLAN)}`,
        "They stay in Notion's trash, where they can be restored.",
      ].join('\n'),
    )
  })

  it('previews from what the agent saw when Notion is too slow to answer', async () => {
    const ws = workspace()
    const tab = open(ws)
    await readPage.run({ page: hex(ARCHIVE) })
    tab.stalled = true
    const started = Date.now()
    expect(await trashPage.preview!({ pages: [hex(ARCHIVE)] })).toContain(`    Archive ^${hex(ARCHIVE)}`)
    expect(Date.now() - started).toBeLessThan(PREVIEW_LOOKUP_MS + 1_000)
  })

  it('trashes a page at the top of the sidebar from its workspace', async () => {
    const ws = workspace()
    open(ws)
    await trashPage.run({ pages: [PAGE] })
    expect(ws.records.get(SPACE)!.pages).toEqual([])
    expect(ws.records.get(PAGE)!.alive).toBe(false)
  })

  it('refuses rows, blocks, and pages at the top of a teamspace, and trashes nothing', async () => {
    const ws = workspace()
    open(ws)
    await expect(trashPage.run({ pages: [NOTE, ROW] })).rejects.toThrow('is a database row')
    await expect(trashPage.run({ pages: [TEXT] })).rejects.toThrow('is a block inside a page')
    await expect(trashPage.run({ pages: [TEAM_PAGE] })).rejects.toThrow('at the top of a teamspace')
    expect(ws.transactions).toEqual([])
    expect(ws.contentDeletes).toEqual([])
    expect(ws.records.get(NOTE)!.alive).toBe(true)
  })

  it('refuses a page that is already in the trash', async () => {
    const ws = workspace()
    open(ws)
    await trashPage.run({ pages: [NOTE] })
    await expect(trashPage.run({ pages: [NOTE] })).rejects.toThrow('in the trash')
    expect(ws.transactions).toHaveLength(1)
  })

  it('previews from what the agent saw when Notion cannot be asked', async () => {
    const ws = workspace()
    open(ws)
    await readPage.run({ page: hex(ARCHIVE) })
    restoreGlobals()
    expect(await trashPage.preview!({ pages: [hex(ARCHIVE), NOTE] })).toBe(
      [
        'Move 2 pages to the trash, with everything in them',
        `    Archive ^${hex(ARCHIVE)}`,
        `    ^${hex(NOTE)}`,
        "They stay in Notion's trash, where they can be restored.",
      ].join('\n'),
    )
  })
})
