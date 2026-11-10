import { describe, expect, it } from 'vitest'
import { type ParentOf, type Place, insideOwn, mentionedIds, withinOwnPages } from '../src/scope'

const OWN = '9f8637a1-cfcc-46bb-a9da-3eba20da5996'
const CHILD = '9455a87b-8c6f-43ba-b587-cad033f26926'
const DB = '7ab17736-c439-4cf0-b9a6-77bb307151a1'
const COLLECTION = '00000000-0000-4000-8000-0000000000c0'
const ROW = '00000000-0000-4000-8000-0000000000c1'
const OTHER = '01234567-89ab-cdef-0123-456789abcdef'
const SPACE = '00000000-0000-4000-8000-0000000000aa'

// A fake workspace: each record's parent, as Notion would report it.
const parents: Record<string, Place> = {
  [`block:${OWN}`]: { table: 'space', id: SPACE },
  [`block:${CHILD}`]: { table: 'block', id: OWN },
  [`block:${DB}`]: { table: 'space', id: SPACE },
  [`collection:${COLLECTION}`]: { table: 'block', id: DB },
  [`block:${ROW}`]: { table: 'collection', id: COLLECTION },
  [`block:${OTHER}`]: { table: 'space', id: SPACE },
}
const parentOf: ParentOf = async (p) => parents[`${p.table}:${p.id}`]
const created = [OWN, DB]

describe('mentionedIds', () => {
  it('finds ids in URLs, dashed or not, once each', () => {
    expect(
      mentionedIds(
        `{"parent": "https://app.notion.com/p/e2e-S04-${OWN.replace(/-/g, '')}", "page": "${OWN}", "block": "^d7340fb4"}`,
      ),
    ).toEqual([OWN])
  })
})

describe('insideOwn', () => {
  it('accepts the tool’s pages, pages inside them, and rows of its databases', async () => {
    expect(await insideOwn(OWN, created, parentOf)).toBe(true)
    expect(await insideOwn(CHILD, created, parentOf)).toBe(true)
    expect(await insideOwn(ROW, created, parentOf)).toBe(true)
  })

  it('refuses pages elsewhere in the workspace, and ones it can’t look up', async () => {
    expect(await insideOwn(OTHER, created, parentOf)).toBe(false)
    expect(await insideOwn('00000000-0000-4000-8000-0000000000ff', created, parentOf)).toBe(false)
  })
})

describe('withinOwnPages', () => {
  it('approves a call only if every page it names is inside the tool’s pages', async () => {
    expect(await withinOwnPages(`{"page": "${CHILD}"}`, created, parentOf)).toBe(true)
    expect(await withinOwnPages(`{"page": "${CHILD}", "parent": "${OTHER}"}`, created, parentOf)).toBe(false)
  })

  it('refuses a call that names no page at all', async () => {
    expect(await withinOwnPages('{"query": "roadmap"}', created, parentOf)).toBe(false)
  })
})
