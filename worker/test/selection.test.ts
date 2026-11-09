// The get_selection tool (extension/src/tools.ts): the selection read from the Notion tab's page,
// against a small fake DOM with the parts the in-tab script uses, and the page from a fake workspace.
import { afterEach, describe, expect, it } from 'vitest'
import { editPage, forgetReads, getSelection } from '../../extension/src/tools'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, restoreGlobals } from './notion-tab'

afterEach(() => {
  restoreGlobals()
  forgetReads()
})

const hex = (s: string) => s.replace(/-/g, '')
const id = (n: number) => `5e5e5e5e-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

/** A block element in the page, as Notion renders it: `data-block-id`, nested blocks inside. */
class FakeElement {
  children: FakeElement[] = []
  parent?: FakeElement
  halo = false
  constructor(
    readonly blockId: string | undefined,
    public text = '',
  ) {
    // A block's text is in an element of its own; nested blocks sit next to it.
    if (blockId && text) {
      this.add(new FakeElement(undefined, text))
      this.text = ''
    }
  }
  add(...kids: FakeElement[]) {
    for (const k of kids) {
      k.parent = this
      this.children.push(k)
    }
    return this
  }
  getAttribute(name: string) {
    return name === 'data-block-id' ? (this.blockId ?? null) : null
  }
  get textContent(): string {
    return [this.text, ...this.children.map((c) => c.textContent)].filter(Boolean).join('\n')
  }
  contains(other: FakeElement): boolean {
    for (let e: FakeElement | undefined = other; e; e = e.parent) if (e === this) return true
    return false
  }
  closest(selector: string): FakeElement | null {
    if (selector !== '[data-block-id]') return null
    for (let e: FakeElement | undefined = this; e; e = e.parent) if (e.blockId) return e
    return null
  }
  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()])
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null
  }
  querySelectorAll(selector: string): unknown[] {
    if (selector === '[data-block-id]') return this.all().filter((e) => e.blockId)
    // A selected block holds a halo element; its closest block is the block itself.
    if (selector === '.notion-selectable-halo')
      return this.all()
        .filter((e) => e.halo)
        .map((e) => ({ closest: () => e }))
    return []
  }
}

/**
 * Pages whose content are `roots` (the main page, then a side peek) and a text selection that
 * covers the `touched` elements: whole blocks, or only a block's own text element.
 */
function dom(roots: FakeElement[], selection?: { touched: FakeElement[]; text: string; root?: FakeElement }) {
  return {
    querySelectorAll: (s: string) => (s === '.notion-page-content' ? roots : []),
    getSelection: () =>
      selection
        ? {
            rangeCount: 1,
            isCollapsed: false,
            toString: () => selection.text,
            getRangeAt: () => ({
              commonAncestorContainer: selection.root ?? roots[0],
              intersectsNode: (el: FakeElement) => selection.touched.some((t) => el.contains(t) || t.contains(el)),
            }),
          }
        : { rangeCount: 0, isCollapsed: true },
  }
}

function block(n: number, type: string, text: string, extra: Record<string, unknown> = {}, parent = PAGE) {
  return { id: id(n), type, parent_id: parent, parent_table: 'block', properties: { title: [[text]] }, ...extra }
}

function setup(
  selection: (
    els: FakeElement[],
    root: FakeElement,
    peek: FakeElement,
  ) => { touched: FakeElement[]; text: string; root?: FakeElement } | undefined,
  more: { blocks?: Record<string, unknown>[]; els?: FakeElement[]; content?: string[] } = {},
) {
  const ws = new FakeWorkspace(
    [
      {
        id: PAGE,
        type: 'page',
        properties: { title: [['Fixture page']] },
        content: [id(1), id(2), id(3), ...(more.content ?? [])],
        parent_id: SPACE,
        parent_table: 'space',
      },
      block(1, 'text', 'First paragraph.'),
      block(2, 'text', 'Second paragraph.'),
      block(3, 'to_do', 'A task', { properties: { title: [['A task']], checked: [['No']] } }),
      ...(more.blocks ?? []),
    ],
    SPACE,
  )
  const els = [
    new FakeElement(id(1), 'First paragraph.'),
    new FakeElement(id(2), 'Second paragraph.'),
    new FakeElement(id(3), 'A task'),
    ...(more.els ?? []),
  ]
  const root = new FakeElement(undefined).add(...els)
  const peek = new FakeElement(undefined).add(new FakeElement(id(90), 'In the peek'))
  const tab = new FakeNotionTab(PAGE_URL)
  tab.workspace = ws
  tab.dom = dom([root, peek], selection(els, root, peek))
  tab.install()
  return { ws, els }
}

const run = async () => (await getSelection.run({})) as string

describe('UC-NOTION-003 work on the selection', () => {
  it('[UC-NOTION-003-S01] gets the selected text and the blocks it covers, across two blocks', async () => {
    setup((els) => ({ touched: [els[0], els[1]], text: 'paragraph.\nSecond' }))
    expect(await run()).toBe(
      [
        `Selection on the page “Fixture page” ^${hex(PAGE)}:`,
        '',
        'Selected text: “paragraph.\nSecond”',
        '',
        'Selected blocks:',
        'First paragraph. ^00000001',
        'Second paragraph. ^00000002',
      ].join('\n'),
    )
  })

  it('[UC-NOTION-003-S01] gets blocks selected as blocks', async () => {
    setup((els) => {
      els[2].halo = true
      return undefined
    })
    expect(await run()).toBe(
      [`Selection on the page “Fixture page” ^${hex(PAGE)}:`, '', 'Selected block:', '- [ ] A task ^00000003'].join(
        '\n',
      ),
    )
  })

  it('[UC-NOTION-003-S01] keeps a block whose own text is selected along with a block nested in it', async () => {
    const child = new FakeElement(id(5), 'Inside the toggle')
    const toggle = new FakeElement(id(4), 'A toggle').add(child)
    setup((els) => ({ touched: [toggle.children[0], child], text: 'toggle\nInside' }), {
      blocks: [block(4, 'toggle', 'A toggle', { content: [id(5)] }), block(5, 'text', 'Inside the toggle', {}, id(4))],
      els: [toggle],
      content: [id(4)],
    })
    expect((await run()).split('\n').slice(-3)).toEqual([
      'Selected blocks:',
      '▸ A toggle ^00000004',
      'Inside the toggle ^00000005',
    ])
    // Selecting only inside the nested block leaves its parent out.
    restoreGlobals()
    forgetReads()
    setup(() => ({ touched: [child.children[0]], text: 'Inside' }), {
      blocks: [block(4, 'toggle', 'A toggle', { content: [id(5)] }), block(5, 'text', 'Inside the toggle', {}, id(4))],
      els: [toggle],
      content: [id(4)],
    })
    expect((await run()).split('\n').slice(-2)).toEqual(['Selected block:', 'Inside the toggle ^00000005'])
  })

  it('[UC-NOTION-003-S01] stands for a table row by its table, which is what the agent sees', async () => {
    const row = new FakeElement(id(7), 'cell')
    const table = new FakeElement(id(6)).add(row)
    const { ws } = setup(() => ({ touched: [row], text: 'cell' }), {
      blocks: [
        block(6, 'table', '', { content: [id(7)], format: { table_block_column_order: ['c1'] } }),
        { ...block(7, 'table_row', '', {}, id(6)), properties: { c1: [['cell']] } },
      ],
      els: [table],
      content: [id(6)],
    })
    const result = await run()
    expect(result.split('\n').slice(-4)).toEqual(['Selected block:', '| cell |', '| --- |', '^00000006'])
    // The row itself wasn't shown, so it can't be edited by this read.
    await expect(editPage.run({ page: hex(PAGE), edits: [{ action: 'delete', block: '^00000007' }] })).rejects.toThrow(
      'is not a block of the page as you last read it',
    )
    expect(ws.transactions).toEqual([])
  })

  it('[UC-NOTION-003-S01] says when the selected blocks aren’t on the open page, or only some are', async () => {
    // A selection in a side peek of another page, while the open page is this one.
    setup((_, __, peek) => ({ touched: [peek.children[0]], text: 'In the peek', root: peek }))
    expect(await run()).toBe(
      "The selected blocks aren't on the open page. Read the page instead, or ask the user to select again.",
    )
    restoreGlobals()
    const stray = new FakeElement(id(99), 'Not on the page')
    setup((els) => ({ touched: [els[2], stray], text: 'A task\nNot on the page' }), { els: [stray] })
    expect((await run()).split('\n').slice(-3)).toEqual([
      '- [ ] A task ^00000003',
      '',
      "Only part of the selection is shown: the other selected blocks aren't on the open page.",
    ])
  })

  it('[UC-NOTION-003-S02] says when nothing is selected', async () => {
    setup(() => undefined)
    expect(await run()).toBe('Nothing is selected in the Notion page.')
  })

  it('[UC-NOTION-003-S03] lets the agent change exactly the selected block, without reading the whole page', async () => {
    const { ws } = setup((els) => ({ touched: [els[1]], text: 'Second paragraph.' }))
    await run()
    await editPage.run({
      page: hex(PAGE),
      edits: [{ action: 'replace', block: '^00000002', markdown: 'Second paragraph, rewritten.' }],
    })
    expect(ws.content(PAGE).map((b) => b.properties)).toEqual([
      { title: [['First paragraph.']] },
      { title: [['Second paragraph, rewritten.']] },
      { title: [['A task']], checked: [['No']] },
    ])
    // Blocks outside the selection weren't shown, so they can't be edited by this read.
    await expect(editPage.run({ page: hex(PAGE), edits: [{ action: 'delete', block: '^00000001' }] })).rejects.toThrow(
      'is not a block of the page as you last read it',
    )
  })
})
