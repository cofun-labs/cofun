// The edit_page tool (extension/src/tools.ts) against a fake Notion workspace that applies
// transactions the way Notion does, so each test checks the page as it is after the edit.
import { afterEach, describe, expect, it } from 'vitest'
import { inline, parseMarkdown } from '../../extension/src/notion/blocks'
import { editPage, readPage } from '../../extension/src/tools'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, USER, restoreGlobals } from './notion-tab'

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

describe('UC-NOTION-002 edit a page', () => {
  it('[UC-NOTION-002-S01] inserts, replaces, and deletes in one edit, and changes nothing else', async () => {
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
    expect(result.split('\n').slice(0, 4)).toEqual([
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

  it('[UC-NOTION-002-S01] a round trip, replacing each block with what read_page showed, changes nothing', async () => {
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

  it('[UC-NOTION-002-S02] refuses to change a block the user changed after the AI read the page', async () => {
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

  it('[UC-NOTION-002-S02] refuses to insert after a block that was removed since the AI read the page', async () => {
    const ws = workspace([1, 2], [block(1, 'text', 'Intro'), block(2, 'text', 'Draft')])
    open(ws)
    await read()
    ws.edit(id(1), { alive: false })

    await expect(edit([{ action: 'insert', block: '^00000001', markdown: 'More' }])).rejects.toThrow(
      '^00000001 was deleted since you read the page.',
    )
    expect(ws.transactions).toEqual([])
  })

  it('[UC-NOTION-002-S04] never replaces content it cannot write', async () => {
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

  it('[UC-NOTION-002-S05] asks to read a page before editing it', async () => {
    const other = '7a7a7a7a-0000-4000-8000-000000000077'
    const ws = workspace([1], [block(1, 'text', 'Hi', {}, other)], other)
    open(ws, `https://app.notion.com/p/${hex(other)}`)
    await expect(edit([{ action: 'delete', block: '^00000001' }], { page: hex(other) })).rejects.toThrow(
      'Read the page with read_page first, then edit it',
    )
    expect(ws.transactions).toEqual([])
  })

  it('[UC-NOTION-002-S06] rewriting a block as the same kind keeps what is nested under it', async () => {
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

  it('[UC-NOTION-002-S07] tells the AI when Notion refuses the edit, and nothing changes', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    open(ws)
    await read()
    ws.reject = true
    await expect(edit([{ action: 'insert', position: 'end', markdown: 'More' }])).rejects.toThrow(
      'Notion returned an error (400 ValidationError): Invalid input.',
    )
    expect(withoutRefs(body(await read()))).toBe('Intro')
  })
})

describe('edit_page details', () => {
  it('needs the user’s OK, and previews each change with the text it replaces', async () => {
    expect(editPage.needsConfirmation).toBe(true)
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
      ].join('\n'),
    )
  })

  it('keeps editing possible after an edit, with the new blocks’ references', async () => {
    const ws = workspace([1], [block(1, 'text', 'Intro')])
    open(ws)
    await read()
    const result = await edit([{ action: 'insert', position: 'end', markdown: 'Second' }])
    const newRef = /New blocks: \^([0-9a-f]+)\./.exec(result)![1]
    // No read in between: the edit took a fresh read of the page.
    await edit([{ action: 'replace', block: newRef, markdown: 'Second, rewritten' }])
    expect(withoutRefs(body(await read()))).toBe(['Intro', 'Second, rewritten'].join('\n'))
  })

  it('appends in order and inserts several edits after the same block in order', async () => {
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

  it('replaces a block with several blocks, or with another kind, in its place', async () => {
    const ws = workspace([1, 2, 3], [block(1, 'text', 'A'), block(2, 'text', 'notes'), block(3, 'text', 'Z')])
    open(ws)
    await read()
    await edit([{ action: 'replace', block: '^00000002', markdown: '- [ ] one\n- [ ] two' }])
    expect(withoutRefs(body(await read()))).toBe(['A', '- [ ] one', '- [ ] two', 'Z'].join('\n'))
  })

  it('refuses unclear edits before asking Notion anything', async () => {
    const ws = workspace([1, 2], [block(1, 'text', 'A'), block(2, 'text', 'B')])
    const tab = open(ws)
    await read()
    const sent = tab.sent.length
    const refused = [
      [[], '`edits` must be a list with at least one edit.'],
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
        'so nothing can be inserted after it in the same call.',
      ],
      [[{ action: 'insert', markdown: '| a | b |' }], "Tables can't be written yet."],
      [[{ action: 'insert', markdown: '```\nunclosed' }], 'A code block is missing its closing fence.'],
    ] as const
    for (const [edits, message] of refused) {
      await expect(editPage.run({ page: hex(PAGE), edits: edits as unknown as Rec[] })).rejects.toThrow(message)
    }
    // Only the read went to Notion.
    expect(tab.sent).toHaveLength(sent)
    expect(ws.transactions).toEqual([])
  })
})

describe('Markdown to blocks', () => {
  it('reads back the inline formatting read_page writes', () => {
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

  it('parses each kind of block, nesting, and drops block references', () => {
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
})

describe('edit_page safety', () => {
  it('[UC-NOTION-002-S02] still refuses a block the user changed, after another edit took a fresh read', async () => {
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

  it('[UC-NOTION-002-S02] refuses a block of a long page the agent has not read the part of', async () => {
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

  it('[UC-NOTION-002-S02] refuses to delete a block when something nested under it changed', async () => {
    const ws = workspace([1], [block(1, 'toggle', 'T', { content: [id(2)] }), block(2, 'text', 'Inside', {}, id(1))])
    open(ws)
    await read()
    ws.edit(id(2), { properties: { title: [['Typed inside']] } })
    await expect(edit([{ action: 'delete', block: '^00000001' }])).rejects.toThrow(
      '^00000002, nested under ^00000001, was changed since you read the page.',
    )
    expect(ws.transactions).toEqual([])
  })

  it('[UC-NOTION-002-S04] refuses to delete a block with a child page nested under it', async () => {
    const ws = workspace([1], [block(1, 'toggle', 'T', { content: [id(2)] }), block(2, 'page', 'Child', {}, id(1))])
    open(ws)
    await read()
    await expect(edit([{ action: 'delete', block: '^00000001' }])).rejects.toThrow(
      "has a child page or database nested under it, so it can't be deleted.",
    )
  })

  it('previews what a delete takes with it, and refuses edits inside a block it deletes', async () => {
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
    await expect(
      edit([
        { action: 'delete', block: '^00000001' },
        { action: 'replace', block: '^00000002', markdown: 'x' },
      ]),
    ).rejects.toThrow('^00000002 is inside a block this call deletes.')
    expect(await edit([{ action: 'delete', block: '^00000001' }])).toContain('and the 2 blocks nested under it')
  })

  it('keeps mentions and formatting it can’t write when the text is unchanged', async () => {
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
    // Changing the text says what was lost.
    expect(await edit([{ action: 'replace', block: '^00000001', markdown: '- [x] Call later' }])).toContain(
      'are now plain text',
    )
  })

  it('round-trips a block with line breaks as one block', async () => {
    const ws = workspace([1], [block(1, 'bulleted_list', 'line one\nline two')])
    open(ws)
    const before = body(await read())
    expect(before).toBe('- line one<br>line two ^00000001')
    await edit([{ action: 'replace', block: '^00000001', markdown: '- line one<br>line two, edited' }])
    expect(body(await read())).toBe('- line one<br>line two, edited ^00000001')
    expect(ws.records.get(id(1))!.properties).toEqual({ title: [['line one\nline two, edited']] })
  })

  it('refuses to edit a database page', async () => {
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

  it('inserts at the start after deleting the first block in the same call', async () => {
    const ws = workspace([1, 2], [block(1, 'text', 'First'), block(2, 'text', 'Second')])
    open(ws)
    await read()
    await edit([
      { action: 'delete', block: '^00000001' },
      { action: 'insert', position: 'start', markdown: 'New first' },
    ])
    expect(withoutRefs(body(await read()))).toBe(['New first', 'Second'].join('\n'))
  })

  it('keeps a code block’s language when a rewrite gives none', async () => {
    const ws = workspace([1], [block(1, 'code', undefined, { properties: { title: [['a()']], language: [['Rust']] } })])
    open(ws)
    await read()
    await edit([{ action: 'replace', block: '^00000001', markdown: '```\nb()\n```' }])
    expect(ws.records.get(id(1))!.properties).toEqual({ title: [['b()']], language: [['Rust']] })
  })

  it('needs the page named in the call', async () => {
    await expect(editPage.run({ edits: [{ action: 'insert', markdown: 'x' }] })).rejects.toThrow('Give `page`')
    expect(editPage.preview!({ edits: [] })).toBeUndefined()
  })

  it('writes links that look like placeholders, nested lists, and code languages as Notion names them', async () => {
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
})
