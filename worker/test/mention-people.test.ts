// Mentions of people in what the agent writes (edit_page, create_page, add_comment), against a fake
// Notion workspace whose members getVisibleUsers lists, as Notion's own @ menu sees them.
import { afterEach, describe, expect, it } from 'vitest'
import { LIMITED_STOP } from '../../extension/src/notion/api'
import { addComment, createPage, editPage, forgetReads, readPage } from '../../extension/src/tools'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, USER, notionError, restoreGlobals } from './notion-tab'

afterEach(() => {
  restoreGlobals()
  forgetReads()
})

const id = (n: number) => `e0e0e0e0-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const person = (n: number) => `0e0e0e0e-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const hex = (s: string) => s.replace(/-/g, '')
const KIM = person(10)
const ALEX = person(11)

type Rec = Record<string, unknown>

function block(n: number, type: string, title: unknown[]): Rec {
  return { id: id(n), type, parent_id: PAGE, parent_table: 'block', properties: { title } }
}

/** The fixture page holding `blocks`, in a workspace whose members are `people` (id, name). */
function workspace(
  blocks: Rec[],
  people: [string, string][] = [
    [KIM, 'Kim Lee'],
    [ALEX, 'Alex Kim'],
    [USER, 'Ann'],
  ],
) {
  const page = {
    id: PAGE,
    type: 'page',
    properties: { title: [['Fixture page']] },
    content: blocks.map((b) => b.id),
    parent_id: SPACE,
    parent_table: 'space',
  }
  const ws = new FakeWorkspace([page, ...blocks], SPACE)
  for (const [userId, name] of people) ws.put('notion_user', { id: userId, name })
  return ws
}

function open(ws: FakeWorkspace): FakeNotionTab {
  const tab = new FakeNotionTab(PAGE_URL)
  tab.workspace = ws
  return tab.install()
}

const endpoints = (tab: FakeNotionTab, from = 0) => tab.sent.slice(from).map((r) => r.url.split('/api/v3/')[1])
const read = async () => {
  const result = (await readPage.run({})) as string
  return result.slice(result.indexOf('\n\n') + 2)
}
const edit = async (edits: Rec[]) => (await editPage.run({ page: hex(PAGE), edits })) as string
const title = (ws: FakeWorkspace, blockId: string) => (ws.records.get(blockId)!.properties as Rec).title

describe('UC-NOTION-011 mention people', () => {
  it('[UC-NOTION-011-S01] writes a mention of the member named, which reads back as written', async () => {
    const ws = workspace([block(1, 'text', [['Intro']])])
    const tab = open(ws)
    await read()
    const sent = tab.sent.length

    await edit([{ action: 'insert', position: 'end', markdown: '- [ ] @[Kim Lee] to follow up' }])

    const added = ws.content(PAGE).at(-1)!
    expect(added.type).toBe('to_do')
    expect((added.properties as Rec).title).toEqual([['‣', [['u', KIM]]], [' to follow up']])
    // The members are looked up once: their list, then their names in one request.
    expect(endpoints(tab, sent)).toEqual([
      'loadPageChunk',
      'getVisibleUsers',
      'syncRecordValuesMain',
      'saveTransactionsFanout',
      'loadPageChunk',
    ])
    expect(await read()).toContain('- [ ] @[Kim Lee] to follow up ^')
  })

  it('[UC-NOTION-011-S01] matches a name whatever its case and spacing', async () => {
    const ws = workspace([block(1, 'text', [['Intro']])])
    open(ws)
    await read()
    await edit([{ action: 'replace', block: '^00000001', markdown: 'Ask @[kim  LEE] and **@[Ann]**' }])
    expect(title(ws, id(1))).toEqual([['Ask '], ['‣', [['u', KIM]]], [' and '], ['‣', [['b'], ['u', USER]]]])
  })

  it('[UC-NOTION-011-S02] keeps a mention when other text in its block changes', async () => {
    const ws = workspace([block(1, 'text', [['Call '], ['‣', [['u', KIM]]], [' today']])])
    open(ws)
    const shown = await read()
    expect(shown).toBe('Call @[Kim Lee] today ^00000001')

    // Written back as shown: nothing changes.
    expect(await edit([{ action: 'replace', block: '^00000001', markdown: 'Call @[Kim Lee] today' }])).toContain(
      'already had that content',
    )
    expect(ws.transactions).toEqual([])

    const result = await edit([{ action: 'replace', block: '^00000001', markdown: 'Call @[Kim Lee] tomorrow' }])
    expect(result).not.toContain('plain text')
    expect(title(ws, id(1))).toEqual([['Call '], ['‣', [['u', KIM]]], [' tomorrow']])
  })

  it('[UC-NOTION-011-S02] keeps the person a block mentions, even one no longer among the members', async () => {
    // Kim Lee left the workspace; Notion still loads their name with the page.
    const ws = workspace([block(1, 'to_do', [['‣', [['u', KIM]]], [' follows up']])])
    ws.visibleUsers = [ALEX, USER]
    ;(ws.records.get(id(1))!.properties as Rec).checked = [['No']]
    const tab = open(ws)
    expect(await read()).toBe('- [ ] @[Kim Lee] follows up ^00000001')
    const sent = tab.sent.length
    await edit([{ action: 'replace', block: '^00000001', markdown: '- [x] @[Kim Lee] follows up today' }])
    expect(title(ws, id(1))).toEqual([['‣', [['u', KIM]]], [' follows up today']])
    expect((ws.records.get(id(1))!.properties as Rec).checked).toEqual([['Yes']])
    // The block's own mention names the person: no member lookup.
    expect(endpoints(tab, sent)).not.toContain('getVisibleUsers')
  })

  it('[UC-NOTION-011-S02] keeps the person a block mentions when a member has the same name', async () => {
    const ws = workspace(
      [block(1, 'text', [['Call '], ['‣', [['u', KIM]]], [' today']])],
      [
        [KIM, 'Kim Lee'],
        [ALEX, 'Kim Lee'],
      ],
    )
    ws.visibleUsers = [ALEX]
    open(ws)
    await read()
    await edit([{ action: 'replace', block: '^00000001', markdown: 'Call @[Kim Lee] tomorrow' }])
    expect(title(ws, id(1))).toEqual([['Call '], ['‣', [['u', KIM]]], [' tomorrow']])
  })

  it('[UC-NOTION-011-S05] refuses a name a block mentions two people by', async () => {
    const ws = workspace(
      [block(1, 'text', [['‣', [['u', KIM]]], [' and '], ['‣', [['u', ALEX]]]])],
      [
        [KIM, 'Kim Lee'],
        [ALEX, 'Kim Lee'],
      ],
    )
    open(ws)
    expect(await read()).toBe('@[Kim Lee] and @[Kim Lee] ^00000001')
    await expect(
      edit([{ action: 'replace', block: '^00000001', markdown: '@[Kim Lee] and @[Kim Lee], today' }]),
    ).rejects.toThrow("the block mentions more than one person with that name, so a mention can't tell them apart")
    expect(ws.transactions).toEqual([])
  })

  it('[UC-NOTION-011-S03] mentions a member in a new page', async () => {
    const ws = workspace([block(1, 'text', [['Intro']])])
    open(ws)
    const result = (await createPage.run({
      title: 'Follow-ups',
      parent: hex(PAGE),
      markdown: '- [ ] @[Kim Lee] sends the notes',
    })) as string
    const pageId = /\^([0-9a-f]{32})/.exec(result)![1]
    const created = [...ws.records.values()].find((r) => hex(r.id) === pageId)!
    const [first] = ws.content(created.id)
    expect((first.properties as Rec).title).toEqual([['‣', [['u', KIM]]], [' sends the notes']])
  })

  it('[UC-NOTION-011-S03] mentions a member in a comment', async () => {
    const ws = workspace([block(1, 'text', [['Intro']])])
    open(ws)
    await addComment.run({ page: hex(PAGE), block: '^00000001', text: '@[Kim Lee], can you check this?' })
    const [added] = ws.table('comment')
    expect(added.text).toEqual([['‣', [['u', KIM]]], [', can you check this?']])
  })

  it('[UC-NOTION-011-S04] refuses a name no member has, and names the similar ones', async () => {
    const ws = workspace([block(1, 'text', [['Intro']])])
    open(ws)
    await read()
    const err = await edit([{ action: 'insert', position: 'end', markdown: 'Ask @[Kim] and @[Zed]' }]).catch(
      (e: Error) => e,
    )
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toContain(
      '@[Kim]: no workspace member has that name. Members with a similar name: “Alex Kim”, “Kim Lee”.',
    )
    // No name like it: no list of the members, which text in a page could otherwise have the agent fetch.
    expect(message).toContain('@[Zed]: no workspace member has that name. No member has a similar name')
    expect(message.split('\n')[1]).not.toContain('Ann')
    expect(message).toContain('Nothing was written.')
    expect(ws.transactions).toEqual([])
  })

  it('[UC-NOTION-011-S04] refuses a mention in a new page or a comment before writing anything', async () => {
    const ws = workspace([block(1, 'text', [['Intro']])])
    open(ws)
    await expect(createPage.run({ title: 'Notes', parent: hex(PAGE), markdown: '@[Nobody]' })).rejects.toThrow(
      '@[Nobody]: no workspace member has that name.',
    )
    await expect(addComment.run({ page: hex(PAGE), text: 'Hi @[Nobody]' })).rejects.toThrow(
      '@[Nobody]: no workspace member has that name.',
    )
    expect(ws.transactions).toEqual([])
  })

  it('[UC-NOTION-011-S05] refuses a name two members share', async () => {
    const ws = workspace(
      [block(1, 'text', [['Intro']])],
      [
        [KIM, 'Kim Lee'],
        [ALEX, 'Kim Lee'],
      ],
    )
    open(ws)
    await read()
    await expect(edit([{ action: 'insert', position: 'end', markdown: 'Ask @[Kim Lee]' }])).rejects.toThrow(
      "@[Kim Lee]: 2 workspace members are named “Kim Lee”, so a mention can't tell them apart.",
    )
    expect(ws.transactions).toEqual([])
  })
})

describe('mention details', () => {
  it('asks Notion for no members when nothing is mentioned', async () => {
    const ws = workspace([block(1, 'text', [['Intro']])])
    const tab = open(ws)
    await read()
    await edit([{ action: 'insert', position: 'end', markdown: 'Mail me@example.com, or @ me' }])
    await addComment.run({ page: hex(PAGE), text: 'Looks good' })
    expect(endpoints(tab)).not.toContain('getVisibleUsers')
  })

  it('looks up only the people the user can see', async () => {
    const ws = workspace([block(1, 'text', [['Intro']])])
    ws.visibleUsers = [ALEX, USER]
    open(ws)
    await read()
    await expect(edit([{ action: 'insert', position: 'end', markdown: '@[Kim Lee]' }])).rejects.toThrow(
      'no workspace member has that name',
    )
  })

  it('loads the names of many members in batches', async () => {
    const many: [string, string][] = Array.from({ length: 150 }, (_, n) => [person(100 + n), `Member ${n}`])
    const ws = workspace([block(1, 'text', [['Intro']])], [...many, [KIM, 'Kim Lee']])
    const tab = open(ws)
    await read()
    const sent = tab.sent.length
    await edit([{ action: 'insert', position: 'end', markdown: '@[Kim Lee]' }])
    expect(endpoints(tab, sent).filter((e) => e === 'getVisibleUsers' || e === 'syncRecordValuesMain')).toEqual([
      'getVisibleUsers',
      'syncRecordValuesMain',
      'syncRecordValuesMain',
    ])
    expect((ws.content(PAGE).at(-1)!.properties as Rec).title).toEqual([['‣', [['u', KIM]]]])
  })

  it('stops the question, writing nothing, when Notion turns the member lookup away', async () => {
    const ws = workspace([block(1, 'text', [['Intro']])])
    const tab = open(ws)
    await read()
    tab.limit('getVisibleUsers', 1)
    const err = await notionError(edit([{ action: 'insert', position: 'end', markdown: '@[Kim Lee]' }]))
    expect(err.stopsQuestion).toBe(LIMITED_STOP)
    expect(ws.transactions).toEqual([])
  })

  it('keeps an @ before a link, and a parenthesis after a mention, as they are', async () => {
    const ws = workspace([
      block(1, 'text', [['@'], ['docs', [['a', 'https://example.com']]]]),
      block(2, 'text', [['‣', [['u', KIM]]], ['(lead)']]),
    ])
    open(ws)
    const shown = await read()
    expect(shown).toBe(['@[docs](https://example.com) ^00000001', '@[Kim Lee]\\(lead) ^00000002'].join('\n'))
    await edit([
      { action: 'insert', block: '^00000001', markdown: '@[docs](https://example.com)' },
      { action: 'insert', block: '^00000002', markdown: '@[Kim Lee]\\(lead)' },
    ])
    const [, link, , mention] = ws.content(PAGE)
    expect((link.properties as Rec).title).toEqual([['@'], ['docs', [['a', 'https://example.com']]]])
    expect((mention.properties as Rec).title).toEqual([['‣', [['u', KIM]]], ['(lead)']])
  })

  it('reads back a name with brackets and marks in it as the same mention', async () => {
    const ws = workspace([block(1, 'text', [['‣', [['u', KIM]]]])], [[KIM, 'Ops [EU] *on call*']])
    open(ws)
    const shown = await read()
    expect(shown).toBe('@[Ops \\[EU\\] \\*on call\\*] ^00000001')
    await edit([{ action: 'insert', block: '^00000001', markdown: shown.replace(/ \^\w+$/, '') }])
    expect((ws.content(PAGE)[1].properties as Rec).title).toEqual([['‣', [['u', KIM]]]])
  })

  it('reads a bold mention back with its marks', async () => {
    const ws = workspace([block(1, 'text', [['‣', [['b'], ['u', KIM]]], [' and '], ['‣', [['s'], ['u', KIM]]]])])
    open(ws)
    const shown = await read()
    expect(shown).toBe('**@[Kim Lee]** and ~~@[Kim Lee]~~ ^00000001')
    await edit([{ action: 'insert', block: '^00000001', markdown: shown.replace(/ \^\w+$/, '') }])
    expect((ws.content(PAGE)[1].properties as Rec).title).toEqual([
      ['‣', [['b'], ['u', KIM]]],
      [' and '],
      ['‣', [['s'], ['u', KIM]]],
    ])
  })

  it('keeps a backslash before a parenthesis that does not follow a mention', async () => {
    const ws = workspace([block(1, 'text', [['Intro']])])
    open(ws)
    await read()
    await edit([{ action: 'insert', position: 'end', markdown: 'Inline math \\(x\\)' }])
    expect((ws.content(PAGE).at(-1)!.properties as Rec).title).toEqual([['Inline math \\(x\\)']])
  })

  it('says when rewriting a block drops the link on a mention, which read_page does not show', async () => {
    const ws = workspace([
      block(1, 'text', [
        ['Call '],
        [
          '‣',
          [
            ['u', KIM],
            ['a', 'https://example.com'],
          ],
        ],
      ]),
    ])
    open(ws)
    expect(await read()).toBe('Call @[Kim Lee] ^00000001')
    expect(await edit([{ action: 'replace', block: '^00000001', markdown: 'Call @[Kim Lee] now' }])).toContain(
      'are now plain text',
    )
  })

  it('shows a person whose name is unknown as plain @someone, which is not a mention', async () => {
    const ws = workspace([block(1, 'text', [['Call '], ['‣', [['u', person(99)]]]])])
    open(ws)
    expect(await read()).toBe('Call @someone ^00000001')
  })
})
