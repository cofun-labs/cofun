// Undoing what a question changed (extensions/notico/src/tools/undo.ts and src/notion/undo.ts), through
// undo_changes, against a fake Notion workspace that applies transactions the way Notion does. Each
// test runs a question's write tools, files what they changed under the question as the side panel
// does when it ends, and undoes it. Grouped by rule: an undo puts back what the question changed,
// refuses when that changed since, names what it can't undo, and is sent once.
import { afterEach, describe, expect, it } from 'vitest'
import { ToolChat } from './tool-chat'
import { readPage } from '../src/tools/read'
import { addComment } from '../src/tools/comments'
import { undoChangesTool } from '../src/tools/undo'
import { createPage, editPage, updatePages } from '../src/tools/write'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, USER, restoreGlobals, resultText } from './notion-tab'

let chat = new ToolChat()

afterEach(() => {
  restoreGlobals()
  chat = new ToolChat()
})

const id = (n: number) => `e0e0e0e0-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const hex = (s: string) => s.replace(/-/g, '')
const DB = 'db0db0db-0000-4000-8000-000000000001'
const COLLECTION = 'c0c0c0c0-0000-4000-8000-000000000001'
const VIEW = 'e1e1e1e1-0000-4000-8000-000000000001'
const ROW = 'a1a1a1a1-0000-4000-8000-000000000001'
const CHILD = 'b1b1b1b1-0000-4000-8000-000000000001'

type Rec = Record<string, unknown>

const block = (n: number, type: string, text: string, extra: Rec = {}): Rec => ({
  id: id(n),
  type,
  parent_id: PAGE,
  parent_table: 'block',
  properties: { title: [[text]] },
  ...extra,
})

/** The fixture page with four blocks and a child page, and a task database with one row. */
function workspace(): FakeWorkspace {
  const ws = new FakeWorkspace(
    [
      {
        id: PAGE,
        type: 'page',
        properties: { title: [['Fixture page']] },
        format: { page_icon: '📄' },
        content: [id(1), id(2), id(3), id(4), CHILD],
        parent_id: SPACE,
        parent_table: 'space',
      },
      block(1, 'header', 'Plan'),
      block(2, 'text', 'Ship on Friday.'),
      block(3, 'to_do', 'Write notes', { properties: { title: [['Write notes']], checked: [['No']] } }),
      block(4, 'text', 'Old idea'),
      { id: CHILD, type: 'page', properties: { title: [['Child']] }, parent_id: PAGE, parent_table: 'block' },
      {
        id: DB,
        type: 'collection_view_page',
        collection_id: COLLECTION,
        view_ids: [VIEW],
        parent_id: SPACE,
        parent_table: 'space',
      },
      {
        id: ROW,
        type: 'page',
        parent_id: COLLECTION,
        parent_table: 'collection',
        properties: { title: [['Fix login']], 'a:a': [['In progress']] },
      },
    ],
    SPACE,
  )
  ws.collections.set(COLLECTION, {
    id: COLLECTION,
    version: 1,
    name: [['Tasks']],
    schema: {
      title: { name: 'Task', type: 'title' },
      'a:a': { name: 'Status', type: 'status', options: [{ value: 'In progress' }, { value: 'Done' }] },
    },
    space_id: SPACE,
  })
  return ws
}

function open(ws: FakeWorkspace): FakeNotionTab {
  const tab = new FakeNotionTab(PAGE_URL)
  tab.workspace = ws
  return tab.install()
}

/** Ends the question as the side panel does: what it changed is filed under it. */
function endQuestion(turn: string) {
  if (chat.memory.changes) chat.memory.undos.set(turn, chat.memory.changes)
  chat.memory.changes = undefined
}

const read = async () => resultText(await chat.run(readPage, {}))
const body = async () => {
  const result = await read()
  return result.slice(result.indexOf('\n\n') + 2).replace(/ \^[0-9a-f]{8,32}$/gm, '')
}
const undo = async () => resultText(await chat.run(undoChangesTool, {}))
const failure = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('It worked')
    },
    (err: Error) => err,
  )

describe('UC-NOTICO-NOTION-013 undo what a question changed', () => {
  it('[UC-NOTICO-NOTION-013-S01] puts back what an edit inserted, replaced, and deleted, in one transaction', async () => {
    const ws = workspace()
    open(ws)
    const before = await body()
    await read()
    await chat.run(editPage, {
      page: hex(PAGE),
      edits: [
        { action: 'insert', position: 'start', markdown: '## Summary\nShort summary' },
        // In place: the same kind of block.
        { action: 'replace', block: '^00000002', markdown: 'Ship on Monday.' },
        // By a new block: another kind.
        { action: 'replace', block: '^00000003', markdown: '- A list item now' },
        { action: 'delete', block: '^00000004' },
      ],
    })
    // A second edit in the same question, on a block the first one made.
    await read()
    const summary = [...ws.records.values()].find(
      (r) => JSON.stringify(r.properties) === '{"title":[["Short summary"]]}',
    )!
    await chat.run(editPage, {
      page: hex(PAGE),
      edits: [{ action: 'replace', block: `^${hex(summary.id).slice(-8)}`, markdown: 'A better summary' }],
    })
    endQuestion('q1')
    expect(await body()).not.toBe(before)

    const transactions = ws.transactions.length
    expect(await undo()).toMatch(
      /^Undone:\n {4}On “Fixture page”: delete 3 blocks it added, bring back 2 blocks it deleted, set back 1 value/,
    )
    expect(ws.transactions).toHaveLength(transactions + 1)
    expect(await body()).toBe(before)
    // Blocks that came back are the same blocks, with what they held.
    expect(ws.records.get(id(3))).toMatchObject({ alive: true, properties: { checked: [['No']] } })
    // Undone once: there is nothing more to undo.
    expect((await failure(chat.run(undoChangesTool, {}))).message).toMatch(/nothing/i)
  })

  it('[UC-NOTICO-NOTION-013-S01] blocks deleted by separate edits come back in their order, also next to blocks it added', async () => {
    const ws = workspace()
    open(ws)
    const before = await body()
    await read()
    // Next to the block deleted below, so its nearest neighbour is gone when it comes back.
    await chat.run(editPage, {
      page: hex(PAGE),
      edits: [{ action: 'insert', block: '^00000002', markdown: 'Added after Friday' }],
    })
    await chat.run(editPage, { page: hex(PAGE), edits: [{ action: 'delete', block: '^00000002' }] })
    await read()
    await chat.run(editPage, { page: hex(PAGE), edits: [{ action: 'delete', block: '^00000003' }] })
    await read()
    await chat.run(editPage, { page: hex(PAGE), edits: [{ action: 'delete', block: '^00000004' }] })
    endQuestion('q1')

    await undo()
    expect(await body()).toBe(before)
    expect(ws.records.get(PAGE)!.content).toEqual([id(1), id(2), id(3), id(4), CHILD])
  })

  it('[UC-NOTICO-NOTION-013-S03] refuses, changing nothing, when the pages can’t be read in this tab', async () => {
    const ws = workspace()
    open(ws)
    await chat.run(updatePages, { pages: [{ page: hex(PAGE), title: 'Renamed' }] })
    endQuestion('q1')
    // Notion answers for another account, which can't see the page.
    ws.records.delete(PAGE)
    const transactions = ws.transactions.length
    expect((await failure(chat.run(undoChangesTool, {}))).message).toBe(
      "Nothing was undone: “Fixture page” can't be read with the Notion account of this tab. Open Notion signed " +
        'in to the account the changes were made with, and undo again.',
    )
    expect(ws.transactions).toHaveLength(transactions)
  })

  it('[UC-NOTICO-NOTION-013-S02] moves the page and the row it created to the trash, and sets back titles, icons, and values', async () => {
    const ws = workspace()
    open(ws)
    const page = resultText(await chat.run(createPage, { title: 'Meeting notes', parent: hex(PAGE), markdown: 'Hi' }))
    const row = resultText(
      await chat.run(createPage, { title: 'New task', parent: hex(DB), properties: { Status: 'Done' } }),
    )
    await chat.run(updatePages, {
      pages: [
        { page: hex(PAGE), title: 'Renamed', icon: '🚀' },
        { page: hex(ROW), properties: { Status: 'Done' } },
      ],
    })
    endQuestion('q1')
    const made = (text: string) => /\^([0-9a-f]{32})/.exec(text)![1]
    const pageId = [...ws.records.keys()].find((k) => hex(k) === made(page))!
    const rowId = [...ws.records.keys()].find((k) => hex(k) === made(row))!

    const done = await undo()
    expect(done).toContain('Move “Meeting notes”, which it created, to the trash')
    expect(done).toContain('Move “New task”, which it created, to the trash')
    expect(ws.records.get(pageId)).toMatchObject({ alive: false })
    expect(ws.records.get(rowId)).toMatchObject({ alive: false })
    expect(ws.records.get(PAGE)!.content).not.toContain(pageId)
    // Notion is told they are in the trash, never to delete them for good.
    expect(ws.contentDeletes.at(-1)).toEqual({
      records: expect.arrayContaining([
        expect.objectContaining({ id: pageId }),
        expect.objectContaining({ id: rowId }),
      ]),
      permanentlyDelete: false,
    })
    expect(ws.records.get(PAGE)).toMatchObject({
      properties: { title: [['Fixture page']] },
      format: { page_icon: '📄' },
    })
    expect(ws.records.get(ROW)).toMatchObject({ properties: { 'a:a': [['In progress']] } })
  })

  it('[UC-NOTICO-NOTION-013-S03] refuses, changing nothing, when what the question changed was changed since', async () => {
    const ws = workspace()
    open(ws)
    await read()
    await chat.run(editPage, {
      page: hex(PAGE),
      edits: [
        { action: 'replace', block: '^00000002', markdown: 'Ship on Monday.' },
        { action: 'delete', block: '^00000004' },
      ],
    })
    endQuestion('q1')
    // The user edits the text the question wrote.
    ws.edit(id(2), { properties: { title: [['Ship on Tuesday.']] } })
    const transactions = ws.transactions.length

    const err = await failure(chat.run(undoChangesTool, {}))
    expect(err.message).toBe(
      'Nothing was undone: “Fixture page” changed since, and undoing would overwrite that. ' +
        "Notion's page history (… → Page history on each page) can restore an earlier version.",
    )
    expect(ws.transactions).toHaveLength(transactions)
    expect(ws.records.get(id(4))).toMatchObject({ alive: false })
  })

  it('[UC-NOTICO-NOTION-013-S03] refuses an earlier question whose page a later question changed again', async () => {
    const ws = workspace()
    open(ws)
    await chat.run(updatePages, { pages: [{ page: hex(PAGE), title: 'First' }] })
    endQuestion('q1')
    await chat.run(updatePages, { pages: [{ page: hex(PAGE), title: 'Second' }] })
    endQuestion('q2')
    // The latest question goes first, then the earlier one can be undone too.
    await undo()
    expect(ws.records.get(PAGE)).toMatchObject({ properties: { title: [['First']] } })
    await undo()
    expect(ws.records.get(PAGE)).toMatchObject({ properties: { title: [['Fixture page']] } })

    await chat.run(updatePages, { pages: [{ page: hex(PAGE), title: 'Third' }] })
    endQuestion('q3')
    await chat.run(updatePages, { pages: [{ page: hex(PAGE), title: 'Fourth' }] })
    endQuestion('q4')
    // Undoing q3 alone would overwrite q4's title.
    chat.memory.undos.delete('q4')
    expect((await failure(chat.run(undoChangesTool, {}))).message).toMatch(/^Nothing was undone: “Fixture page”/)
    expect(ws.records.get(PAGE)).toMatchObject({ properties: { title: [['Fourth']] } })
  })

  it('[UC-NOTICO-NOTION-013-S05] names what it can’t undo, and undoes the rest', async () => {
    const ws = workspace()
    ws.put('notion_user', { id: USER, name: 'Ann' })
    open(ws)
    // The comment first: what comes after it is still undone.
    await chat.run(addComment, { page: hex(PAGE), text: 'Looks good' })
    await chat.run(updatePages, { pages: [{ page: hex(PAGE), icon: '🚀' }] })
    endQuestion('q1')
    expect(chat.preview(undoChangesTool, {})).toBe(
      [
        'Undo what the last question that changed Notion did',
        'On “Fixture page”: set back 1 value it changed (text, titles, icons, properties)',
        'Not undone: the comment on "Fixture page"',
      ].join('\n'),
    )
    const done = await undo()
    expect(done).toMatch(/Not undone: the comment on "Fixture page"\.$/)
    expect(ws.records.get(PAGE)).toMatchObject({ format: { page_icon: '📄' } })
    expect(ws.table('comment')).toHaveLength(1)
  })

  it('[UC-NOTICO-NOTION-013-S04] asked again, undoes the question before the one it undid, even one with a comment', async () => {
    const ws = workspace()
    open(ws)
    await chat.run(updatePages, { pages: [{ page: hex(PAGE), title: 'First' }] })
    endQuestion('q1')
    await chat.run(updatePages, { pages: [{ page: hex(PAGE), icon: '🚀' }] })
    await chat.run(addComment, { page: hex(PAGE), text: 'Looks good' })
    endQuestion('q2')
    await undo()
    expect(chat.preview(undoChangesTool, {})).toContain('set back 1 value')
    await undo()
    expect(ws.records.get(PAGE)).toMatchObject({
      properties: { title: [['Fixture page']] },
      format: { page_icon: '📄' },
    })
  })

  it('[UC-NOTICO-NOTION-013-S06] an undo Notion doesn’t confirm is not tried again, and may have changed the pages', async () => {
    const ws = workspace()
    open(ws)
    await chat.run(updatePages, { pages: [{ page: hex(PAGE), title: 'Renamed' }] })
    endQuestion('q1')
    ws.failAfterApply = true
    const transactions = ws.transactions.length
    const err = (await failure(chat.run(undoChangesTool, {}))) as Error & {
      mayHaveChanged?: boolean
      stopsQuestion?: string
    }
    expect(err.message).toBe(
      'Notion did not confirm the undo, so it may or may not have been made. Check the pages before undoing again.',
    )
    expect(err.mayHaveChanged).toBe(true)
    expect(err.stopsQuestion).toBeTruthy()
    // Sent once.
    expect(ws.transactions).toHaveLength(transactions + 1)
    // It landed: undoing again finds the page not as the question left it, and changes nothing.
    expect((await failure(chat.run(undoChangesTool, {}))).message).toMatch(/^Nothing was undone/)
    expect(ws.transactions).toHaveLength(transactions + 1)
  })
})
