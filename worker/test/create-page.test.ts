// The create_page tool (extension/src/tools.ts) against a fake Notion workspace that applies
// transactions the way Notion does.
import { afterEach, describe, expect, it } from 'vitest'
import { createPage, forgetReads, readPage } from '../../extension/src/tools'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, restoreGlobals } from './notion-tab'

afterEach(() => {
  restoreGlobals()
  forgetReads()
})

const hex = (s: string) => s.replace(/-/g, '')
const OTHER = '7c7c7c7c-0000-4000-8000-000000000001'
const intro = '7c7c7c7c-0000-4000-8000-000000000002'

function workspace(more: Record<string, unknown>[] = []) {
  return new FakeWorkspace(
    [
      ...more,
      {
        id: PAGE,
        type: 'page',
        properties: { title: [['Fixture page']] },
        content: [intro, ...more.map((b) => b.id as string)],
        parent_id: SPACE,
        parent_table: 'space',
      },
      { id: intro, type: 'text', properties: { title: [['Intro']] }, parent_id: PAGE, parent_table: 'block' },
      {
        id: OTHER,
        type: 'page',
        properties: { title: [['Other page']] },
        content: [],
        parent_id: SPACE,
        parent_table: 'space',
      },
      {
        id: 'db0db0db-0000-4000-8000-000000000009',
        type: 'collection_view_page',
        parent_id: SPACE,
        parent_table: 'space',
      },
    ],
    SPACE,
  )
}
function open(ws: FakeWorkspace) {
  const tab = new FakeNotionTab(PAGE_URL)
  tab.workspace = ws
  return tab.install()
}
const create = async (args: Record<string, unknown>) => (await createPage.run(args)) as string

describe('UC-NOTION-007 create a page', () => {
  it('[UC-NOTION-007-S06] creates a page with its content at the end of the open page', async () => {
    const ws = workspace()
    open(ws)
    const result = await create({
      title: 'Launch notes',
      parent: PAGE_URL,
      markdown: '# Plan\n- Ship beta\n  - Fix Safari\n- [ ] Write post',
    })
    const created = /\^([0-9a-f]{32})/.exec(result)![1]
    expect(result).toBe(
      `Created the page “Launch notes” ^${created} at the end of ^${hex(PAGE)}.\nURL: https://app.notion.com/${created}`,
    )
    // It is the open page's last block, and reads back with its content.
    expect(ws.content(PAGE).map((b) => b.type)).toEqual(['text', 'page'])
    expect(ws.transactions).toHaveLength(1)
    const page = (await readPage.run({ page: created })) as string
    expect(page.split('\n')[0]).toBe(`Page: Launch notes ^${created}`)
    expect(page.slice(page.indexOf('\n\n') + 2).replace(/ \^[0-9a-f]+$/gm, '')).toBe(
      ['# Plan', '- Ship beta', '  - Fix Safari', '- [ ] Write post'].join('\n'),
    )
  })

  it('[UC-NOTION-007-S02] creates it in another page when asked', async () => {
    const ws = workspace()
    open(ws)
    await create({ title: 'Child', parent: `https://app.notion.com/${hex(OTHER)}` })
    expect(ws.content(OTHER).map((b) => b.properties)).toEqual([{ title: [['Child']] }])
    expect(ws.content(PAGE).map((b) => b.type)).toEqual(['text'])
  })

  it('[UC-NOTION-007-S05] refuses to create a page inside a piece of a page', async () => {
    const ws = workspace()
    open(ws)
    await expect(create({ title: 'x', parent: hex(intro) })).rejects.toThrow(
      'That id is a block inside a page, not a page or a database.',
    )
    expect(ws.transactions).toEqual([])
  })
})

describe('create_page details', () => {
  it('runs without asking, and previews the page', () => {
    expect(createPage.needsConfirmation).toBeUndefined()
    expect(createPage.preview!({ title: 'Launch notes', parent: PAGE_URL, markdown: '# Plan\n- Ship' })).toBe(
      [
        'Create a page',
        'Title: Launch notes',
        `In: ^${hex(PAGE)} (at its end if it is a page; as a new row if it is a database)`,
        'Content:',
        '    # Plan',
        '    - Ship',
      ].join('\n'),
    )
  })

  it('shows the new page in a long parent the agent read in parts just before', async () => {
    // Enough text for several parts.
    const long = Array.from({ length: 40 }, (_, n) => ({
      id: `7c7c7c7c-0000-4000-8000-0000000001${n.toString().padStart(2, '0')}`,
      type: 'text',
      properties: { title: [['x'.repeat(900)]] },
      parent_id: PAGE,
      parent_table: 'block',
    }))
    open(workspace(long))
    const first = (await readPage.run({ page: hex(PAGE) })) as string
    const parts = Number(/^Part 1 of (\d+)/m.exec(first)![1])
    expect(await readPage.run({ page: hex(PAGE), part: parts })).not.toContain('Fresh page')
    await create({ title: 'Fresh page', parent: hex(PAGE) })
    expect(await readPage.run({ page: hex(PAGE), part: parts })).toContain('Fresh page')
  })

  it('names the parent by its title in the preview once the agent has read it', async () => {
    open(workspace())
    await readPage.run({ page: hex(PAGE) })
    expect((await createPage.preview!({ title: 'T', parent: PAGE_URL }))?.split('\n')[2]).toBe(
      `At the end of: Fixture page ^${hex(PAGE)}`,
    )
  })

  it('keeps the title on one line, in the preview and in Notion', async () => {
    const ws = workspace()
    open(ws)
    const title = 'Notes”\n    at the end of the page “Other'
    // The title stays on its line; where the page goes is always the line after it.
    expect((await createPage.preview!({ title, parent: PAGE_URL }))?.split('\n').slice(1, 3)).toEqual([
      'Title: Notes” at the end of the page “Other',
      `In: ^${hex(PAGE)} (at its end if it is a page; as a new row if it is a database)`,
    ])
    await create({ title, parent: PAGE_URL })
    expect(ws.content(PAGE).at(-1)!.properties).toEqual({ title: [['Notes” at the end of the page “Other']] })
  })

  it('says to check the parent before retrying when Notion’s answer is lost', async () => {
    const ws = workspace()
    open(ws)
    ws.failAfterApply = true
    await expect(create({ title: 'Once', parent: PAGE_URL })).rejects.toThrow(
      `the page may or may not have been created. Read ^${hex(PAGE)} and check for “Once” before trying again.`,
    )
    // It was saved: the read the agent is pointed to shows it.
    expect(await readPage.run({ page: hex(PAGE) })).toContain('Once')
  })

  it('refuses an empty title and Markdown it can’t write, before asking Notion anything', async () => {
    const ws = workspace()
    const tab = open(ws)
    await expect(create({ title: '  ', parent: PAGE_URL })).rejects.toThrow('`title` must not be empty.')
    await expect(create({ title: 'T' })).rejects.toThrow('`parent` is required')
    await expect(create({ title: 'T', parent: PAGE_URL, markdown: '| a | b |' })).rejects.toThrow(
      "Tables can't be written yet.",
    )
    expect(tab.sent).toEqual([])
  })
})
