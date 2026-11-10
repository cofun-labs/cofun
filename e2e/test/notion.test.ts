import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../../extension/src/notion/blocks'
import { findSpaceView, pageUrl, parseRow, privatePageOps, taskDatabaseOps, type PrivateSpace } from '../src/notion'

const SPACE: PrivateSpace = {
  spaceId: '00000000-0000-4000-8000-00000000000a',
  spaceViewId: '00000000-0000-4000-8000-00000000000b',
  userId: '00000000-0000-4000-8000-00000000000c',
}
const NOW = 1_700_000_000_000

function ids() {
  let n = 0
  return () =>
    `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`
}

const moveToPrivate = (pageId: string) => ({
  pointer: { table: 'block', id: pageId, spaceId: SPACE.spaceId },
  path: [],
  command: 'moveToPrivate',
  args: {
    spaceViewPointer: { id: SPACE.spaceViewId, table: 'space_view', spaceId: SPACE.spaceId },
    userId: SPACE.userId,
  },
})

describe('privatePageOps', () => {
  it('creates the page with its content, then moves it to the Private section', () => {
    const { operations, pageId } = privatePageOps(SPACE, 'E2E test', parseMarkdown('## Goals\nShip it'), {
      now: NOW,
      newId: ids(),
    })
    expect(pageId).toBe('00000000-0000-4000-8000-000000000001')
    const [page, ...rest] = operations
    expect(page).toMatchObject({ command: 'set', pointer: { table: 'block', id: pageId } })
    // A private page has no parent until moveToPrivate puts it in the workspace.
    expect(page.args).toEqual({
      id: pageId,
      type: 'page',
      version: 1,
      alive: true,
      space_id: SPACE.spaceId,
      created_time: NOW,
      last_edited_time: NOW,
      properties: { title: [['E2E test']] },
    })
    const created = rest.filter((op) => op.command === 'set').map((op) => op.args as Record<string, unknown>)
    expect(created.map((b) => [b.type, b.parent_id, b.properties])).toEqual([
      ['sub_header', pageId, { title: [['Goals']] }],
      ['text', pageId, { title: [['Ship it']] }],
    ])
    expect(operations.at(-1)).toEqual(moveToPrivate(pageId))
    // Nothing is listed in the workspace's own pages: that's moveToPrivate's job.
    expect(operations.some((op) => op.pointer.id === SPACE.spaceId)).toBe(false)
  })
})

describe('taskDatabaseOps', () => {
  it('creates a private table with Name, Status, and Due, and its rows', () => {
    const { operations, pageId } = taskDatabaseOps(
      SPACE,
      'Tasks',
      [{ name: 'Write post', status: 'Done', due: '2026-11-03' }, { name: 'Plan offsite' }],
      { now: NOW, newId: ids() },
    )
    const [block, collection, view, row1, row2, move] = operations
    expect(block.args).toMatchObject({
      id: pageId,
      type: 'collection_view_page',
      collection_id: collection.pointer.id,
      view_ids: [view.pointer.id],
    })
    expect(collection.pointer.table).toBe('collection')
    const { schema, name, parent_id } = collection.args as {
      schema: Record<string, { name: string; type: string; options?: { value: string }[] }>
      name: unknown
      parent_id: string
    }
    expect(name).toEqual([['Tasks']])
    expect(parent_id).toBe(pageId)
    expect(Object.values(schema).map((p) => [p.name, p.type])).toEqual([
      ['Name', 'title'],
      ['Status', 'select'],
      ['Due', 'date'],
    ])
    expect(view.args).toMatchObject({
      type: 'table',
      parent_id: pageId,
      format: { collection_pointer: { id: collection.pointer.id, table: 'collection', spaceId: SPACE.spaceId } },
    })
    const statusKey = Object.keys(schema).find((k) => schema[k].name === 'Status')!
    const dueKey = Object.keys(schema).find((k) => schema[k].name === 'Due')!
    expect(row1.args).toMatchObject({
      type: 'page',
      parent_id: collection.pointer.id,
      parent_table: 'collection',
      properties: {
        title: [['Write post']],
        [statusKey]: [['Done']],
        [dueKey]: [['‣', [['d', { type: 'date', start_date: '2026-11-03' }]]]],
      },
    })
    expect((row2.args as { properties: object }).properties).toEqual({ title: [['Plan offsite']] })
    expect(move).toEqual(moveToPrivate(pageId))
  })
})

describe('parseRow', () => {
  it('reads a name, an optional status, and an optional date', () => {
    expect(parseRow('Write post | Done | 2026-11-03')).toEqual({
      name: 'Write post',
      status: 'Done',
      due: '2026-11-03',
    })
    expect(parseRow('Plan offsite')).toEqual({ name: 'Plan offsite' })
    expect(parseRow('Fix billing||2026-11-08')).toEqual({ name: 'Fix billing', due: '2026-11-08' })
  })

  it('refuses rows the database could not hold', () => {
    expect(() => parseRow('')).toThrow('Not a row')
    expect(() => parseRow('a|Done|2026-11-03|x')).toThrow('Not a row')
    expect(() => parseRow('a|Blocked')).toThrow('Not a status')
    expect(() => parseRow('a|Done|tomorrow')).toThrow('Not a date')
  })
})

describe('findSpaceView', () => {
  const root = (userId: string, pointers: object[]) => ({
    user_root: {
      [userId]: { spaceId: 'x', value: { value: { id: userId, space_view_pointers: pointers }, role: 'editor' } },
    },
  })

  it('picks the user’s view of the workspace asked for', () => {
    const spaces = {
      [SPACE.userId]: root(SPACE.userId, [
        { id: 'view-other', spaceId: 'space-other', table: 'space_view' },
        { id: SPACE.spaceViewId, spaceId: SPACE.spaceId, table: 'space_view' },
      ]),
    }
    expect(findSpaceView(spaces, SPACE.spaceId)).toEqual(SPACE)
  })

  it('picks the only workspace when none is asked for, and refuses to guess among several', () => {
    const one = { [SPACE.userId]: root(SPACE.userId, [{ id: SPACE.spaceViewId, spaceId: SPACE.spaceId }]) }
    expect(findSpaceView(one)).toEqual(SPACE)
    const two = {
      [SPACE.userId]: root(SPACE.userId, [
        { id: SPACE.spaceViewId, spaceId: SPACE.spaceId },
        { id: 'view-other', spaceId: 'space-other' },
      ]),
    }
    expect(() => findSpaceView(two)).toThrow('several workspaces')
    expect(() => findSpaceView(two, 'space-missing')).toThrow("Couldn't find")
  })
})

describe('pageUrl', () => {
  it('links to the page on the tab’s host', () => {
    expect(pageUrl('https://app.notion.com/p/abc?pvs=1', '01234567-89ab-cdef-0123-456789abcdef')).toBe(
      'https://app.notion.com/p/0123456789abcdef0123456789abcdef',
    )
  })
})
