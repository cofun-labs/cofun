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
    readonly text = '',
  ) {}
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
  querySelectorAll(selector: string) {
    if (selector === '[data-block-id]') return this.all().filter((e) => e.blockId)
    // A selected block holds a halo element; its closest block is the block itself.
    if (selector === '.notion-selectable-halo')
      return this.all()
        .filter((e) => e.halo)
        .map((e) => ({ closest: () => e }))
    return []
  }
}

/** A page whose content holds `blocks`; `selected` (text selection) or `haloed` (block selection). */
function dom(root: FakeElement, selection?: { blocks: FakeElement[]; text: string }) {
  return {
    querySelector: (s: string) => (s === '.notion-page-content' ? root : null),
    getSelection: () =>
      selection
        ? {
            rangeCount: 1,
            isCollapsed: false,
            toString: () => selection.text,
            getRangeAt: () => ({
              commonAncestorContainer: root,
              intersectsNode: (el: FakeElement) => selection.blocks.some((b) => el.contains(b)),
            }),
          }
        : { rangeCount: 0, isCollapsed: true },
  }
}

function block(n: number, type: string, text: string, extra: Record<string, unknown> = {}, parent = PAGE) {
  return { id: id(n), type, parent_id: parent, parent_table: 'block', properties: { title: [[text]] }, ...extra }
}

function setup(
  selection: (els: FakeElement[], root: FakeElement) => { blocks: FakeElement[]; text: string } | undefined,
) {
  const ws = new FakeWorkspace(
    [
      {
        id: PAGE,
        type: 'page',
        properties: { title: [['Fixture page']] },
        content: [id(1), id(2), id(3)],
        parent_id: SPACE,
        parent_table: 'space',
      },
      block(1, 'text', 'First paragraph.'),
      block(2, 'text', 'Second paragraph.'),
      block(3, 'to_do', 'A task', { properties: { title: [['A task']], checked: [['No']] } }),
    ],
    SPACE,
  )
  const els = [
    new FakeElement(id(1), 'First paragraph.'),
    new FakeElement(id(2), 'Second paragraph.'),
    new FakeElement(id(3), 'A task'),
  ]
  const root = new FakeElement(undefined).add(...els)
  const tab = new FakeNotionTab(PAGE_URL)
  tab.workspace = ws
  tab.dom = dom(root, selection(els, root))
  tab.install()
  return { ws, els }
}

const run = async () => (await getSelection.run({})) as string

describe('UC-NOTION-003 work on the selection', () => {
  it('[UC-NOTION-003-S01] gets the selected text and the blocks it covers, across two blocks', async () => {
    setup((els) => ({ blocks: [els[0], els[1]], text: 'paragraph.\nSecond' }))
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
    expect((await run()).split('\n').slice(-2)).toEqual(['Selected block:', '- [ ] A task ^00000003'])
  })

  it('[UC-NOTION-003-S02] says when nothing is selected', async () => {
    setup(() => undefined)
    expect(await run()).toBe('Nothing is selected in the Notion page.')
  })

  it('[UC-NOTION-003-S03] lets the agent change exactly the selected block, without reading the whole page', async () => {
    const { ws } = setup((els) => ({ blocks: [els[1]], text: 'Second paragraph.' }))
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
