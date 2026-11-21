// Undoing what one question changed in Notion. Each write a tool sends is turned into what it
// changed, record by record, from the records the tool read before it wrote (the values before)
// and read back right after (the values the question left). Undoing re-reads those records, refuses
// if any of them changed since, and otherwise puts them back in one transaction: blocks the question
// added are deleted, pages and rows it created go to the trash, blocks it deleted come back where
// they were, and the property values (text, titles) and format (icons) it set are set back.
// What can't be undone this way (comments, moves, the trash, a database's properties) is named.
import { z } from '../zod'
import { blockOps, type Block, type NotionClient, type Operation, type RecordMap } from './api'
import { toUuid } from './hosts'

/** Values by key, as a record stores them; `null` where the key was not there. */
const Fields = z.record(z.string(), z.json())
type Fields = z.output<typeof Fields>

/**
 * What a question did to one block (a page is a block too). `page`: the page it is on, or itself
 * for a page, to name for the user. `created`: the question made it, under `parent` (in a page or
 * the workspace, or a database's collection for a row); `page` says it is a page or database, which
 * the undo moves to the trash, rather than content of a page, which it deletes. `removed`: the
 * question deleted it from `parent`, where it came after the blocks `after` and before the blocks
 * `before`, nearest first (several, as a neighbour may be gone or made by the question). `props` and
 * `format`: the values the question changed, as they were before it. `now`: what the question left,
 * as read back after its last write: the values it changed, or for a block it made, its properties
 * and content. Unset when it could not be read back: the block can't be checked, so nothing is undone.
 */
const Change = z.strictObject({
  id: z.string(),
  page: z.string(),
  created: z.strictObject({ parent: z.string(), table: z.enum(['block', 'collection']), page: z.boolean() }).optional(),
  removed: z.strictObject({ parent: z.string(), after: z.array(z.string()), before: z.array(z.string()) }).optional(),
  props: Fields.optional(),
  format: Fields.optional(),
  now: z.strictObject({ props: Fields, format: Fields, content: z.array(z.string()) }).optional(),
})
type Change = z.output<typeof Change>

/**
 * What one question changed in Notion, to undo it (saved with the chat). `space`: the workspace of
 * its changes. `titles`: the names of the pages they are on, as the tools saw them, by id.
 * `cannot`: what it changed that this can't undo, in words. `undone`: it was undone. `told`: the
 * model was told it was undone.
 */
export const QuestionChanges = z.strictObject({
  space: z.string(),
  changes: z.array(Change),
  titles: z.record(z.string(), z.string()),
  cannot: z.array(z.string()),
  undone: z.literal(true).optional(),
  told: z.literal(true).optional(),
})
export type QuestionChanges = z.output<typeof QuestionChanges>

/** Fields a write sets on every record it changes, which say nothing of what it changed. */
const EDITED = new Set(['last_edited_time', 'last_edited_by_id', 'last_edited_by_table'])
/** Block types that are pages of their own: made by a question, they go to the trash. */
const PAGES = new Set(['page', 'collection_view_page'])

/** What a refused undo says, and a change it says can't be undone. */
export class UndoError extends Error {}

export const PAGE_HISTORY = "Notion's page history (… → Page history on each page) can restore an earlier version."

const id = (raw: unknown): string => toUuid(String(raw)) ?? String(raw)

/**
 * The changes `operations` make to records as `before` held them, block by block, or undefined when
 * they hold a change this can't undo. `page`: the page they are on, when they are all on one;
 * otherwise each block is its own page, and a block made under another one made is on that one's.
 */
export function changesOf(operations: Operation[], before: RecordMap, page?: string): Change[] | undefined {
  const blocks = before.block ?? {}
  const changes = new Map<string, Change>()
  const made = new Set<string>()
  const removed = new Set<string>()
  const pageOf = (block: string, parent?: string) => page ?? (parent && changes.get(parent)?.page) ?? block
  for (const op of operations) {
    const target = id(op.pointer.id)
    const args = (op.args ?? {}) as Record<string, unknown>
    if (op.pointer.table !== 'block') {
      // A new database's collection and view go with its page.
      if (op.command === 'set' && !op.path.length && made.has(id(args.parent_id))) continue
      return undefined
    }
    const existing = (): Change | undefined => {
      if (made.has(target)) return undefined
      const block = blocks[target]
      if (!block) throw new UndoError('unread')
      let change = changes.get(target)
      if (!change) changes.set(target, (change = { id: target, page: page ?? target }))
      return change
    }
    try {
      switch (op.command) {
        case 'set': {
          if (op.path.length) return undefined
          const parent = id(args.parent_id)
          const table = args.parent_table === 'collection' ? 'collection' : 'block'
          const isPage = PAGES.has(String(args.type))
          changes.set(target, {
            id: target,
            page: isPage && !made.has(parent) ? target : pageOf(target, parent),
            created: { parent, table, page: isPage },
          })
          made.add(target)
          continue
        }
        case 'update': {
          if (op.path.length === 1 && op.path[0] === 'format') {
            const change = existing()
            if (!change) continue
            const was = blocks[target].format ?? {}
            change.format ??= {}
            for (const key of Object.keys(args)) if (!(key in change.format)) change.format[key] = json(was[key])
            continue
          }
          if (op.path.length) return undefined
          const keys = Object.keys(args).filter((key) => !EDITED.has(key))
          if (!keys.length) continue
          if (keys.length > 1 || keys[0] !== 'alive' || args.alive !== false) return undefined
          if (made.has(target)) {
            // Made and deleted by the same write: nothing left to undo of it.
            forgetMade(changes, made, target)
            removed.add(target)
            continue
          }
          const block = blocks[target]
          const parent = block?.parent_table === 'block' ? block.parent_id : undefined
          if (!block || !parent || !blocks[parent]) return undefined
          const change = existing()!
          change.removed = { parent, ...neighbours(blocks, parent, target) }
          removed.add(target)
          continue
        }
        case 'updateBlockPropertyValue': {
          const primitive = args.primitiveOp as { command?: unknown; args?: unknown } | undefined
          if (op.path.join('.') !== 'properties' || primitive?.command !== 'update') return undefined
          const change = existing()
          if (!change) continue
          const was = blocks[target].properties ?? {}
          change.props ??= {}
          for (const key of Object.keys(primitive.args ?? {}))
            if (!(key in change.props)) change.props[key] = json(was[key])
          continue
        }
        case 'listAfter':
        case 'listBefore':
          // Only blocks the write made are put in a list here; moving others isn't undone.
          if (made.has(id(args.id))) continue
          return undefined
        case 'listRemove':
          if (removed.has(id(args.id))) continue
          return undefined
        default:
          return undefined
      }
    } catch (err) {
      if (err instanceof UndoError) return undefined
      throw err
    }
  }
  return [...changes.values()]
}

/** A value Notion stored, as it is kept: JSON, with `null` for one not there; anything else can't be undone. */
function json(value: unknown): z.output<typeof Fields>[string] {
  if (value === undefined) return null
  const parsed = z.json().safeParse(value)
  if (!parsed.success) throw new UndoError('Notion stored a value that is not JSON.')
  return parsed.data
}

/** How many blocks on each side of a deleted one are kept, to find where it goes back. */
const NEIGHBOURS = 20

/** The blocks next to `child` in `parent`'s list, as read, nearest first: where it goes back. */
function neighbours(blocks: Record<string, Block>, parent: string, child: string) {
  const list = (blocks[parent].content ?? []).filter((c) => c === child || blocks[c]?.alive !== false)
  const at = list.indexOf(child)
  if (at < 0) return { after: [], before: [] }
  return {
    after: list.slice(Math.max(0, at - NEIGHBOURS), at).reverse(),
    before: list.slice(at + 1, at + 1 + NEIGHBOURS),
  }
}

/** Forgets a block the question made and then deleted, and the blocks made under it. */
function forgetMade(changes: Map<string, Change>, made: Set<string>, gone: string) {
  // All found first: a block's chain of parents goes through the ones forgotten.
  const forgotten = [...changes.values()].filter(
    (change) => change.created && (change.id === gone || isUnder(changes, change.id, gone)),
  )
  for (const change of forgotten) {
    changes.delete(change.id)
    made.delete(change.id)
  }
}

function isUnder(changes: Map<string, Change>, block: string, ancestor: string): boolean {
  for (let at = changes.get(block)?.created?.parent; at; at = changes.get(at)?.created?.parent)
    if (at === ancestor) return true
  return false
}

/**
 * The question's changes with a later write's `next` added: a block keeps what it was before the
 * question first changed it, so undoing goes back to that.
 */
export function merge(prior: Change[], next: Change[]): Change[] {
  const changes = new Map(prior.map((c) => [c.id, structuredClone(c)]))
  const made = new Set(prior.flatMap((c) => (c.created ? [c.id] : [])))
  for (const c of next) {
    const was = changes.get(c.id)
    if (!was) {
      changes.set(c.id, c)
      if (c.created) made.add(c.id)
      continue
    }
    if (c.removed) {
      if (was.created) {
        forgetMade(changes, made, c.id)
        continue
      }
      was.removed = c.removed
      was.now = undefined
      // Deletions stay in the order they were made, which undoing goes back through.
      changes.delete(c.id)
      changes.set(c.id, was)
    }
    if (was.created) continue
    for (const field of ['props', 'format'] as const) if (c[field]) was[field] = { ...c[field], ...was[field] }
  }
  return [...changes.values()]
}

/** The records whose state undoing checks: each changed block, and the lists blocks go back to. */
function pointersOf(changes: Change[]) {
  const ids = new Set(changes.flatMap((c) => [c.id, ...(c.removed ? [c.removed.parent] : [])]))
  return [...ids].map((id) => ({ table: 'block' as const, id }))
}

/**
 * Reads back the blocks among `changes` that a write changed or listed something in (`ids`, its
 * operations' records), as the question left them (see Change's `now`): from `known` when it has
 * them, from Notion otherwise.
 */
export async function readBack(
  client: NotionClient,
  space: string,
  changes: Change[],
  ids: Set<string>,
  known: RecordMap = {},
): Promise<Change[]> {
  const wanted = changes.filter((c) => ids.has(c.id) && !c.removed)
  const missing = wanted.filter((c) => !known.block?.[c.id])
  const read = missing.length
    ? await client.findRecords(
        missing.map((c) => ({ table: 'block' as const, id: c.id, spaceId: space })),
        { deleted: true },
      )
    : {}
  return changes.map((c) => {
    if (!wanted.includes(c)) return c
    const block = known.block?.[c.id] ?? read.block?.[c.id]
    if (!block || block.alive === false) return { ...c, now: undefined }
    const props = block.properties ?? {}
    const format = block.format ?? {}
    const now = c.created
      ? { props: pick(props), format: {}, content: block.content ?? [] }
      : {
          props: pick(props, Object.keys(c.props ?? {})),
          format: pick(format, Object.keys(c.format ?? {})),
          content: [],
        }
    return { ...c, now }
  })
}

function pick(values: Record<string, unknown>, keys = Object.keys(values)): Fields {
  return Object.fromEntries(keys.map((key) => [key, json(values[key])]))
}

/** Whether two stored values are the same; a key that is not there is the same as `null`. */
function same(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null
  if (b === undefined) b = null
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => same(v, b[i]))
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const keys = new Set([...Object.keys(x), ...Object.keys(y)])
  return [...keys].every((key) => same(x[key], y[key]))
}

const sameFields = (values: Record<string, unknown> | undefined, expected: Fields) =>
  Object.entries(expected).every(([key, value]) => same(values?.[key], value))

/** What undoing a question sends: the operations, and the pages among them that go to the trash. */
export interface UndoPlan {
  operations: Operation[]
  trashed: string[]
}

/**
 * Plans undoing `changes` from the records as they are now (`current`, read with deleted ones).
 * Refuses, with an UndoError naming the pages, when a block they changed has changed since:
 * nothing is then undone at all.
 */
export function planUndo(q: QuestionChanges, current: RecordMap, userId: string | undefined): UndoPlan {
  const blocks = current.block ?? {}
  const changed = new Set<string>()
  const unread = new Set<string>()
  const made = new Set(q.changes.flatMap((c) => (c.created ? [c.id] : [])))
  for (const c of q.changes) {
    const block = blocks[c.id]
    if (!block || (c.removed && !blocks[c.removed.parent])) {
      unread.add(c.page)
      continue
    }
    const ok = (() => {
      if (c.removed) {
        const parent = blocks[c.removed.parent]
        // Still deleted, and where it goes back is still there.
        return block.alive === false && !!parent && parent.alive !== false
      }
      if (block.alive === false || !c.now) return false
      if (c.created)
        return (
          block.parent_id === c.created.parent &&
          sameFields(block.properties, c.now.props) &&
          Object.keys(block.properties ?? {}).every((key) => key in c.now!.props) &&
          same(block.content ?? [], c.now.content)
        )
      return sameFields(block.properties, c.now.props) && sameFields(block.format, c.now.format)
    })()
    if (!ok) changed.add(c.page)
  }
  if (unread.size)
    throw new UndoError(
      `Nothing was undone: ${[...unread].map((p) => named(q, p)).join(', ')} can't be read with the Notion account ` +
        'of this tab. Open Notion signed in to the account the changes were made with, and undo again.',
    )
  if (changed.size)
    throw new UndoError(
      `Nothing was undone: ${[...changed].map((p) => named(q, p)).join(', ')} changed since, ` +
        `and undoing would overwrite that. ${PAGE_HISTORY}`,
    )

  const op = blockOps(q.space, Date.now(), userId)
  const operations: Operation[] = []
  const trashed: string[] = []
  const touched = new Set<string>()
  /** Each list as the operations so far leave it, so a block goes back next to the right one. */
  const lists = new Map<string, string[]>()
  const list = (parent: string) => {
    if (!lists.has(parent))
      lists.set(
        parent,
        (blocks[parent]?.content ?? []).filter((c) => !blocks[c] || blocks[c].alive !== false),
      )
    return lists.get(parent)!
  }
  // What the question made goes first, then what it deleted comes back around what is left.
  for (const c of q.changes) {
    if (!c.created || made.has(c.created.parent)) continue
    const { parent, table, page } = c.created
    if (page) {
      operations.push(...op.trash(table, parent, c.id))
      trashed.push(c.id)
    } else operations.push(...op.remove(parent, c.id))
    if (table === 'block') {
      const children = list(parent)
      if (children.includes(c.id)) children.splice(children.indexOf(c.id), 1)
      touched.add(parent)
    }
  }
  // Deleted blocks come back newest deletion first, so each finds the neighbours it had then.
  for (const c of q.changes.filter((c) => c.removed).reverse()) {
    const { parent, after: afterAll, before: beforeAll } = c.removed!
    const children = list(parent)
    const after = afterAll.find((b) => children.includes(b))
    const before = beforeAll.find((b) => children.includes(b))
    let at: number
    if (after) {
      operations.push(...op.restore(c.id, op.listAfter(parent, c.id, after)))
      at = children.indexOf(after) + 1
    } else if (before) {
      operations.push(...op.restore(c.id, op.listBefore(parent, c.id, before)))
      at = children.indexOf(before)
    } else if (!afterAll.length && children.length) {
      operations.push(...op.restore(c.id, op.listBefore(parent, c.id, children[0])))
      at = 0
    } else {
      operations.push(...op.restore(c.id, op.listAfter(parent, c.id)))
      at = children.length
    }
    children.splice(at, 0, c.id)
    touched.add(parent)
  }
  for (const c of q.changes) {
    if (c.created) continue
    if (c.props && Object.keys(c.props).length) operations.push(op.setProperties(c.id, c.props))
    if (c.format && Object.keys(c.format).length) operations.push(op.setFormat(c.id, c.format))
    if (!c.removed && (c.props || c.format)) touched.add(c.id)
  }
  for (const block of touched) if (!made.has(block)) operations.push(op.touch(block))
  return { operations, trashed }
}

/**
 * What of the undo did not land, read back after it (`current`, with deleted records): the pages
 * whose blocks are not as before the question. None when it all landed.
 */
export function notUndone(q: QuestionChanges, current: RecordMap): string[] {
  const blocks = current.block ?? {}
  const made = new Set(q.changes.flatMap((c) => (c.created ? [c.id] : [])))
  const off = new Set<string>()
  for (const c of q.changes) {
    const block = blocks[c.id]
    if (c.created) {
      if (made.has(c.created.parent)) continue
      const listed = c.created.table === 'block' && blocks[c.created.parent]?.content?.includes(c.id)
      if (block && block.alive !== false && (c.created.table !== 'block' || listed)) off.add(c.page)
      continue
    }
    if (!block || block.alive === false) {
      off.add(c.page)
      continue
    }
    if (c.removed && !blocks[c.removed.parent]?.content?.includes(c.id)) off.add(c.page)
    if (!sameFields(block.properties, c.props ?? {}) || !sameFields(block.format, c.format ?? {})) off.add(c.page)
  }
  return [...off].map((p) => named(q, p))
}

/** The records to read before undoing and after: the changed blocks and their lists. */
export function undoPointers(q: QuestionChanges) {
  const pointers = pointersOf(q.changes)
  for (const c of q.changes)
    if (c.created?.table === 'block' && !pointers.some((p) => p.id === c.created!.parent))
      pointers.push({ table: 'block', id: c.created.parent })
  return pointers.map((p) => ({ ...p, spaceId: q.space }))
}

/** A page as the user is told of it: its title as the tools saw it, or "a page". */
function named(q: QuestionChanges, page: string): string {
  const title = q.titles[page]?.trim()
  return title ? `“${title}”` : 'a page'
}

/**
 * What undoing a question does, in words, one line each: for the user before they agree, and the
 * model. Ends with what it can't undo, if anything.
 */
export function describeUndo(q: QuestionChanges): string[] {
  const made = new Set(q.changes.flatMap((c) => (c.created ? [c.id] : [])))
  const byPage = new Map<string, { trash: boolean; added: number; restored: number; values: number }>()
  for (const c of q.changes) {
    if (c.created && made.has(c.created.parent)) continue
    const at = byPage.get(c.page) ?? { trash: false, added: 0, restored: 0, values: 0 }
    byPage.set(c.page, at)
    if (c.created?.page) at.trash = true
    else if (c.created) at.added++
    if (c.removed) at.restored++
    if (!c.created) at.values += Object.keys(c.props ?? {}).length + Object.keys(c.format ?? {}).length
  }
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  const lines = [...byPage].map(([page, at]) => {
    if (at.trash) return `Move ${named(q, page)}, which it created, to the trash`
    const parts = [
      at.added && `delete ${n(at.added, 'block', 'blocks')} it added`,
      at.restored && `bring back ${n(at.restored, 'block', 'blocks')} it deleted`,
      at.values && `set back ${n(at.values, 'value', 'values')} it changed (text, titles, icons, properties)`,
    ].filter(Boolean)
    const text = parts.join(', ')
    return `On ${named(q, page)}: ${text}`
  })
  if (q.cannot.length) lines.push(`Not undone: ${q.cannot.join('; ')}`)
  return lines
}

/** Whether undoing the question would change anything. */
export function undoable(q: QuestionChanges): boolean {
  return !q.undone && q.changes.length > 0
}
