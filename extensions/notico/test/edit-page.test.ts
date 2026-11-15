// The edit_page tool (extensions/notico/src/tools/write.ts) against a fake Notion workspace that applies
// transactions the way Notion does, so each test checks the page as it is after the edit. Grouped by
// rule: edits only change what the AI read as it still is, never remove or rewrite what they can't
// write back, and write back what read_page shows as it was stored.
import { afterEach, describe, expect, it } from 'vitest'
import { inline, parseMarkdown } from '../src/notion/blocks'
import { mergeReads, type PageRead } from '../src/notion/edit'
import { splitSections } from '../src/notion/markdown'
import { forgetReads } from '../src/tools/memory'
import { readPage } from '../src/tools/read'
import { editPage } from '../src/tools/write'
import { LIMITED_STOP, UNEXPECTED_STOP } from '../src/notion/api'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, USER, notionError, restoreGlobals } from './notion-tab'

afterEach(restoreGlobals)

const id = (n: number) => `e0e0e0e0-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const hex = (s: string) => s.replace(/-/g, '')

type Rec = Record<string, unknown>

function block(n: number, type: string, text?: string, extra: Rec = {}, parent = PAGE): Rec {
  return {
    id: id(n),
    type,
    parent_id: parent,
    parent_table: 'block',
    ...(text === undefined ? {} : { properties: { title: [[text]] } }),
    ...extra,
  }
}

/** A workspace with the fixture page holding `top` (block numbers) and all of `blocks`. */
function workspace(top: number[], blocks: Rec[], pageId = PAGE): FakeWorkspace {
  const page = {
    id: pageId,
    type: 'page',
    properties: { title: [['Fixture page']] },
    content: top.map(id),
    parent_id: SPACE,
    parent_table: 'space',
  }
  return new FakeWorkspace([page, ...blocks], SPACE)
}

function open(ws: FakeWorkspace, url = PAGE_URL): FakeNotionTab {
  const tab = new FakeNotionTab(url)
  tab.workspace = ws
  return tab.install()
}

const read = async (args: Rec = {}) => (await readPage.run(args)) as string
const edit = async (edits: Rec[], args: Rec = {}) => (await editPage.run({ page: hex(PAGE), edits, ...args })) as string
const body = (result: string) => result.slice(result.indexOf('\n\n') + 2)
const withoutRefs = (text: string) => text.replace(/ \^[0-9a-f]{8,32}$/gm, '')

describe('UC-NOTICO-NOTION-002 edit a page', () => {
  it('[UC-NOTICO-NOTION-002-S09] inserts, replaces, and deletes in one edit, and changes nothing else', async () => {
    const ws = workspace(
      [1, 2, 3, 4],
      [
        block(1, 'text', 'Intro'),
        block(2, 'to_do', undefined, { properties: { title: [['Task']], checked: [['No']] } }),
        block(3, 'text', 'Old note'),
        block(4, 'bulleted_list', 'Keep me'),
      ],
    )
    open(ws)
    await read()

    const result = await edit([
      { action: 'insert', position: 'start', markdown: '## Summary\nShort summary' },
      { action: 'replace', block: '^00000002', markdown: '- [x] Task done' },
      { action: 'delete', block: '00000003' },
      { action: 'insert', block: '^00000001', markdown: '- New item\n  - Nested' },
    ])
    expect(result.split('\n').slice(0, 5)).toEqual([
      `On the page "Fixture page" ^${hex(PAGE)}:`,
      'Inserted 2 blocks at the start of the page.',
      'Replaced the text of ^00000002.',
      'Deleted ^00000003.',
      'Inserted 1 block after ^00000001.',
    ])
    // All of it in one transaction: Notion applies it whole or not at all.
    expect(ws.transactions).toHaveLength(1)

    const after = body(await read())
    expect(withoutRefs(after)).toBe(
      ['## Summary', 'Short summary', 'Intro', '- New item', '  - Nested', '- [x] Task done', '- Keep me'].join('\n'),
    )
    // Blocks that weren't replaced by new ones keep their identity.
    for (const ref of ['^00000001', '^00000002', '^00000004']) expect(after).toContain(ref)
    // A deleted block is removed the way Notion removes it, so page history can bring it back.
    expect(ws.records.get(id(3))).toMatchObject({ alive: false })
  })

  it('[UC-NOTICO-NOTION-002-S09] a round trip, replacing each block with what read_page showed, changes nothing', async () => {
    const ws = workspace(
      [1, 2, 3, 4, 5, 6],
      [
        block(1, 'header', 'Plan'),
        block(2, 'text', undefined, {
          properties: { title: [['Ship '], ['fast', [['b']]], [', see '], ['docs', [['a', 'https://example.com']]]] },
        }),
        block(3, 'to_do', undefined, { properties: { title: [['Done']], checked: [['Yes']] } }),
        block(4, 'numbered_list', 'One'),
        block(5, 'code', undefined, { properties: { title: [['let a = 1']], language: [['TypeScript']] } }),
        block(6, 'callout', 'Heads up', { format: { page_icon: '💡' } }),
      ],
    )
    open(ws)
    const before = body(await read())
    const lines = before.split('\n')
    const edits = [1, 2, 3, 4, 6].map((n) => {
      const ref = `^0000000${n}`
      return { action: 'replace', block: ref, markdown: lines.find((l) => l.endsWith(ref))! }
    })
    edits.push({ action: 'replace', block: '^00000005', markdown: '```typescript\nlet a = 1\n```' })
    await edit(edits)
    expect(body(await read())).toBe(before)
  })

  it('[UC-NOTICO-NOTION-002-S02] refuses to change a block the user changed after the AI read the page', async () => {
    const ws = workspace([1, 2], [block(1, 'text', 'Intro'), block(2, 'text', 'Draft')])
    open(ws)
    await read()
    ws.edit(id(2), { properties: { title: [['What the user just typed']] } })

    await expect(edit([{ action: 'replace', block: '^00000002', markdown: 'Rewritten' }])).rejects.toThrow(
      '^00000002 was changed since you read the page. Read the page again with read_page',
    )
    expect(ws.transactions).toEqual([])
    expect(ws.records.get(id(2))!.properties).toEqual({ title: [['What the user just typed']] })
  })

  it('[UC-NOTICO-NOTION-002-S02] refuses to insert after a block that was removed since the AI read the page', async () => {
    const ws = workspace([1, 2], [block(1, 'text', 'Intro'), block(2, 'text', 'Draft')])
    open(ws)
    await read()
    ws.edit(id(1), { alive: false })

    await expect(edit([{ action: 'insert', block: '^00000001', markdown: 'More' }])).rejects.toThrow(
      '^00000001 was deleted since you read the page.',
    )
    expect(ws.transactions).toEqual([])
  })

  it('[UC-NOTICO-NOTION-002-S19] makes none of an edit’s changes when one of them is refused', async () => {
    const ws = workspace([1, 2, 3], [block(1, 'text', 'Intro'), block(2, 'text', 'Draft'), block(3, 'text', 'Old')])
    open(ws)
    const before = body(await read())
    ws.edit(id(2), { properties: { title: [['What the user just typed']] } })

    // The first and last changes could be made; the middle one would overwrite the user's change.
    await expect(
      edit([
        { action: 'insert', position: 'start', markdown: '## Summary' },
        { action: 'replace', block: '^00000002', markdown: 'Rewritten' },
        { action: 'delete', block: '^00000003' },
      ]),
    ).rejects.toThrow('^00000002 was changed since you read the page.')
    expect(ws.transactions).toEqual([])
    expect(body(await read())).toBe(before.replace('Draft', 'What the user just typed'))
  })

  it('[UC-NOTICO-NOTION-002-S04] never replaces content it cannot write', async () => {
    const ws = workspace(
      [1, 2, 3, 4],
      [
        block(1, 'page', 'Child page'),
        block(2, 'collection_view', undefined, { collection_id: 'c0c0c0c0-0000-4000-8000-000000000001' }),
        block(3, 'image', undefined, { properties: { caption: [['Diagram']] } }),
        block(4, 'text', 'Text'),
      ],
    )
    open(ws)
    await read()

    await expect(edit([{ action: 'replace', block: hex(id(1)), markdown: 'Gone' }])).rejects.toThrow(
      "is a child page or database; edit_page can't change or delete it.",
    )
    await expect(edit([{ action: 'delete', block: hex(id(2)) }])).rejects.toThrow('is a child page or database')
    await expect(edit([{ action: 'replace', block: '^00000003', markdown: 'A caption' }])).rejects.toThrow(
      "^00000003 is content edit_page can't rewrite (image).",
    )
    // Writing back the line a placeholder showed as can't recreate it either.
    await expect(
      edit([{ action: 'replace', block: '^00000004', markdown: `📄 Child page ^${hex(id(1))}` }]),
    ).rejects.toThrow("stands for content edit_page can't create")
    expect(ws.transactions).toEqual([])
  })

  it('[UC-NOTICO-NOTION-002-S05] asks to read a page before editing it', async () => {
    const other = '7a7a7a7a-0000-4000-8000-000000000077'
    const ws = workspace([1], [block(1, 'text', 'Hi', {}, other)], other)
    open(ws, `https://app.notion.com/p/${hex(other)}`)
    await expect(edit([{ action: 'delete', block: '^00000001' }], { page: hex(other) })).rejects.toThrow(
      'Read the page with read_page first, then edit it',
    )
    expect(ws.transactions).toEqual([])
  })

  it('[UC-NOTICO-NOTION-002-S06] rewriting a block as the same kind keeps what is nested under it', async () => {
    const ws = workspace(
      [1],
      [block(1, 'toggle', 'Old title', { content: [id(2)] }), block(2, 'text', 'Inside', {}, id(1))],
    )
    open(ws)
    await read()
    // Turning it into another kind would drop what's nested, so that is refused.
    await expect(edit([{ action: 'replace', block: '^00000001', markdown: '- A bullet' }])).rejects.toThrow(
      '^00000001 has nested blocks.',
    )
    await edit([{ action: 'replace', block: '^00000001', markdown: '▸ New title' }])
    expect(body(await read())).toBe(['▸ New title ^00000001', '  Inside ^00000002'].join('\n'))
  })

  it('[UC-NOTICO-NOTION-002-S17] stops the question when Notion refuses the edit, and nothing changes', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    open(ws)
    await read()
    ws.reject = true
    const err = await notionError(edit([{ action: 'insert', position: 'end', markdown: 'More' }]))
    expect(err.stopsQuestion).toBe(`${UNEXPECTED_STOP} Notion returned an error (400 ValidationError): Invalid input.`)
    expect(withoutRefs(body(await read()))).toBe('Intro')
  })
})

describe('edits only change the page as the AI read it, and as it still is', () => {
  it('[UC-NOTICO-NOTION-002-S02] still refuses a block the user changed, after another edit took a fresh read', async () => {
    const ws = workspace([1, 2], [block(1, 'text', 'Intro'), block(2, 'text', 'Draft')])
    open(ws)
    await read()
    ws.edit(id(2), { properties: { title: [['What the user just typed']] } })
    // An edit elsewhere reads the page again, but the agent still hasn't seen the user's change.
    await edit([{ action: 'insert', position: 'end', markdown: 'More' }])
    await expect(edit([{ action: 'replace', block: '^00000002', markdown: 'Rewritten' }])).rejects.toThrow(
      '^00000002 was changed since you read the page.',
    )
    expect(ws.records.get(id(2))!.properties).toEqual({ title: [['What the user just typed']] })
  })

  it('[UC-NOTICO-NOTION-002-S05] refuses a block of a long page the agent has not read the part of', async () => {
    const n = 300
    const blocks = Array.from({ length: n }, (_, i) => block(i + 1, 'text', `P${i} ${'w'.repeat(60)}`))
    const ws = workspace(
      blocks.map((_, i) => i + 1),
      blocks,
    )
    open(ws)
    expect(await read()).toContain('Part 1 of 2')
    // The last block is only in part 2, which the agent never read.
    const last = `^${n.toString(16).padStart(8, '0')}`
    await expect(edit([{ action: 'delete', block: last }])).rejects.toThrow(
      'is not a block of the page as you last read it',
    )
    await read({ part: 2 })
    await edit([{ action: 'delete', block: last }])
    expect(ws.records.get(id(n))).toMatchObject({ alive: false })
  })

  it('[UC-NOTICO-NOTION-002-S05] refuses to delete a long block before every part of it was read', async () => {
    const n = 300
    const items = Array.from({ length: n }, (_, i) =>
      block(i + 2, 'bulleted_list', `Item ${i} ${'t'.repeat(60)}`, {}, id(1)),
    )
    const ws = workspace([1], [block(1, 'toggle', 'Big', { content: items.map((_, i) => id(i + 2)) }), ...items])
    open(ws)
    const parts = Number(/Part 1 of (\d+)/.exec(await read())![1])
    expect(parts).toBeGreaterThan(1)
    // Every part but the last read: some of the toggle's items are still unseen.
    for (let part = 2; part < parts; part++) await read({ part })
    await expect(edit([{ action: 'delete', block: '^00000001' }])).rejects.toThrow(
      "wasn't shown to you in full: read each part of the page it is in",
    )
    await read({ part: parts })
    await edit([{ action: 'delete', block: '^00000001' }])
    expect(ws.records.get(id(1))).toMatchObject({ alive: false })
  })

  it('[UC-NOTICO-NOTION-002-S05] refuses a block longer than a part until every part it is in was read', async () => {
    const ws = workspace([1, 2], [block(1, 'text', 'a'.repeat(15_000)), block(2, 'text', 'End')])
    open(ws)
    expect(await read()).toContain('Part 1 of 2')
    await expect(edit([{ action: 'replace', block: '^00000001', markdown: 'Short' }])).rejects.toThrow(
      "^00000001 wasn't shown to you in full",
    )
    await read({ part: 2 })
    await edit([{ action: 'replace', block: '^00000001', markdown: 'Short' }])
    expect(ws.records.get(id(1))!.properties).toEqual({ title: [['Short']] })
  })

  it('[@no-uc:data] reads a block Notion sent without a version, and refuses to edit it: a change to it could not be seen', async () => {
    for (const version of [undefined, '7', null]) {
      const ws = workspace(
        [1, 2],
        [block(1, 'text', 'Intro'), block(2, 'text', 'Draft', { version }), block(3, 'text', 'Inside', {}, id(2))],
      )
      ws.records.get(id(2))!.content = [id(3)]
      const tab = open(ws)
      expect(body(await read())).toContain('Draft ^00000002')
      const refusal =
        "^00000002 can't be edited: Notion sent it without a version, so it can't be checked for changes since you read the page."
      await expect(edit([{ action: 'replace', block: '^00000002', markdown: 'Rewritten' }])).rejects.toThrow(refusal)
      await expect(edit([{ action: 'delete', block: '^00000002' }])).rejects.toThrow(refusal)
      await expect(edit([{ action: 'insert', block: '^00000002', markdown: 'After' }])).rejects.toThrow(refusal)
      // The blocks around it, which have versions, can still be edited.
      await edit([{ action: 'replace', block: '^00000001', markdown: 'New intro' }])
      expect(ws.transactions).toHaveLength(1)
      expect(tab.sent.filter((r) => r.url.endsWith('/saveTransactionsFanout'))).toHaveLength(1)
    }
  })

  it('[UC-NOTICO-NOTION-002-S02] refuses to delete a block when something nested under it changed', async () => {
    const ws = workspace([1], [block(1, 'toggle', 'T', { content: [id(2)] }), block(2, 'text', 'Inside', {}, id(1))])
    open(ws)
    await read()
    ws.edit(id(2), { properties: { title: [['Typed inside']] } })
    await expect(edit([{ action: 'delete', block: '^00000001' }])).rejects.toThrow(
      '^00000002, nested under ^00000001, was changed since you read the page.',
    )
    expect(ws.transactions).toEqual([])
  })

  it('[UC-NOTICO-NOTION-002-S05] a new conversation must read the page again before editing it', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    open(ws)
    await read()
    forgetReads()
    await expect(edit([{ action: 'delete', block: '^00000001' }])).rejects.toThrow('Read the page with read_page first')
  })

  it('[UC-NOTICO-NOTION-002-S05] does not keep a read that ends after the conversation changed', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    open(ws)
    const reading = read()
    forgetReads()
    await reading
    await expect(edit([{ action: 'delete', block: '^00000001' }])).rejects.toThrow('Read the page with read_page first')
  })

  it('[@no-uc:data] asks for a new read before changing a block an edit changed', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    open(ws)
    await read()
    await edit([{ action: 'replace', block: '^00000001', markdown: 'Intro, edited' }])
    await expect(edit([{ action: 'replace', block: '^00000001', markdown: 'Again' }])).rejects.toThrow(
      'is not a block of the page as you last read it',
    )
    await read()
    await edit([{ action: 'replace', block: '^00000001', markdown: 'Again' }])
    expect(withoutRefs(body(await read()))).toBe('Again')
  })

  it('[@no-uc:data] does not count a block as seen because text or a code block on the page shows its reference', async () => {
    const n = 300
    const last = n.toString(16).padStart(8, '0')
    const filler = (i: number) => `P${i} ${'u'.repeat(60)}`
    // The first block, in part 1, shows the reference of the last one, which is only in part 2: in its
    // text, or in a code block holding the exact line the last block is drawn as.
    for (const first of [
      block(1, 'text', `See ^${last} for more`),
      block(1, 'code', undefined, {
        properties: { title: [[`${filler(n - 1)} ^${last}`]], language: [['Plain Text']] },
      }),
    ]) {
      const blocks = Array.from({ length: n }, (_, i) => block(i + 1, 'text', filler(i)))
      blocks[0] = first
      open(
        workspace(
          blocks.map((_, i) => i + 1),
          blocks,
        ),
      )
      expect(await read()).toContain(`^${last}`)
      await expect(edit([{ action: 'delete', block: `^${last}` }])).rejects.toThrow(
        'is not a block of the page as you last read it',
      )
    }
  })

  it('[@no-uc:data] says a block that was not loaded cannot be edited, without asking to read again', async () => {
    const ws = workspace([1, 9], [block(1, 'text', 'Intro')])
    open(ws)
    expect(body(await read())).toContain('[block not loaded] ^00000009')
    await expect(edit([{ action: 'delete', block: '^00000009' }])).rejects.toThrow(
      "^00000009 wasn't loaded, so it can't be edited.",
    )
  })

  it('[@no-uc:notion-safety] asks for a new read after an edit whose outcome is unknown, so a retry can’t apply it twice', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    open(ws)
    await read()
    ws.failAfterApply = true
    await expect(edit([{ action: 'insert', block: '^00000001', markdown: 'Once' }])).rejects.toThrow(
      'may or may not have been saved',
    )
    await expect(edit([{ action: 'insert', block: '^00000001', markdown: 'Once' }])).rejects.toThrow(
      'Read the page with read_page first',
    )
    // Reading shows the edit landed, once.
    expect(withoutRefs(body(await read()))).toBe(['Intro', 'Once'].join('\n'))
  })

  it('[@no-uc:data] sends nothing when the user stopped the question before the edit was sent', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    open(ws)
    await read()
    const stop = new AbortController()
    stop.abort()
    await expect(
      editPage.run({ page: hex(PAGE), edits: [{ action: 'insert', position: 'end', markdown: 'x' }] }, stop.signal),
    ).rejects.toThrow()
    expect(ws.transactions).toEqual([])
  })

  it('[@no-uc:data] refuses to insert at the end of a page that did not load in full', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    const tab = open(ws)
    // Notion reports more chunks than the client loads: the page is incomplete.
    await read()
    const loadPage = tab.workspace!.answer.bind(tab.workspace)
    tab.workspace!.answer = (endpoint, body) => {
      const res = loadPage(endpoint, body)
      if (endpoint === 'loadPageChunk' && res)
        (res.json as { cursor: unknown }).cursor = { stack: [[{ table: 'block', id: PAGE }]] }
      return res
    }
    await expect(edit([{ action: 'insert', position: 'end', markdown: 'x' }])).rejects.toThrow(
      "The page didn't load in full, so its end isn't known.",
    )
  })

  it('[@no-uc:data] inserts at the start of a page before blocks that were not loaded', async () => {
    const ws = workspace([9, 1], [block(1, 'text', 'Intro')])
    open(ws)
    await read()
    await edit([{ action: 'insert', position: 'start', markdown: 'First' }])
    const content = ws.records.get(PAGE)!.content as string[]
    expect(content.slice(1)).toEqual([id(9), id(1)])
  })
})

describe('what edit_page refuses to remove or rewrite', () => {
  it('[UC-NOTICO-NOTION-002-S04] refuses to delete a block with a child page nested under it', async () => {
    const ws = workspace([1], [block(1, 'toggle', 'T', { content: [id(2)] }), block(2, 'page', 'Child', {}, id(1))])
    open(ws)
    await read()
    await expect(edit([{ action: 'delete', block: '^00000001' }])).rejects.toThrow(
      "has a child page or database nested under it, so it can't be deleted.",
    )
  })

  it('[@no-uc:data] previews what a delete takes with it, and refuses edits inside a block it deletes', async () => {
    const ws = workspace(
      [1],
      [
        block(1, 'toggle', 'T', { content: [id(2), id(3)] }),
        block(2, 'text', 'A', {}, id(1)),
        block(3, 'text', 'B', {}, id(1)),
      ],
    )
    open(ws)
    await read()
    expect(editPage.preview!({ page: hex(PAGE), edits: [{ action: 'delete', block: '^00000001' }] })).toContain(
      'Delete ^00000001 “▸ T” and the 2 blocks nested under it',
    )
    for (const inside of [
      { action: 'replace', block: '^00000002', markdown: 'x' },
      { action: 'delete', block: '^00000002' },
    ]) {
      await expect(edit([{ action: 'delete', block: '^00000001' }, inside])).rejects.toThrow(
        '^00000002 is inside a block this call deletes.',
      )
    }
    expect(await edit([{ action: 'delete', block: '^00000001' }])).toContain('and the 2 blocks nested under it')
  })

  it('[@no-uc:data] refuses to edit a database page', async () => {
    const ws = new FakeWorkspace(
      [
        {
          id: PAGE,
          type: 'collection_view_page',
          collection_id: 'c0c0c0c0-0000-4000-8000-000000000001',
          parent_id: SPACE,
          parent_table: 'space',
        },
      ],
      SPACE,
    )
    open(ws)
    await read()
    await expect(edit([{ action: 'insert', position: 'end', markdown: 'x' }])).rejects.toThrow(
      "That is a database; edit_page can't change it.",
    )
    expect(ws.transactions).toEqual([])
  })

  it('[@no-uc:data] refuses to delete a block whose nested blocks did not load', async () => {
    const ws = workspace([1], [block(1, 'toggle', 'T', { content: [id(2), id(9)] }), block(2, 'text', 'A', {}, id(1))])
    // id(9) is named under the toggle but not in the workspace, as on a page that didn't load in full.
    open(ws)
    await read()
    await expect(edit([{ action: 'delete', block: '^00000001' }])).rejects.toThrow(
      "has nested blocks that weren't loaded, so it can't be deleted.",
    )
    expect(ws.transactions).toEqual([])
  })

  it('[@no-uc:data] refuses to replace a block as another kind when nested blocks did not load', async () => {
    const ws = workspace([1], [block(1, 'text', 'Parent', { content: [id(9)] })])
    open(ws)
    await read()
    await expect(edit([{ action: 'replace', block: '^00000001', markdown: '- Parent' }])).rejects.toThrow(
      '^00000001 has nested blocks.',
    )
    expect(ws.transactions).toEqual([])
  })

  it('[@no-uc:data] does not merge a quote’s nested blocks into its text when written back as shown', async () => {
    const ws = workspace([1], [block(1, 'quote', 'Quote', { content: [id(2)] }), block(2, 'text', 'Inside', {}, id(1))])
    open(ws)
    const shown = body(await read())
    expect(shown).toBe(['> Quote ^00000001', '>   Inside ^00000002'].join('\n'))
    // The whole quote with its nested line can't become one block, and the quote stays as it was.
    await expect(edit([{ action: 'replace', block: '^00000001', markdown: shown }])).rejects.toThrow(
      'has nested blocks',
    )
    expect(ws.records.get(id(1))!.properties).toEqual({ title: [['Quote']] })
  })

  it('[@no-uc:data] refuses to delete a synced block, or a block holding one', async () => {
    const ws = workspace(
      [1, 2],
      [
        block(1, 'transclusion_container', undefined, { content: [id(3)] }),
        block(3, 'text', 'Synced text', {}, id(1)),
        block(2, 'toggle', 'T', { content: [id(4)] }),
        block(4, 'transclusion_container', undefined, {}, id(2)),
      ],
    )
    open(ws)
    await read()
    await expect(edit([{ action: 'delete', block: '^00000001' }])).rejects.toThrow(
      'is a synced block shown on other pages too',
    )
    await expect(edit([{ action: 'delete', block: '^00000002' }])).rejects.toThrow('has a synced block nested under it')
    expect(ws.transactions).toEqual([])
  })

  it('[@no-uc:data] refuses to empty a column', async () => {
    const ws = workspace(
      [1],
      [
        block(1, 'column_list', undefined, { content: [id(2), id(3)] }),
        block(2, 'column', undefined, { content: [id(4)] }, id(1)),
        block(3, 'column', undefined, { content: [id(5)] }, id(1)),
        block(4, 'text', 'Left', {}, id(2)),
        block(5, 'text', 'Right', {}, id(3)),
      ],
    )
    open(ws)
    await read()
    await expect(edit([{ action: 'delete', block: '^00000004' }])).rejects.toThrow(
      "^00000004 is the last block in its column; edit_page can't remove columns.",
    )
    // Replacing it keeps the column filled.
    await edit([{ action: 'replace', block: '^00000004', markdown: '- Left, as a list' }])
    expect(withoutRefs(body(await read()))).toBe(['- Left, as a list', 'Right'].join('\n'))
  })

  it('[@no-uc:data] refuses lines nested under a code block, divider, or table', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    open(ws)
    await read()
    await expect(edit([{ action: 'insert', position: 'end', markdown: '```js\nx\n```\n  - hidden' }])).rejects.toThrow(
      "Lines can't be nested under a code block; un-indent them.",
    )
    await expect(edit([{ action: 'insert', position: 'end', markdown: '| a |\n| --- |\n  - hidden' }])).rejects.toThrow(
      "Lines can't be nested under a table; un-indent them.",
    )
    expect(ws.transactions).toEqual([])
  })

  it('[@no-uc:data] refuses a line drawn inside a callout when it is written on its own, instead of making it a quote', async () => {
    const ws = workspace(
      [1],
      [
        block(1, 'callout', 'Box', { content: [id(2)], format: { page_icon: '💡' } }),
        block(2, 'bulleted_list', 'Item', {}, id(1)),
      ],
    )
    open(ws)
    await read()
    await expect(edit([{ action: 'replace', block: '^00000002', markdown: '>   - Item changed' }])).rejects.toThrow(
      'leave out the `>` and the indentation after it',
    )
    await edit([{ action: 'replace', block: '^00000002', markdown: '- Item changed' }])
    expect(ws.records.get(id(2))).toMatchObject({ type: 'bulleted_list', properties: { title: [['Item changed']] } })
  })

  it('[@no-uc:data] rewrites a code block with a caption, keeping the caption', async () => {
    const ws = workspace(
      [1],
      [
        block(1, 'code', undefined, {
          properties: { title: [['a = 1']], language: [['Python']], caption: [['Example']] },
        }),
      ],
    )
    open(ws)
    const shown = body(await read())
    expect(shown).toBe(['```python', 'a = 1', '```', '[caption: Example] ^00000001'].join('\n'))
    // A new or changed caption can't be written; nothing is sent.
    await expect(
      edit([{ action: 'replace', block: '^00000001', markdown: shown.replace('Example', 'Other') }]),
    ).rejects.toThrow("^00000001: code block captions can't be changed yet.")
    await expect(
      edit([{ action: 'insert', position: 'end', markdown: '```js\nb\n```\n[caption: New]' }]),
    ).rejects.toThrow("Code block captions can't be written yet.")
    expect(ws.transactions).toEqual([])
    // The block copied back with its caption line, one line changed: the caption stays.
    await edit([{ action: 'replace', block: '^00000001', markdown: shown.replace('a = 1', 'a = 2') }])
    expect(ws.records.get(id(1))!.properties).toEqual({
      title: [['a = 2']],
      language: [['Python']],
      caption: [['Example']],
    })
    await read()
    await edit([{ action: 'replace', block: '^00000001', markdown: '```python\na = 3\n```' }])
    expect(ws.records.get(id(1))!.properties).toMatchObject({ title: [['a = 3']], caption: [['Example']] })
  })

  it('[@no-uc:data] refuses a color Notion doesn’t have, naming the ones it has, and writes nothing', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    open(ws)
    await read()
    for (const color of ['banana', 'default', 'Red', '#f00']) {
      await expect(
        edit([{ action: 'insert', position: 'end', markdown: `<span color="${color}">x</span>` }]),
      ).rejects.toThrow(`"${color}" isn't a Notion color. Use one of gray, brown, orange, yellow, green, blue`)
    }
    expect(ws.transactions).toEqual([])
  })
})

describe('round trips of what read_page shows', () => {
  const date = { type: 'datetime', start_date: '2026-11-12', start_time: '10:00', time_zone: 'Europe/Berlin' }
  const target = '3a3a3a3a-0000-4000-8000-000000000031'
  const callout = { format: { page_icon: '💡' } }
  const rich = (title: unknown[]) => ({ properties: { title } })
  /**
   * One block as Notion stores it, what read_page shows for it (references left out), a small change to
   * that, and what Notion stores after the change. `inexact` when what it shows is not exactly what is
   * stored, so a change to its text says so.
   */
  const ROUND_TRIPS: {
    what: string
    block: Rec
    shown: string
    change: [string, string]
    stored: unknown[]
    inexact?: true
  }[] = [
    {
      what: 'a list item with line breaks, as one block',
      block: block(1, 'bulleted_list', 'line one\nline two'),
      shown: '- line one<br>line two',
      change: ['two', 'two, edited'],
      stored: [['line one\nline two, edited']],
    },
    {
      what: 'a paragraph that looks like a numbered list',
      block: block(1, 'text', '1. not a list'),
      shown: '\\1. not a list',
      change: ['list', 'list at all'],
      stored: [['1. not a list at all']],
    },
    {
      what: 'a paragraph that looks like a heading',
      block: block(1, 'text', '# not a heading'),
      shown: '\\# not a heading',
      change: ['heading', 'heading either'],
      stored: [['# not a heading either']],
    },
    {
      what: 'a paragraph that starts with spaces',
      block: block(1, 'text', '  - not a list'),
      shown: '\\  - not a list',
      change: ['list', 'list either'],
      stored: [['  - not a list either']],
    },
    {
      what: 'a paragraph that starts like a placeholder line',
      block: block(1, 'text', '📄 Meeting notes'),
      shown: '\\📄 Meeting notes',
      change: ['Meeting', 'Weekly'],
      stored: [['📄 Weekly notes']],
    },
    {
      what: 'a quote whose text starts like a list',
      block: block(1, 'quote', '- not a list'),
      shown: '> \\- not a list',
      change: ['list', 'list at all'],
      stored: [['- not a list at all']],
    },
    {
      what: 'a callout whose text starts like a numbered list',
      block: block(1, 'callout', '2024. A good year', callout),
      shown: '> [!💡] \\2024. A good year',
      change: ['good', 'great'],
      stored: [['2024. A great year']],
    },
    {
      what: 'a multi-line callout, without adding spaces',
      block: block(1, 'callout', 'one\ntwo', callout),
      shown: '> [!💡] one\n> two',
      change: ['two', 'three'],
      stored: [['one\nthree']],
    },
    {
      what: 'literal <br> text, apart from line breaks',
      block: block(1, 'text', 'Use <br> for\nbreaks'),
      shown: 'Use \\<br> for<br>breaks',
      change: ['Use', 'Write'],
      stored: [['Write <br> for\nbreaks']],
    },
    {
      what: 'a line break after a backslash',
      block: block(1, 'text', 'a\\\nb'),
      shown: 'a\\\\<br>b',
      change: ['>b', '>c'],
      stored: [['a\\\nc']],
    },
    {
      what: 'literal Markdown characters, bold italic, and links to pages',
      block: block(
        1,
        'bulleted_list',
        undefined,
        rich([
          ['2*3 = 6, a_b, _x_, [ ] box, ~~no~~, x^deadbeef '],
          ['both', [['b'], ['i']]],
          [' see '],
          ['the spec', [['a', `/Spec-${hex(target)}#abc`]]],
        ]),
      ),
      shown: `- 2\\*3 = 6, a_b, \\_x\\_, \\[ \\] box, \\~\\~no\\~\\~, x\\^deadbeef ***both*** see [the spec](/${hex(target)}#abc)`,
      change: [' see ', ' read '],
      stored: [
        ['2*3 = 6, a_b, _x_, [ ] box, ~~no~~, x^deadbeef '],
        ['both', [['b'], ['i']]],
        [' read '],
        ['the spec', [['a', `/${hex(target)}#abc`]]],
      ],
      // The link is shown as /<id>, without the title Notion puts before it.
      inexact: true,
    },
    {
      what: 'inline code with backticks, spaces, or <br> in it',
      block: block(
        1,
        'text',
        undefined,
        rich([['Run '], ['a `b` c', [['c']]], [' or '], ['x<br>y', [['c']]], [' and '], ['`q', [['c']]]]),
      ),
      shown: 'Run ``a `b` c`` or `x<br>y` and `` `q ``',
      change: ['Run', 'Try'],
      stored: [['Try '], ['a `b` c', [['c']]], [' or '], ['x<br>y', [['c']]], [' and '], ['`q', [['c']]]],
    },
    {
      what: 'dollar signs and @dates that are only text',
      block: block(1, 'text', 'Pay $5 or $10 by @2026-01-01, $x$'),
      shown: 'Pay \\$5 or \\$10 by \\@2026-01-01, \\$x\\$',
      change: ['Pay', 'Send'],
      stored: [['Send $5 or $10 by @2026-01-01, $x$']],
    },
    {
      what: 'a dollar sign before inline code',
      block: block(1, 'text', undefined, rich([['cost $'], ['x', [['c']]], [' and $y']])),
      shown: 'cost \\$`x` and \\$y',
      change: ['cost', 'price'],
      stored: [['price $'], ['x', [['c']]], [' and $y']],
    },
    {
      what: 'colored text',
      block: block(
        1,
        'text',
        undefined,
        rich([['Plain '], ['red', [['h', 'red']]], [' and '], ['back', [['h', 'yellow_background'], ['i']]]]),
      ),
      shown: 'Plain <span color="red">red</span> and <span color="yellow_background">*back*</span>',
      change: ['Plain', 'Bare'],
      stored: [['Bare '], ['red', [['h', 'red']]], [' and '], ['back', [['h', 'yellow_background'], ['i']]]],
    },
    {
      what: '</span> inside colored text',
      block: block(1, 'text', undefined, rich([['a</span>b', [['h', 'red']]]])),
      shown: '<span color="red">a\\</span>b</span>',
      change: ['b</span>', 'b</span>!'],
      stored: [['a</span>b', [['h', 'red']]], ['!']],
    },
    {
      // A space a backslash escapes is one LaTeX keeps: it stays, and the equation still closes after it.
      what: 'inline equations whose LaTeX starts or ends with whitespace',
      block: block(
        1,
        'text',
        undefined,
        rich([['⁍', [['e', ' x^2']]], [' and '], ['⁍', [['e', 'y\n']]], [' and '], ['⁍', [['e', 'z\\ ']]]]),
      ),
      shown: '$x^2$ and $y$ and $z\\ $',
      change: [' and $y', ' plus $y'],
      stored: [['⁍', [['e', 'x^2']]], [' plus '], ['⁍', [['e', 'y']]], [' and '], ['⁍', [['e', 'z\\ ']]]],
      inexact: true,
    },
    {
      what: 'a date mention, with what it stores beyond what read_page shows',
      block: block(1, 'text', undefined, rich([['Meet '], ['‣', [['d', date]]]])),
      shown: 'Meet @2026-11-12 10:00',
      change: ['Meet ', 'Meet Ada '],
      stored: [['Meet Ada '], ['‣', [['d', date]]]],
    },
  ]

  it.each(ROUND_TRIPS)(
    '[@no-uc:data] round-trips $what',
    async ({ block: stored, shown, change: [from, to], stored: after, inexact }) => {
      const ws = workspace([1], [stored])
      open(ws)
      expect(withoutRefs(body(await read()))).toBe(shown)
      // Written back as shown, nothing is sent.
      await edit([{ action: 'replace', block: '^00000001', markdown: shown }])
      expect(ws.transactions).toEqual([])
      // A small change keeps the rest of the block as it was stored, and its kind.
      const result = await edit([{ action: 'replace', block: '^00000001', markdown: shown.replace(from, to) }])
      expect(result.includes("didn't show exactly")).toBe(inexact === true)
      expect(ws.records.get(id(1))).toMatchObject({ type: stored.type, properties: { title: after } })
    },
  )

  it('[@no-uc:data] keeps mentions and formatting it can’t write when the text is unchanged', async () => {
    const title = [
      ['Call '],
      ['‣', [['u', USER]]],
      [' by '],
      ['‣', [['d', { type: 'date', start_date: '2026-11-20' }]]],
      ['red', [['h', 'red']]],
    ]
    const ws = workspace([1], [block(1, 'to_do', undefined, { properties: { title, checked: [['No']] } })])
    open(ws)
    const line = body(await read()).replace(/ \^[0-9a-f]+$/, '')
    // Checking it off: the same text, so only the checkbox changes.
    const result = await edit([{ action: 'replace', block: '^00000001', markdown: line.replace('- [ ]', '- [x]') }])
    expect(result).not.toContain('plain text')
    expect(ws.records.get(id(1))!.properties).toEqual({ title, checked: [['Yes']] })
    // Changing the text says what was lost. The block changed, so it is read again first.
    await read()
    expect(await edit([{ action: 'replace', block: '^00000001', markdown: '- [x] Call later' }])).toContain(
      "people it can't name, and the like) is now as it was shown.",
    )
  })

  it('[@no-uc:data] previews multi-line quotes and code by their own text, and keeps an unchanged quote as it is', async () => {
    const quote = [['line one\nline '], ['two', [['h', 'red']]]]
    const ws = workspace(
      [1, 2],
      [
        block(1, 'quote', undefined, { properties: { title: quote } }),
        block(2, 'code', undefined, { properties: { title: [['print(1)']], language: [['Python']] } }),
      ],
    )
    open(ws)
    const shown = body(await read())
    expect(
      editPage.preview!({
        page: hex(PAGE),
        edits: [
          { action: 'delete', block: '^00000001' },
          { action: 'delete', block: '^00000002' },
        ],
      }),
    ).toContain(
      [
        'Delete ^00000001 “> line one ⏎ > line <span color="red">two</span>”',
        '',
        'Delete ^00000002 “```python ⏎ print(1) ⏎ ```”',
      ].join('\n'),
    )
    // Writing the quote back as shown changes nothing, so its color stays.
    const lines = shown.split('\n')
    await edit([{ action: 'replace', block: '^00000001', markdown: lines.slice(0, 2).join('\n') }])
    expect(ws.records.get(id(1))!.properties).toEqual({ title: quote })
  })

  it('[@no-uc:data] keeps inline equations equations when written back as read_page shows them', async () => {
    // A line break in LaTeX, a `<br>` in it, and a backtick in it before code that holds a `<br>`.
    const title = [
      ['⁍', [['e', 'a\nb']]],
      [' and '],
      ['⁍', [['e', 'c<br>d']]],
      [' then '],
      ['⁍', [['e', 'x`y']]],
      [' '],
      ['p<br>q', [['c']]],
      [' costs 5$\nand 6$'],
    ]
    const ws = workspace(
      [1, 2],
      [
        block(1, 'text', undefined, { properties: { title } }),
        block(2, 'quote', undefined, { properties: { title: [['⁍', [['e', 'a\nb']]], ['\nnext']] } }),
      ],
    )
    open(ws)
    const shown = body(await read())
    expect(withoutRefs(shown)).toBe(
      ['$a b$ and $c\\<br>d$ then $x`y$ `p<br>q` costs 5$<br>and 6\\$', '> $a b$', '> next'].join('\n'),
    )
    // Each block is edited elsewhere, so its text is written again.
    const [text, ...quote] = withoutRefs(shown).replace(' and ', ' plus ').replace('next', 'later').split('\n')
    await edit([
      { action: 'replace', block: '^00000001', markdown: text },
      { action: 'replace', block: '^00000002', markdown: quote.join('\n') },
    ])
    // The line break is a space, which LaTeX reads the same; everything else is as it was.
    expect(ws.records.get(id(1))!.properties).toEqual({
      title: [['⁍', [['e', 'a b']]], [' plus '], ...title.slice(2)],
    })
    expect(ws.records.get(id(2))!.properties).toEqual({ title: [['⁍', [['e', 'a b']]], ['\nlater']] })
  })

  it('[@no-uc:data] reads back a code block with a blank line nested in a callout, and keeps the callout when only its text changes', async () => {
    const ws = workspace(
      [1],
      [
        block(1, 'callout', undefined, {
          content: [id(2)],
          format: { page_icon: '💡' },
          properties: { title: [['Box', [['m', 'thread']]]] },
        }),
        block(2, 'code', undefined, { properties: { title: [['a  \n\nb']], language: [['JavaScript']] } }, id(1)),
      ],
    )
    open(ws)
    const shown = body(await read())
    expect(shown).toBe(
      ['> [!💡] Box ^00000001', '>   ```javascript', '>   a  ', '>   ', '>   b', '>   ```', '>   ^00000002'].join('\n'),
    )
    // The whole callout, copied, parses as it was read.
    expect(parseMarkdown(withoutRefs(shown))).toEqual([
      {
        type: 'callout',
        title: [['Box']],
        icon: '💡',
        children: [{ type: 'code', title: [['a  \n\nb']], language: 'javascript', children: [] }],
      },
    ])
    // Its own line written back as read changes nothing, so the comment on its text stays.
    await edit([{ action: 'replace', block: '^00000001', markdown: '> [!💡] Box' }])
    expect(ws.records.get(id(1))!.properties).toEqual({ title: [['Box', [['m', 'thread']]]] })
  })
})

describe('UC-NOTICO-NOTION-002 writing more of what read_page shows', () => {
  const ADA = '0f0f0f0f-0000-4000-8000-000000000004'

  it('[UC-NOTICO-NOTION-002-S14] writes tables, nested quotes and headings, colors, equations, people, and dates as read_page shows them', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    ws.put('notion_user', { id: ADA, name: 'Ada Lovelace' })
    open(ws)
    await read()
    const markdown = [
      '| Name | Due |',
      '| --- | --- |',
      '| Ship | @2026-11-20 |',
      '| Pay \\| tax | $x^2$ |',
      '> [!💡] Plan',
      '>   - First',
      '>     - Detail',
      '>   Then this',
      '## Details',
      '  Under the heading',
      'Ask @[Ada Lovelace] about <span color="red">**this**</span> by @2026-11-12 10:00 → 2026-11-13 10:00; it costs \\$5 for $E = mc^2$.',
    ].join('\n')
    await edit([{ action: 'insert', block: '^00000001', markdown }])
    // Read back, it is what the AI wrote, refs aside.
    const shown = body(await read())
    expect(
      withoutRefs(shown)
        .replace(/^\^[0-9a-f]+$/gm, '')
        .replace(/\n+/g, '\n'),
    ).toBe(`Intro\n${markdown}`)

    const records = [...ws.records.values()] as Rec[]
    const table = records.find((r) => r.type === 'table')!
    expect(table.format).toMatchObject({ table_block_column_header: true })
    const columns = (table.format as { table_block_column_order: string[] }).table_block_column_order
    const rows = (table.content as string[]).map((r) => ws.records.get(r)!.properties as Record<string, unknown>)
    expect(rows.map((r) => columns.map((c) => r[c]))).toEqual([
      [[['Name']], [['Due']]],
      [[['Ship']], [['‣', [['d', { type: 'date', start_date: '2026-11-20' }]]]]],
      [[['Pay | tax']], [['⁍', [['e', 'x^2']]]]],
    ])
    expect(records.find((r) => r.type === 'sub_header')!.format).toEqual({ toggleable: true })
    const text = records.find((r) => r.type === 'text' && r.id !== id(1) && r.parent_id === PAGE)!
    expect((text.properties as { title: unknown }).title).toEqual([
      ['Ask '],
      ['‣', [['u', ADA]]],
      [' about '],
      ['this', [['h', 'red'], ['b']]],
      [' by '],
      [
        '‣',
        [
          [
            'd',
            {
              type: 'datetimerange',
              start_date: '2026-11-12',
              start_time: '10:00',
              end_date: '2026-11-13',
              end_time: '10:00',
            },
          ],
        ],
      ],
      ['; it costs $5 for '],
      ['⁍', [['e', 'E = mc^2']]],
      ['.'],
    ])

    // Written back as shown, nothing changes.
    const sent = ws.transactions.length
    const lines = shown.split('\n')
    const own = (ref: string) => lines.find((l) => l.endsWith(` ${ref}`))!.replace(/^\s*/, '')
    const tableLines = lines.slice(
      lines.findIndex((l) => l.startsWith('| Name')),
      lines.findIndex((l) => l.startsWith('| Pay')) + 2,
    )
    const tableRef = tableLines.at(-1)!
    const refOf = (start: string) => / (\^[0-9a-f]+)$/.exec(lines.find((l) => l.startsWith(start))!)![1]
    const result = await edit([
      { action: 'replace', block: tableRef, markdown: tableLines.join('\n') },
      { action: 'replace', block: refOf('Ask'), markdown: own(refOf('Ask')) },
      { action: 'replace', block: refOf('> [!💡]'), markdown: own(refOf('> [!💡]')) },
    ])
    expect(result).toContain(`${tableRef} already had that content; nothing changed.`)
    expect(ws.transactions).toHaveLength(sent)
  })

  it('[UC-NOTICO-NOTION-002-S15] inserts content nested inside a block, before what it holds', async () => {
    const ws = workspace(
      [1, 2, 3, 4, 5],
      [
        block(1, 'toggle', 'Toggle', { content: [id(6)] }),
        block(6, 'text', 'Old child', {}, id(1)),
        block(2, 'callout', 'Box', { format: { page_icon: '💡' } }),
        block(3, 'code', undefined, { properties: { title: [['x']], language: [['Plain Text']] } }),
        block(4, 'header', 'Plain heading'),
        block(5, 'sub_header', 'Toggle heading', { format: { toggleable: true } }),
      ],
    )
    open(ws)
    await read()
    const result = await edit([
      { action: 'insert', block: '^00000001', position: 'inside', markdown: '- New first\n- New second' },
      { action: 'insert', block: '^00000002', position: 'inside', markdown: 'Inside the box' },
      { action: 'insert', block: '^00000005', position: 'inside', markdown: 'Under it' },
    ])
    expect(result).toContain('Inserted 2 blocks at the start of ^00000001, nested in it.')
    expect(withoutRefs(body(await read()))).toBe(
      [
        '▸ Toggle',
        '  - New first',
        '  - New second',
        '  Old child',
        '> [!💡] Box',
        '>   Inside the box',
        '```',
        'x',
        '```',
        '^00000003',
        '# Plain heading',
        '## Toggle heading',
        '  Under it',
      ].join('\n'),
    )
    // Blocks that show nothing nested in them can't take it.
    const sent = ws.transactions.length
    for (const ref of ['^00000003', '^00000004']) {
      await expect(edit([{ action: 'insert', block: ref, position: 'inside', markdown: 'x' }])).rejects.toThrow(
        `${ref} can't hold nested blocks`,
      )
    }
    expect(ws.transactions).toHaveLength(sent)
  })

  it('[UC-NOTICO-NOTION-002-S16] rewrites a table in place: a changed cell and a new row, the rest as it was', async () => {
    const ws = workspace(
      [1],
      [
        block(1, 'table', undefined, {
          content: [id(2), id(3)],
          format: { table_block_column_order: ['a', 'b'], table_block_column_header: true },
        }),
        // A comment on the cell's text: read_page can't show it, so it stays only if the cell does.
        block(2, 'table_row', undefined, { properties: { a: [['Key']], b: [['Value', [['m', 'thread']]]] } }, id(1)),
        block(3, 'table_row', undefined, { properties: { a: [['x']], b: [['1']] } }, id(1)),
      ],
    )
    open(ws)
    const shown = body(await read())
    expect(shown).toBe(['| Key | Value |', '| --- | --- |', '| x | 1 |', '^00000001'].join('\n'))
    const result = await edit([
      { action: 'replace', block: '^00000001', markdown: shown.replace('| x | 1 |', '| x | 2 |\n| y | 3 |') },
    ])
    expect(result).toContain('Rewrote the table ^00000001: 1 cell changed, 1 row added.')
    expect(ws.records.get(id(2))!.properties).toEqual({ a: [['Key']], b: [['Value', [['m', 'thread']]]] })
    expect(ws.records.get(id(3))!.properties).toEqual({ a: [['x']], b: [['2']] })
    expect(withoutRefs(body(await read()))).toBe(
      ['| Key | Value |', '| --- | --- |', '| x | 2 |', '| y | 3 |', '^00000001'].join('\n'),
    )
    expect(ws.records.get(id(1))!.format).toEqual({
      table_block_column_order: ['a', 'b'],
      table_block_column_header: true,
    })
  })
})

describe('warnings about what read_page doesn’t show exactly', () => {
  it('[@no-uc:data] says when a replacement as another kind turns mentions into plain text', async () => {
    const ws = workspace(
      [1],
      [block(1, 'text', undefined, { properties: { title: [['Call '], ['‣', [['u', USER]]]] } })],
    )
    open(ws)
    await read()
    expect(await edit([{ action: 'replace', block: '^00000001', markdown: '- [ ] Call @Fixture User' }])).toContain(
      "people it can't name, and the like) is now as it was shown.",
    )
  })

  it('[@no-uc:data] warns in the preview that rewriting a block with mentions makes them plain text', async () => {
    const ws = workspace(
      [1],
      [block(1, 'text', undefined, { properties: { title: [['Ask '], ['‣', [['u', USER]]]] } })],
    )
    open(ws)
    await read()
    expect(
      editPage.preview!({ page: hex(PAGE), edits: [{ action: 'replace', block: '^00000001', markdown: 'Ask them' }] }),
    ).toContain("If its text changes, what read_page didn't show exactly, such as comments on it, is lost.")
  })

  it('[@no-uc:data] says so when text read_page showed doesn’t parse back to what is stored', async () => {
    // A date mention followed by a time written as text reads back as a date with a time.
    const title = [['‣', [['d', { type: 'date', start_date: '2026-11-12' }]]], [' 10:00 meeting']]
    const ws = workspace([1], [block(1, 'text', undefined, { properties: { title } })])
    open(ws)
    const shown = body(await read())
    expect(shown).toBe('@2026-11-12 10:00 meeting ^00000001')
    const edits = [{ action: 'replace', block: '^00000001', markdown: '@2026-11-12 10:00 call' }]
    expect(editPage.preview!({ page: hex(PAGE), edits })).toContain("what read_page didn't show exactly")
    expect(await edit(edits)).toContain("In its old text, what read_page didn't show exactly")
  })
})

describe('tables written by edit_page', () => {
  const table = (cell: unknown) => [
    block(1, 'table', undefined, { content: [id(2), id(3)], format: { table_block_column_order: ['a'] } }),
    block(2, 'table_row', undefined, { properties: { a: [['Head']] } }, id(1)),
    block(3, 'table_row', undefined, { properties: { a: cell } }, id(1)),
  ]

  it('[@no-uc:data] deletes a table with its rows', async () => {
    const ws = workspace(
      [1, 2],
      [
        block(1, 'table', undefined, { content: [id(3)], format: { table_block_column_order: ['c'] } }),
        block(3, 'table_row', undefined, { properties: { c: [['cell']] } }, id(1)),
        block(2, 'text', 'After'),
      ],
    )
    open(ws)
    await read()
    await edit([{ action: 'delete', block: '^00000001' }])
    expect(withoutRefs(body(await read()))).toBe('After')
  })

  it('[@no-uc:data] keeps pipes in table cells escaped, code and equations included', async () => {
    const ws = workspace(
      [1],
      [
        block(1, 'table', undefined, { content: [id(2), id(3)], format: { table_block_column_order: ['a', 'b'] } }),
        block(2, 'table_row', undefined, { properties: { a: [['A']], b: [['B']] } }, id(1)),
        block(3, 'table_row', undefined, { properties: { a: [['a|b', [['c']]]], b: [['‣', [['e', '|x|']]]] } }, id(1)),
      ],
    )
    open(ws)
    expect(body(await read()).split('\n')[2]).toBe('| `a\\|b` | $\\|x\\|$ |')
  })

  it('[@no-uc:data] writes an equation in a page table’s cell back as read_page shows it, its line break a space', async () => {
    const ws = workspace(
      [1],
      [
        block(1, 'table', undefined, { content: [id(2), id(3)], format: { table_block_column_order: ['a'] } }),
        block(2, 'table_row', undefined, { properties: { a: [['A']] } }, id(1)),
        block(3, 'table_row', undefined, { properties: { a: [['x '], ['⁍', [['e', 'a\nb']]]] } }, id(1)),
      ],
    )
    open(ws)
    const shown = withoutRefs(body(await read()))
    expect(shown.split('\n')[2]).toBe('| x $a b$ |')
    // The cell is edited elsewhere, so its text is written again.
    const markdown = shown.replace(/\n\^[0-9a-f]+$/, '').replace('| x ', '| y ')
    await edit([{ action: 'replace', block: '^00000001', markdown }])
    const table = [...ws.records.values()].find((r) => (r as Rec).type === 'table') as Rec
    const rows = (table.content as string[]).map((r) => ws.records.get(r)!.properties)
    expect(rows).toEqual([{ a: [['A']] }, { a: [['y '], ['⁍', [['e', 'a b']]]] }])
  })

  it('[@no-uc:data] removes rows and columns at the end, and adds columns', async () => {
    const ws = workspace(
      [1],
      [
        block(1, 'table', undefined, { content: [id(2), id(3)], format: { table_block_column_order: ['a', 'b'] } }),
        block(2, 'table_row', undefined, { properties: { a: [['A']], b: [['B']] } }, id(1)),
        block(3, 'table_row', undefined, { properties: { a: [['1']], b: [['2']] } }, id(1)),
      ],
    )
    open(ws)
    await read()
    expect(await edit([{ action: 'replace', block: '^00000001', markdown: '| A |\n| --- |' }])).toContain(
      '1 row removed, 1 column removed',
    )
    expect(ws.records.get(id(3))).toMatchObject({ alive: false })
    expect(withoutRefs(body(await read()))).toBe(['| A |', '| --- |', '^00000001'].join('\n'))
    await edit([{ action: 'replace', block: '^00000001', markdown: '| A | B | C |\n| --- | --- | --- |' }])
    const order = (ws.records.get(id(1))!.format as { table_block_column_order: string[] }).table_block_column_order
    expect(order.slice(0, 1)).toEqual(['a'])
    expect(order).toHaveLength(3)
    expect(withoutRefs(body(await read()))).toBe(['| A | B | C |', '| --- | --- | --- |', '^00000001'].join('\n'))
  })

  it('[@no-uc:data] replaces a table with other content, its rows going with it', async () => {
    const ws = workspace(
      [1],
      [
        block(1, 'table', undefined, { content: [id(2)], format: { table_block_column_order: ['a'] } }),
        block(2, 'table_row', undefined, { properties: { a: [['A']] } }, id(1)),
      ],
    )
    open(ws)
    await read()
    await edit([{ action: 'replace', block: '^00000001', markdown: '- A' }])
    expect(withoutRefs(body(await read()))).toBe('- A')
    expect(ws.records.get(id(1))).toMatchObject({ alive: false })
  })

  it('[@no-uc:data] removes a row or column from the middle of a table without moving the others', async () => {
    const ws = workspace(
      [1],
      [
        block(1, 'table', undefined, {
          content: [id(2), id(3), id(4)],
          format: { table_block_column_order: ['a', 'b', 'c'] },
        }),
        block(2, 'table_row', undefined, { properties: { a: [['Name']], b: [['Note']], c: [['Due']] } }, id(1)),
        block(
          3,
          'table_row',
          undefined,
          { properties: { a: [['Ship']], b: [['Soon', [['m', 'thread']]]], c: [['Fri']] } },
          id(1),
        ),
        block(4, 'table_row', undefined, { properties: { a: [['Test']], b: [['Later']], c: [['Mon']] } }, id(1)),
      ],
    )
    open(ws)
    await read()
    const result = await edit([
      { action: 'replace', block: '^00000001', markdown: '| Name | Due |\n| --- | --- |\n| Test | Mon |' },
    ])
    expect(result).toContain('Rewrote the table ^00000001: 1 row removed, 1 column removed.')
    expect(result).toContain('Rows it removed held formatting')
    expect(ws.records.get(id(3))).toMatchObject({ alive: false })
    expect(ws.records.get(id(4))!.properties).toEqual({ a: [['Test']], b: [['Later']], c: [['Mon']] })
    expect(ws.records.get(id(1))!.format).toEqual({ table_block_column_order: ['a', 'c'] })
    expect(withoutRefs(body(await read()))).toBe(
      ['| Name | Due |', '| --- | --- |', '| Test | Mon |', '^00000001'].join('\n'),
    )
  })

  it('[@no-uc:data] adds a row in the middle of a table where it was written', async () => {
    const ws = workspace(
      [1],
      [
        block(1, 'table', undefined, { content: [id(2), id(3)], format: { table_block_column_order: ['a'] } }),
        block(2, 'table_row', undefined, { properties: { a: [['First']] } }, id(1)),
        block(3, 'table_row', undefined, { properties: { a: [['Last']] } }, id(1)),
      ],
    )
    open(ws)
    await read()
    await edit([{ action: 'replace', block: '^00000001', markdown: '| First |\n| --- |\n| Middle |\n| Last |' }])
    expect(ws.records.get(id(3))!.properties).toEqual({ a: [['Last']] })
    expect(withoutRefs(body(await read()))).toBe(
      ['| First |', '| --- |', '| Middle |', '| Last |', '^00000001'].join('\n'),
    )
  })

  it('[@no-uc:data] keeps a backslash in a link in a table cell when the table is rewritten', async () => {
    const href = 'https://example.com/a\\b|c'
    const ws = workspace(
      [1],
      [
        block(1, 'table', undefined, { content: [id(2), id(3)], format: { table_block_column_order: ['a', 'b'] } }),
        block(2, 'table_row', undefined, { properties: { a: [['Link']], b: [['N']] } }, id(1)),
        block(3, 'table_row', undefined, { properties: { a: [['docs', [['a', href]]]], b: [['1']] } }, id(1)),
      ],
    )
    open(ws)
    const shown = body(await read())
    await edit([{ action: 'replace', block: '^00000001', markdown: shown.replace('| 1 |', '| 2 |') }])
    expect(ws.records.get(id(3))!.properties).toEqual({ a: [['docs', [['a', href]]]], b: [['2']] })
    expect(parseMarkdown(withoutRefs(shown).replace(/\n\^\w+$/, ''))[0].rows![1][0]).toEqual([['docs', [['a', href]]]])
  })

  it('[UC-NOTICO-NOTION-002-S16] rewrites a table whose unchanged cell mentions a guest, without looking them up by name', async () => {
    const GUEST = '0f0f0f0f-0000-4000-8000-000000000005'
    const ws = workspace(
      [1],
      [
        block(1, 'table', undefined, { content: [id(2), id(3)], format: { table_block_column_order: ['a', 'b'] } }),
        block(2, 'table_row', undefined, { properties: { a: [['Who']], b: [['N']] } }, id(1)),
        block(3, 'table_row', undefined, { properties: { a: [['‣', [['u', GUEST]]]], b: [['1']] } }, id(1)),
      ],
    )
    ws.put('notion_user', { id: GUEST, name: 'Grace Guest' })
    // The guest isn't a member of the workspace, so a lookup by name wouldn't find them.
    ws.visibleUsers = [USER]
    open(ws)
    const shown = body(await read())
    expect(shown).toContain('| @[Grace Guest] | 1 |')
    await edit([{ action: 'replace', block: '^00000001', markdown: shown.replace('| 1 |', '| 2 |') }])
    expect(ws.records.get(id(3))!.properties).toEqual({ a: [['‣', [['u', GUEST]]]], b: [['2']] })
  })

  it('[@no-uc:data] says so when a table replaced by other content had cells read_page can’t show exactly', async () => {
    // A comment on a cell's text, and a bold equation.
    for (const cell of [[['A', [['m', 'thread']]]], [['⁍', [['e', 'x'], ['b']]]]]) {
      open(workspace([1], table(cell)))
      await read()
      expect(await edit([{ action: 'replace', block: '^00000001', markdown: '- x' }])).toContain(
        "In its old cells, what read_page didn't show exactly",
      )
    }
  })

  it('[@no-uc:data] says so when a changed cell held text read_page showed in a way that doesn’t parse back', async () => {
    const date = [['‣', [['d', { type: 'date', start_date: '2026-11-12' }]]], [' 10:00 meeting']]
    const ws = workspace([1], table(date))
    open(ws)
    const shown = body(await read())
    expect(shown).toContain('| @2026-11-12 10:00 meeting |')
    expect(
      await edit([{ action: 'replace', block: '^00000001', markdown: shown.replace('meeting', 'call') }]),
    ).toContain("In the cells it changed, what read_page didn't show exactly")
  })

  it('[@no-uc:data] does not warn when a table’s cells all read back as stored', async () => {
    const ws = workspace([1], table([['Plain '], ['bold', [['b']]]]))
    open(ws)
    const shown = body(await read())
    const result = await edit([{ action: 'replace', block: '^00000001', markdown: shown.replace('Plain', 'Bare') }])
    expect(result).toContain('1 cell changed')
    expect(result).not.toContain("didn't show exactly")
  })

  const ws3 = () =>
    workspace(
      [1],
      [
        block(1, 'table', undefined, {
          content: [id(2), id(3)],
          format: { table_block_column_order: ['a', 'b', 'c'] },
        }),
        block(2, 'table_row', undefined, { properties: { a: [['A']], b: [['B']], c: [['C']] } }, id(1)),
        block(
          3,
          'table_row',
          undefined,
          { properties: { a: [['1', [['m', 'thread']]]], b: [['2']], c: [['3']] } },
          id(1),
        ),
      ],
    )

  it('[@no-uc:data] moves a column with its cells, comments and all, when the columns are reordered', async () => {
    const ws = ws3()
    open(ws)
    await read()
    const result = await edit([
      { action: 'replace', block: '^00000001', markdown: '| B | C | A |\n| --- | --- | --- |\n| 2 | 3 | 1 |' },
    ])
    expect(result).toBe(
      [
        `On the page "Fixture page" ^${hex(PAGE)}:`,
        'Rewrote the table ^00000001: columns moved.',
        'Read the page again to see the result.',
      ].join('\n'),
    )
    expect(ws.records.get(id(1))!.format).toEqual({ table_block_column_order: ['b', 'c', 'a'] })
    expect(ws.records.get(id(3))!.properties).toEqual({ a: [['1', [['m', 'thread']]]], b: [['2']], c: [['3']] })
  })

  it('[@no-uc:data] says so when a column it removes held formatting read_page doesn’t show', async () => {
    const ws = ws3()
    open(ws)
    await read()
    const result = await edit([
      { action: 'replace', block: '^00000001', markdown: '| B | C |\n| --- | --- |\n| 2 | 3 |' },
    ])
    expect(result).toContain('1 column removed')
    expect(result).toContain("Columns it removed held formatting read_page doesn't show")
  })

  it('[@no-uc:data] warns on the card when a table it replaces has cells read_page can’t show exactly', async () => {
    const ws = ws3()
    open(ws)
    await read()
    expect(
      editPage.preview!({ page: hex(PAGE), edits: [{ action: 'replace', block: '^00000001', markdown: '- x' }] }),
    ).toContain("what read_page didn't show exactly")
  })
})

describe('edit_page details', () => {
  it('[@no-uc:data] runs without asking, and previews each change with the text it replaces', async () => {
    expect(editPage.needsConfirmation).toBeUndefined()
    const ws = workspace([1, 2], [block(1, 'text', 'Intro'), block(2, 'text', 'Old note')])
    open(ws)
    await read()
    expect(
      editPage.preview!({
        page: hex(PAGE),
        edits: [
          { action: 'insert', block: '^00000001', markdown: '- New item' },
          { action: 'replace', block: '^00000002', markdown: 'New note' },
          { action: 'delete', block: '^00000002' },
          { action: 'insert', position: 'start', markdown: '# Top' },
        ],
      }),
    ).toBe(
      [
        'On the page “Fixture page”:',
        '',
        'Insert after ^00000001 “Intro”:',
        '    - New item',
        '',
        'Replace ^00000002 “Old note” with:',
        '    New note',
        '',
        'Delete ^00000002 “Old note”',
        '',
        'Insert at the start of the page:',
        '    # Top',
        '',
        "What it replaced or deleted can be brought back from the page's history in Notion.",
      ].join('\n'),
    )
  })

  it('[UC-NOTICO-NOTION-002-S13] says the edit was saved, and stops the question, when Notion turns the read-back away', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    const tab = open(ws)
    await read()
    // The edit checks the page, saves, and then reads it back: that last read is turned away.
    tab.respond('loadPageChunk', 200, ws.answer('loadPageChunk', { page: { id: PAGE } })!.json)
    tab.limit('loadPageChunk', 1)
    const err = await notionError(edit([{ action: 'insert', position: 'end', markdown: 'Second' }]))
    // Marked as having changed the page, so the user is told to check before asking again.
    expect([err.stopsQuestion, err.mayHaveChanged]).toEqual([`The edit was saved. ${LIMITED_STOP}`, true])
    expect(err.message.split('\n')[0]).toBe(
      'The edit was saved. Reading the page back afterwards was refused, so read it again before changing it.',
    )
    expect(ws.transactions).toHaveLength(1)
  })

  it('[@no-uc:data] keeps editing possible after an edit, with the new blocks’ references', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    open(ws)
    await read()
    const result = await edit([{ action: 'insert', position: 'end', markdown: 'Second' }])
    const newRef = /New blocks: \^([0-9a-f]+)\./.exec(result)![1]
    // No read in between: the edit took a fresh read of the page.
    await edit([{ action: 'replace', block: newRef, markdown: 'Second, rewritten' }])
    expect(withoutRefs(body(await read()))).toBe(['Intro', 'Second, rewritten'].join('\n'))
  })

  it('[@no-uc:data] appends in order and inserts several edits after the same block in order', async () => {
    const ws = workspace([1], [block(1, 'text', 'A')])
    open(ws)
    await read()
    await edit([
      { action: 'insert', block: '^00000001', markdown: 'B' },
      { action: 'insert', block: '^00000001', markdown: 'C' },
      { action: 'insert', position: 'end', markdown: 'D\nE' },
    ])
    expect(withoutRefs(body(await read()))).toBe(['A', 'B', 'C', 'D', 'E'].join('\n'))
  })

  it('[@no-uc:data] lets the agent edit a nested block it just inserted, without reading again', async () => {
    const ws = workspace([1], [block(1, 'text', 'A')])
    open(ws)
    await read()
    const result = (await edit([{ action: 'insert', block: '^00000001', markdown: '- parent\n  - child' }])) as string
    // The child's reference, as the next read would show it.
    const parentRef = /New blocks: \^([0-9a-f]+)\./.exec(result)![1]
    const parent = ws.content(PAGE).find((b) => b.id.replace(/-/g, '').endsWith(parentRef))!
    const child = ws.content(parent.id)[0]
    await edit([{ action: 'replace', block: `^${child.id.replace(/-/g, '').slice(-8)}`, markdown: '- child, edited' }])
    expect(withoutRefs(body(await read()))).toBe(['A', '- parent', '  - child, edited'].join('\n'))
  })

  it('[@no-uc:data] replaces a block with several blocks, or with another kind, in its place', async () => {
    const ws = workspace([1, 2, 3], [block(1, 'text', 'A'), block(2, 'text', 'notes'), block(3, 'text', 'Z')])
    open(ws)
    await read()
    await edit([{ action: 'replace', block: '^00000002', markdown: '- [ ] one\n- [ ] two' }])
    expect(withoutRefs(body(await read()))).toBe(['A', '- [ ] one', '- [ ] two', 'Z'].join('\n'))
  })

  it('[@no-uc:data] refuses unclear edits before asking Notion anything', async () => {
    const ws = workspace([1, 2], [block(1, 'text', 'A'), block(2, 'text', 'B')])
    const tab = open(ws)
    await read()
    const sent = tab.sent.length
    const refused = [
      [[{ action: 'move', block: '^00000001' }], '`action` must be "insert", "replace", or "delete".'],
      [[{ action: 'delete', block: '^deadbeef' }], '^deadbeef is not a block of the page as you last read it.'],
      [[{ action: 'replace', block: '^00000001' }], 'Edit 1 needs `markdown`.'],
      [
        [
          { action: 'delete', block: '^00000001' },
          { action: 'replace', block: '^00000001', markdown: 'x' },
        ],
        '^00000001 is changed by another edit too.',
      ],
      [
        [
          { action: 'delete', block: '^00000001' },
          { action: 'insert', block: '^00000001', markdown: 'x' },
        ],
        'so nothing can be inserted after or inside it in the same call.',
      ],
      [
        [{ action: 'insert', markdown: '| a |\n| --- |\n| b | c |' }],
        'A table row has more cells than the header row.',
      ],
      [[{ action: 'insert', markdown: '```\nunclosed' }], 'A code block is missing its closing fence.'],
    ] as const
    for (const [edits, message] of refused) {
      await expect(editPage.run({ page: hex(PAGE), edits: edits as unknown as Rec[] })).rejects.toThrow(message)
    }
    // Only the read went to Notion.
    expect(tab.sent).toHaveLength(sent)
    expect(ws.transactions).toEqual([])
  })

  it('[@no-uc:data] inserts at the start after deleting the first block in the same call', async () => {
    const ws = workspace([1, 2], [block(1, 'text', 'First'), block(2, 'text', 'Second')])
    open(ws)
    await read()
    await edit([
      { action: 'delete', block: '^00000001' },
      { action: 'insert', position: 'start', markdown: 'New first' },
    ])
    expect(withoutRefs(body(await read()))).toBe(['New first', 'Second'].join('\n'))
  })

  it('[@no-uc:data] keeps a code block’s language when a rewrite gives none', async () => {
    const ws = workspace([1], [block(1, 'code', undefined, { properties: { title: [['a()']], language: [['Rust']] } })])
    open(ws)
    await read()
    await edit([{ action: 'replace', block: '^00000001', markdown: '```\nb()\n```' }])
    expect(ws.records.get(id(1))!.properties).toEqual({ title: [['b()']], language: [['Rust']] })
  })

  it('[@no-uc:data] writes links that look like placeholders, nested lists, and code languages as Notion names them', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    open(ws)
    await read()
    await edit([
      {
        action: 'insert',
        block: '^00000001',
        markdown: '[file a bug](https://example.com/bugs)\n- a\n  - b\n```typescript\nx()\n```',
      },
    ])
    // The code block's reference is on its own line after the fence.
    expect(withoutRefs(body(await read())).replace(/\n\^[0-9a-f]+$/, '')).toBe(
      ['Intro', '[file a bug](https://example.com/bugs)', '- a', '  - b', '```typescript', 'x()', '```'].join('\n'),
    )
    const code = [...ws.records.values()].find((r) => r.type === 'code')!
    expect(code.properties).toEqual({ title: [['x()']], language: [['TypeScript']] })
  })

  it('[@no-uc:data] edits a to-do inside a callout', async () => {
    const ws = workspace(
      [1],
      [
        block(1, 'callout', 'Box', { content: [id(2)], format: { page_icon: '💡' } }),
        block(2, 'to_do', undefined, { properties: { title: [['Inside']], checked: [['No']] } }, id(1)),
      ],
    )
    open(ws)
    expect(body(await read())).toBe(['> [!💡] Box ^00000001', '>   - [ ] Inside ^00000002'].join('\n'))
    await edit([{ action: 'replace', block: '^00000002', markdown: '- [x] Inside' }])
    expect(ws.records.get(id(2))!.properties).toEqual({ title: [['Inside']], checked: [['Yes']] })
  })

  it('[@no-uc:data] keeps the order when the first block is replaced and something is inserted at the start', async () => {
    const ws = workspace([1, 2], [block(1, 'text', 'Old first'), block(2, 'text', 'Second')])
    open(ws)
    await read()
    await edit([
      { action: 'replace', block: '^00000001', markdown: '- New first' },
      { action: 'insert', position: 'start', markdown: 'Top' },
    ])
    expect(withoutRefs(body(await read()))).toBe(['Top', '- New first', 'Second'].join('\n'))
  })

  it('[@no-uc:data] inserts after the block when no position is given', async () => {
    const ws = workspace([1, 2], [block(1, 'text', 'A'), block(2, 'text', 'C')])
    open(ws)
    await read()
    await edit([{ action: 'insert', block: '^00000001', markdown: 'B' }])
    expect(withoutRefs(body(await read()))).toBe(['A', 'B', 'C'].join('\n'))
  })

  it('[@no-uc:data] refuses arguments that are not what its schema says, before the page is read or Notion asked', async () => {
    const tab = open(workspace([1], [block(1, 'text', 'A')]))
    const run = (args: Rec) => editPage.run(args)
    const insert = { action: 'insert', markdown: 'x' }
    const refused: [Rec, string][] = [
      [{ edits: [insert] }, 'Give `page`: the id read_page shows after "Page:".'],
      [{ page: 5, edits: [insert] }, 'Give `page`'],
      [{ page: hex(PAGE) }, '`edits` must be a list with at least one edit.'],
      [{ page: hex(PAGE), edits: insert }, '`edits` must be a list with at least one edit.'],
      [{ page: hex(PAGE), edits: [] }, '`edits` must be a list with at least one edit.'],
      [
        { page: hex(PAGE), edits: [insert, { block: '^1' }] },
        'Edit 2: `action` must be "insert", "replace", or "delete".',
      ],
      [
        { page: hex(PAGE), edits: [{ ...insert, position: 'before' }] },
        'Edit 1: `position` must be "after", "inside", "start", or "end".',
      ],
      // An empty `position` never reaches the tool from the model: it is not one of the four, so the
      // agent runtime refuses it, as the tool does for any other caller.
      [
        { page: hex(PAGE), edits: [{ ...insert, block: '^00000001', position: '' }] },
        'Edit 1: `position` must be "after", "inside", "start", or "end".',
      ],
      [{ page: hex(PAGE), edits: [{ ...insert, block: 1 }] }, '`edits[0].block`: Invalid input: expected string'],
      [
        { page: hex(PAGE), edits: [{ ...insert, markdown: ['x'] }] },
        '`edits[0].markdown`: Invalid input: expected string',
      ],
      [{ page: hex(PAGE), edits: [{ ...insert, text: 'x' }] }, '`edits[0]`: Unrecognized key: "text"'],
      [{ page: hex(PAGE), edits: ['delete ^1'] }, '`edits[0]`: Invalid input: expected object, received string'],
    ]
    for (const [args, message] of refused) await expect(run(args)).rejects.toThrow(message)
    expect(editPage.preview!({ page: hex(PAGE), edits: [{ action: 'move' }] })).toBeUndefined()
    expect(tab.sent).toEqual([])
  })

  it('[@no-uc:data] writes nothing for a replacement with the same content', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    open(ws)
    const shown = body(await read())
    const result = await edit([{ action: 'replace', block: '^00000001', markdown: shown }])
    expect(result).toContain('^00000001 already had that content; nothing changed.')
    expect(ws.records.get(id(1))!.version).toBe(1)
    // Nothing was sent at all: not even the page's edit time.
    expect(ws.transactions).toEqual([])
    // The side panel counts no page as changed for it.
    expect(editPage.touched({ page: hex(PAGE), edits: [{ action: 'delete', block: '^00000001' }] }, result)).toEqual({})
    // Still as read, so it can be edited right away.
    const edited = await edit([{ action: 'replace', block: '^00000001', markdown: 'Intro, edited' }])
    expect(editPage.touched({ page: hex(PAGE), edits: [{ action: 'delete', block: '^00000001' }] }, edited)).toEqual({
      changed: [hex(PAGE)],
    })
  })

  it('[@no-uc:notion-safety] are sent only when the new Markdown mentions someone', async () => {
    const stranger = '0f0f0f0f-0000-4000-8000-000000000003'
    const ws = workspace(
      [1, 2],
      [
        block(1, 'text', undefined, { properties: { title: [['Ask '], ['‣', [['u', stranger]]]] } }),
        block(2, 'text', 'Two'),
      ],
    )
    const tab = open(ws)
    await read()
    const lookups = () => tab.sent.filter((r) => r.url.endsWith('/syncRecordValuesMain')).length
    const before = lookups()
    await edit([{ action: 'delete', block: '^00000002' }])
    expect(lookups()).toBe(before)
  })

  it('[@no-uc:data] names the signed-in user as the creator and last editor of what it writes', async () => {
    const ws = workspace([1, 2], [block(1, 'text', 'Intro'), block(2, 'text', 'Old')])
    open(ws)
    await read()
    await edit([
      { action: 'insert', block: '^00000001', markdown: 'New' },
      { action: 'delete', block: '^00000002' },
    ])
    const created = [...ws.records.values()].find(
      (r) => (r as Rec).properties && JSON.stringify((r as Rec).properties) === '{"title":[["New"]]}',
    )!
    expect(created).toMatchObject({
      created_by_id: USER,
      created_by_table: 'notion_user',
      last_edited_by_id: USER,
      last_edited_by_table: 'notion_user',
    })
    for (const changed of [PAGE, id(2)]) {
      expect(ws.records.get(changed)).toMatchObject({ last_edited_by_id: USER, last_edited_by_table: 'notion_user' })
    }
  })
})

describe('Markdown to blocks', () => {
  it('[@no-uc:data] reads back the inline formatting read_page writes', () => {
    const page = 'f0f0f0f0-0000-4000-8000-000000000001'
    expect(inline('Ship **fast** and *safe*, see [docs](https://example.com/docs) or run `pnpm check`.')).toEqual([
      ['Ship '],
      ['fast', [['b']]],
      [' and '],
      ['safe', [['i']]],
      [', see '],
      ['docs', [['a', 'https://example.com/docs']]],
      [' or run '],
      ['pnpm check', [['c']]],
      ['.'],
    ])
    expect(inline(`About [Plan](${hex(page)}) and ~~old~~ **[bold link](https://x.example)**`)).toEqual([
      ['About '],
      ['‣', [['p', page]]],
      [' and '],
      ['old', [['s']]],
      [' '],
      ['bold link', [['b'], ['a', 'https://x.example']]],
    ])
  })

  it('[@no-uc:data] parses each kind of block, nesting, and drops block references', () => {
    expect(
      parseMarkdown(
        [
          '# H1 ^00000001',
          '### H3',
          '- [x] done',
          '1. first',
          '  - nested',
          '▸ toggle',
          '> [!💡] tip',
          '> quote line 1',
          '> quote line 2',
          '---',
          '$$e=mc^2$$',
          '```js',
          'x()',
          '```',
          '^0000000a',
          'plain',
        ].join('\n'),
      ),
    ).toEqual([
      { type: 'header', title: [['H1']], children: [] },
      { type: 'sub_sub_header', title: [['H3']], children: [] },
      { type: 'to_do', title: [['done']], checked: true, children: [] },
      {
        type: 'numbered_list',
        title: [['first']],
        children: [{ type: 'bulleted_list', title: [['nested']], children: [] }],
      },
      { type: 'toggle', title: [['toggle']], children: [] },
      { type: 'callout', title: [['tip\nquote line 1\nquote line 2']], icon: '💡', children: [] },
      { type: 'divider', title: [], children: [] },
      { type: 'equation', title: [['e=mc^2']], children: [] },
      { type: 'code', title: [['x()']], language: 'js', children: [] },
      { type: 'text', title: [['plain']], children: [] },
    ])
  })

  it.each([
    ['prices', 'From $5 to $10, or $5-$10'],
    ['shell variables and dates inside words', '$HOME/$USER and me@2026-01-01.example'],
    ['dates and times that do not exist', '@2026-13-45 and @2026-02-29 and @2026-11-12 25:00'],
    ['protocol-relative links', '[x](//evil.example)'],
    ['a caret and hex digits that are not a reference', '2^deadbeef'],
  ])('[@no-uc:data] keeps %s as text', (_, text) => {
    expect(parseMarkdown(text)).toEqual([{ type: 'text', title: [[text]], children: [] }])
  })

  it('[@no-uc:data] writes only web, mail, and Notion page links as links', () => {
    expect(
      inline('[a](https://x.example) [b](mailto:a@x.example) [c](javascript:alert(1)) [d](data:text/html,x)'),
    ).toEqual([
      ['a', [['a', 'https://x.example']]],
      [' '],
      ['b', [['a', 'mailto:a@x.example']]],
      [' [c](javascript:alert(1)) [d](data:text/html,x)'],
    ])
  })

  it('[@no-uc:data] writes only emoji as callout icons, and links with parentheses whole', () => {
    expect(parseMarkdown('> [!NOTE] Heads up')).toEqual([{ type: 'callout', title: [['Heads up']], children: [] }])
    expect(inline('[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) and [a \\] b](https://x.example)')).toEqual([
      ['Foo', [['a', 'https://en.wikipedia.org/wiki/Foo_(bar)']]],
      [' and '],
      ['a ] b', [['a', 'https://x.example']]],
    ])
  })

  it('[@no-uc:data] reads blocks inside a quote or callout as nested in it, not as its text', () => {
    expect(parseMarkdown('> [!💡] Box\n> - item')).toEqual([
      {
        type: 'callout',
        title: [['Box']],
        icon: '💡',
        children: [{ type: 'bulleted_list', title: [['item']], children: [] }],
      },
    ])
    expect(parseMarkdown('> line one\n> line two')).toEqual([
      { type: 'quote', title: [['line one\nline two']], children: [] },
    ])
  })

  it('[@no-uc:data] keeps a line break in inline code a line break', () => {
    expect(parseMarkdown('Run `line 1`<br>`line 2`')).toEqual([
      { type: 'text', title: [['Run '], ['line 1', [['c']]], ['\n'], ['line 2', [['c']]]], children: [] },
    ])
  })

  it('[@no-uc:data] keeps bold, italic, and strikethrough over a line break', () => {
    expect(parseMarkdown('**a<br>b** *c<br>d* ~~e<br>f~~')).toEqual([
      {
        type: 'text',
        title: [['a\nb', [['b']]], [' '], ['c\nd', [['i']]], [' '], ['e\nf', [['s']]]],
        children: [],
      },
    ])
  })

  it('[@no-uc:data] refuses a code caption and the lines that stand for synced blocks or blocks not loaded', () => {
    // The caption line right after a fence belongs to the code block; anywhere else it is refused.
    expect(parseMarkdown('```js\nx\n```\n[caption: Example code] ^00000001')).toEqual([
      { type: 'code', title: [['x']], language: 'js', caption: 'Example code', children: [] },
    ])
    expect(() => parseMarkdown('Intro\n[caption: Example code]')).toThrow(
      "A [caption: …] line belongs right after a code block's closing fence.",
    )
    for (const line of ['[synced block]', '[synced copy]', '[synced copy, not loaded]', '[3 blocks not loaded]']) {
      expect(() => parseMarkdown(`${line} ^00000001`)).toThrow("stands for content edit_page can't create")
    }
  })

  it('[@no-uc:data] refuses a row with more cells than the header, and a table nested under a line', () => {
    expect(() => parseMarkdown('| a |\n| --- |\n| b | c |')).toThrow('more cells than the header')
    expect(parseMarkdown('| a | b |\n| c |')[0].rows).toEqual([
      [[['a']], [['b']]],
      [[['c']], []],
    ])
    expect(parseMarkdown('| `a\\|b` | x<br>y |')[0].rows).toEqual([[[['a|b', [['c']]]], [['x\ny']]]])
  })

  it('[@no-uc:data] takes a time given at one end of a date range for both ends', () => {
    expect(inline('@2026-11-12 10:00 → 2026-11-13')).toEqual([
      [
        '‣',
        [
          [
            'd',
            {
              type: 'datetimerange',
              start_date: '2026-11-12',
              start_time: '10:00',
              end_date: '2026-11-13',
              end_time: '10:00',
            },
          ],
        ],
      ],
    ])
  })

  it('[@no-uc:data] nests a list written under a quote line that carries its reference, instead of starting a new quote', () => {
    expect(parseMarkdown('> Note ^1a2b3c4d\n> - new item\n> Next quote ^2b3c4d5e')).toEqual([
      { type: 'quote', title: [['Note']], children: [{ type: 'bulleted_list', title: [['new item']], children: [] }] },
      { type: 'quote', title: [['Next quote']], children: [] },
    ])
  })

  it('[@no-uc:data] writes only the colors Notion has, green as Notion stores it', () => {
    expect(inline('<span color="green">a</span> and <span color="blue_background">b</span>')).toEqual([
      ['a', [['h', 'teal']]],
      [' and '],
      ['b', [['h', 'blue_background']]],
    ])
  })

  it('[@no-uc:data] keeps a first row of single dashes as data, and takes a real separator line out', () => {
    expect(parseMarkdown('| Name | Note |\n| - | - |\n| a | b |')[0].rows).toEqual([
      [[['Name']], [['Note']]],
      [[['-']], [['-']]],
      [[['a']], [['b']]],
    ])
    for (const separator of ['| --- | --- |', '|:-|-:|', '| :---: | --- |']) {
      expect(parseMarkdown(`| Name | Note |\n${separator}\n| a | b |`)[0].rows).toEqual([
        [[['Name']], [['Note']]],
        [[['a']], [['b']]],
      ])
    }
  })

  it('[@no-uc:data] keeps a span with any color inside inline code as code, and still refuses one outside it', () => {
    expect(inline('use `<span color="x">a</span>` here')).toEqual([
      ['use '],
      ['<span color="x">a</span>', [['c']]],
      [' here'],
    ])
    expect(() => inline('use <span color="x">a</span> here')).toThrow(`"x" isn't a Notion color.`)
  })

  it('[@no-uc:data] closes and opens again a code block indented in a quote when a part splits it', () => {
    const code = Array.from({ length: 40 }, (_, n) => `>   line ${n} ${'x'.repeat(20)}`)
    const section = ['> [!💡] Box ^00000001', '>   - Item ^00000002', '>   ```js', ...code, '>   ```'].join('\n')
    const { parts } = splitSections([section], 400)
    expect(parts.length).toBeGreaterThan(2)
    for (const part of parts.slice(0, -1)) expect(part.split('\n').at(-1)).toBe('>   ```')
    for (const part of parts.slice(1)) expect(part.split('\n')[0]).toBe('>   ```js')
  })

  it('[@no-uc:data] gives a colliding short reference to the block read last', () => {
    const older = 'aaaaaaaa-0000-4000-8000-000012345678'
    const later = 'bbbbbbbb-0000-4000-8000-000012345678'
    const one = (blockId: string): PageRead => ({
      pageId: PAGE,
      title: 'Fixture page',
      ids: new Map([['12345678', blockId]]),
      refs: new Map([[blockId, '12345678']]),
      versions: new Map([[blockId, 1]]),
      lines: new Map([[blockId, 'x']]),
      nested: new Map(),
    })
    const merged = mergeReads(one(older), one(later))
    expect(merged.ids.get('12345678')).toBe(later)
    expect(merged.ids.get(hex(older))).toBe(older)
  })
})
