// The get_selection tool (extensions/notico/src/tools/read.ts): the selection read from the Notion tab's page,
// against a small fake DOM with the parts the in-tab script uses, and the page from a fake workspace.
import { afterEach, describe, expect, it } from 'vitest'
import { forgetReads } from '../src/tools/memory'
import { getSelection } from '../src/tools/read'
import { PART_CHARS } from '../src/tools/shared'
import { editPage } from '../src/tools/write'
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

/** Where an element's text starts and ends in the whole document's text, all roots in order. */
function positions(roots: FakeElement[]) {
  const at = new Map<FakeElement, [number, number]>()
  let pos = 0
  const walk = (el: FakeElement) => {
    const start = pos
    pos += el.text.length
    for (const c of el.children) walk(c)
    at.set(el, [start, pos])
  }
  for (const r of roots) walk(r)
  return at
}

/** A range over the document's text, with the parts of the DOM Range API the in-tab script uses. */
class FakeRange {
  constructor(
    private readonly at: Map<FakeElement, [number, number]>,
    private readonly all: string,
    public start = 0,
    public end = 0,
  ) {}
  get startContainer() {
    return this.leafAt(this.start, true)
  }
  get startOffset() {
    return this.start - this.at.get(this.startContainer)![0]
  }
  get endContainer() {
    return this.leafAt(this.end, false)
  }
  get endOffset() {
    return this.end - this.at.get(this.endContainer)![0]
  }
  get collapsed() {
    return this.start >= this.end
  }
  /** Whether the range and the element's contents overlap or touch. */
  intersectsNode(el: FakeElement) {
    const [s, e] = this.at.get(el)!
    return s <= this.end && e >= this.start
  }
  /** The text element a point is in; at the edge between two, a start is in the later one. */
  private leafAt(pos: number, start: boolean) {
    const leaves = [...this.at.entries()].filter(([el, [s, e]]) => el.text && s <= pos && pos <= e)
    return (start ? leaves.at(-1) : leaves[0])![0]
  }
  selectNodeContents(el: FakeElement) {
    ;[this.start, this.end] = this.at.get(el)!
  }
  setStart(el: FakeElement, offset: number) {
    this.start = this.at.get(el)![0] + offset
    if (this.end < this.start) this.end = this.start
  }
  setEnd(el: FakeElement, offset: number) {
    this.end = this.at.get(el)![0] + offset
    if (this.start > this.end) this.start = this.end
  }
  compareBoundaryPoints(how: number, other: FakeRange) {
    const [a, b] = how === 0 ? [this.start, other.start] : [this.end, other.end]
    return Math.sign(a - b)
  }
  toString() {
    return this.all.slice(this.start, this.end)
  }
}

/** The text element of a block, or the element itself. */
const textOf = (el: FakeElement) => (el.text ? el : el.children[0])

/**
 * A document of `top` elements in order (the page title, the main page's content, a side peek's),
 * the contents among them `roots`, and a text selection from `from` to `to`: [element, offset into
 * its text], each a block or a block's text element.
 */
function dom(
  top: FakeElement[],
  roots: FakeElement[],
  selection?: { from: [FakeElement, number]; to: [FakeElement, number] },
) {
  const at = positions(top)
  const all = top.map((r) => r.textContent.split('\n').join('')).join('')
  const range = () => new FakeRange(at, all)
  const selected = () => {
    const r = range()
    r.setEnd(textOf(selection!.to[0]), selection!.to[1])
    r.setStart(textOf(selection!.from[0]), selection!.from[1])
    return r
  }
  return {
    querySelectorAll: (s: string) => (s === '.notion-page-content' ? roots : []),
    createRange: range,
    getSelection: () =>
      selection
        ? { rangeCount: 1, isCollapsed: false, toString: () => selected().toString(), getRangeAt: selected }
        : { rangeCount: 0, isCollapsed: true },
  }
}

/** From the start of one element's text to the end of another's. */
const across = (from: FakeElement, to: FakeElement) => ({
  from: [from, 0] as [FakeElement, number],
  to: [to, textOf(to).text.length] as [FakeElement, number],
})

function block(n: number, type: string, text: string, extra: Record<string, unknown> = {}, parent = PAGE) {
  return { id: id(n), type, parent_id: parent, parent_table: 'block', properties: { title: [[text]] }, ...extra }
}

function setup(
  selection: (
    els: FakeElement[],
    root: FakeElement,
    peek: FakeElement,
    title: FakeElement,
  ) => { from: [FakeElement, number]; to: [FakeElement, number] } | undefined,
  more: {
    blocks?: Record<string, unknown>[]
    els?: FakeElement[]
    content?: string[]
    /** The page's own blocks (by index) Notion hasn't drawn. */
    undrawn?: number[]
  } = {},
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
  const root = new FakeElement(undefined).add(...els.filter((_, n) => !more.undrawn?.includes(n)))
  const peek = new FakeElement(undefined).add(new FakeElement(id(90), 'In the peek'))
  // The title is drawn outside the page's content.
  const title = new FakeElement(undefined, 'Fixture page')
  const tab = new FakeNotionTab(PAGE_URL)
  tab.workspace = ws
  tab.dom = dom([title, root, peek], [root, peek], selection(els, root, peek, title))
  tab.install()
  return { ws, els }
}

const run = async (args: Record<string, unknown> = {}) => (await getSelection.run(args)) as string

describe('UC-NOTICO-NOTION-003 work on the selection', () => {
  it('[UC-NOTICO-NOTION-003-S01] gets the selected text and the blocks it covers, across two blocks', async () => {
    setup((els) => ({ from: [els[0], 6], to: [els[1], 6] }))
    expect(await run()).toBe(
      [
        `Selection on the page “Fixture page” ^${hex(PAGE)}:`,
        '',
        'Selected text: “paragraph.Second”',
        '',
        'Selected blocks:',
        'First paragraph. ^00000001',
        'Second paragraph. ^00000002',
      ].join('\n'),
    )
  })

  it('[UC-NOTICO-NOTION-003-S01] leaves out a block the range only touches at its edge', async () => {
    // A triple-click ends the range at the start of the next block's text.
    setup((els) => ({ from: [els[0], 0], to: [els[1], 0] }))
    expect((await run()).split('\n').slice(-2)).toEqual(['Selected block:', 'First paragraph. ^00000001'])
    restoreGlobals()
    forgetReads()
    // A drag that starts at the very end of a block.
    setup((els) => ({ from: [els[0], 'First paragraph.'.length], to: [els[1], 6] }))
    expect((await run()).split('\n').slice(-2)).toEqual(['Selected block:', 'Second paragraph. ^00000002'])
  })

  it('[UC-NOTICO-NOTION-003-S01] gets blocks selected as blocks', async () => {
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

  it('[UC-NOTICO-NOTION-003-S01] keeps a block whose own text is selected along with a block nested in it', async () => {
    const child = new FakeElement(id(5), 'Inside the toggle')
    const toggle = new FakeElement(id(4), 'A toggle').add(child)
    setup(() => ({ from: [toggle, 2], to: [child, 6] }), {
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
    setup(() => ({ from: [child, 0], to: [child, 6] }), {
      blocks: [block(4, 'toggle', 'A toggle', { content: [id(5)] }), block(5, 'text', 'Inside the toggle', {}, id(4))],
      els: [toggle],
      content: [id(4)],
    })
    expect((await run()).split('\n').slice(-2)).toEqual(['Selected block:', 'Inside the toggle ^00000005'])
  })

  it('[UC-NOTICO-NOTION-003-S01] stands for a table row by its table, which is what the agent sees', async () => {
    const row = new FakeElement(id(7), 'cell')
    const table = new FakeElement(id(6)).add(row)
    const { ws } = setup(() => across(row, row), {
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

  it('[UC-NOTICO-NOTION-003-S01] says when the selected blocks aren’t on the open page, or only some are', async () => {
    // A selection in a side peek of another page, while the open page is this one.
    setup((_, __, peek) => across(peek.children[0], peek.children[0]))
    expect(await run()).toBe(
      "The selected blocks aren't on the open page. Read the page instead, or ask the user to select again.",
    )
    restoreGlobals()
    const stray = new FakeElement(id(99), 'Not on the page')
    setup((els) => across(els[2], stray), { els: [stray] })
    expect((await run()).split('\n').slice(-3)).toEqual([
      '- [ ] A task ^00000003',
      '',
      "Only part of the selection is shown: the other selected blocks aren't on the open page.",
    ])
  })

  it('[UC-NOTICO-NOTION-003-S01] shows at most a part of a large selection, and only that much counts as read', async () => {
    const big = Array.from({ length: 30 }, (_, n) => new FakeElement(id(100 + n), `${n} ${'y'.repeat(900)}`))
    setup((els) => ({ from: [els[0], 0], to: [big.at(-1)!, 3] }), {
      blocks: big.map((_, n) => block(100 + n, 'text', `${n} ${'y'.repeat(900)}`)),
      els: big,
      content: big.map((_, n) => id(100 + n)),
    })
    const result = await run()
    expect(result.length).toBeLessThan(PART_CHARS + 2500)
    const more = Number(/^(\d+) more selected blocks: read the page for them\.$/m.exec(result)![1])
    expect(more).toBeGreaterThan(0)
    // The last selected block wasn't shown, so it can't be edited by this read.
    await expect(
      editPage.run({ page: hex(PAGE), edits: [{ action: 'delete', block: `^${hex(id(129)).slice(-8)}` }] }),
    ).rejects.toThrow('is not a block of the page as you last read it')
  })

  it('[UC-NOTICO-NOTION-003-S05] says when blocks selected as blocks may go on past what Notion has drawn', async () => {
    const notice =
      'The selection may go on past the part of the page Notion has drawn in the browser, so some selected ' +
      'blocks may be missing. Ask the user whether more is selected, or read the page.'
    // The last block drawn is selected, and the page goes on after it.
    const later = { blocks: [block(4, 'text', 'Not drawn yet')], content: [id(4)] }
    setup((els) => {
      els[2].halo = true
      return undefined
    }, later)
    expect((await run()).split('\n').slice(-4)).toEqual(['Selected block:', '- [ ] A task ^00000003', '', notice])
    // The first block drawn is selected, and the page has blocks before it.
    restoreGlobals()
    forgetReads()
    setup(
      (els) => {
        els[1].halo = true
        return undefined
      },
      { undrawn: [0] },
    )
    expect((await run()).split('\n').slice(-4)).toEqual(['Selected block:', 'Second paragraph. ^00000002', '', notice])
    // Drawn blocks on both sides: nothing more to say.
    restoreGlobals()
    forgetReads()
    setup((els) => {
      els[1].halo = true
      return undefined
    }, later)
    expect((await run()).split('\n').slice(-2)).toEqual(['Selected block:', 'Second paragraph. ^00000002'])
  })

  it('[UC-NOTICO-NOTION-003-S06] gets a text selection that starts in the page title', async () => {
    setup((els, _, __, title) => ({ from: [title, 8], to: [els[0], 5] }))
    expect(await run()).toBe(
      [
        `Selection on the page “Fixture page” ^${hex(PAGE)}:`,
        '',
        'Selected text: “pageFirst”',
        '',
        'Selected block:',
        'First paragraph. ^00000001',
      ].join('\n'),
    )
  })

  it('[UC-NOTICO-NOTION-003-S06] gets the open page’s blocks of a text selection that runs into a side peek', async () => {
    const { ws } = setup((els, _, peek) => ({ from: [els[2], 2], to: [peek.children[0], 2] }))
    expect((await run()).split('\n').slice(-6)).toEqual([
      'Selected text: “taskIn”',
      '',
      'Selected block:',
      '- [ ] A task ^00000003',
      '',
      "Only part of the selection is shown: the other selected blocks aren't on the open page.",
    ])
    expect(ws.transactions).toEqual([])
  })

  it('[UC-NOTICO-NOTION-003-S02] says when nothing is selected', async () => {
    setup(() => undefined)
    expect(await run()).toBe('Nothing is selected in the Notion page.')
  })

  it('[UC-NOTICO-NOTION-003-S03] lets the agent change exactly the selected block, without reading the whole page', async () => {
    const { ws } = setup((els) => across(els[1], els[1]))
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

describe('get_selection arguments', () => {
  it('takes no arguments, and asks Notion nothing when given one', async () => {
    const tab = new FakeNotionTab(PAGE_URL).install()
    await expect(run({ page: 'x' })).rejects.toThrow('Unrecognized key: "page"')
    expect(tab.sent).toEqual([])
  })
})
