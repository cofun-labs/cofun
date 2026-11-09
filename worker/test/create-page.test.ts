// The create_page tool (extension/src/tools.ts) against a fake Notion workspace that applies
// transactions the way Notion does.
import { afterEach, describe, expect, it } from 'vitest'
import { createPage, readPage } from '../../extension/src/tools'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, restoreGlobals } from './notion-tab'

afterEach(restoreGlobals)

const hex = (s: string) => s.replace(/-/g, '')
const OTHER = '7c7c7c7c-0000-4000-8000-000000000001'
const intro = '7c7c7c7c-0000-4000-8000-000000000002'

function workspace() {
  return new FakeWorkspace(
    [
      {
        id: PAGE,
        type: 'page',
        properties: { title: [['Fixture page']] },
        content: [intro],
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
  it('[UC-NOTION-007-S01] creates a page with its content at the end of the open page', async () => {
    const ws = workspace()
    open(ws)
    const result = await create({
      title: 'Launch notes',
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

  it('[UC-NOTION-007-S03] refuses to create a page inside a database or a block', async () => {
    const ws = workspace()
    open(ws)
    await expect(create({ title: 'Row', parent: 'db0db0db000040008000000000000009' })).rejects.toThrow(
      "That is a database; create_page can't add rows to it.",
    )
    await expect(create({ title: 'x', parent: hex(intro) })).rejects.toThrow(
      'That id is a block inside a page, not a page.',
    )
    expect(ws.transactions).toEqual([])
  })
})

describe('create_page details', () => {
  it('needs the user’s OK and previews the page', () => {
    expect(createPage.needsConfirmation).toBe(true)
    expect(createPage.preview!({ title: 'Launch notes', markdown: '# Plan\n- Ship' })).toBe(
      ['Create the page “Launch notes” at the end of the open page, with:', '    # Plan', '    - Ship'].join('\n'),
    )
  })

  it('refuses an empty title and Markdown it can’t write, before asking Notion anything', async () => {
    const ws = workspace()
    const tab = open(ws)
    await expect(create({ title: '  ' })).rejects.toThrow('`title` must not be empty.')
    await expect(create({ title: 'T', markdown: '| a | b |' })).rejects.toThrow("Tables can't be written yet.")
    expect(tab.sent).toEqual([])
  })
})
