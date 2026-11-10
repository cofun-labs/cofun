// Planning an edit_page call: checking the edits against the page as the agent read it and as it
// is now, and turning them into one Notion transaction. Nothing here talks to Notion.
import { blockOps, type Block, type LoadedPage, type NotionRecord, type Operation } from './api'
import {
  COLOR,
  HEADING_TYPES,
  MarkdownError,
  TEXT_TYPES,
  notionLanguage,
  parseMarkdown,
  withPeople,
  type NewBlock,
  type RichText,
} from './blocks'
import { PAGE_TYPES, formatDate, hexId, type PageMarkdown } from './markdown'

/**
 * What the agent saw of a page: the references it was shown, and the version of each block it saw.
 * Only blocks the agent was actually shown are here, so an edit can't overwrite one it never saw.
 */
export interface PageRead {
  pageId: string
  title: string
  /** Block id by the reference read_page showed for it (and by full id). */
  ids: Map<string, string>
  /** Reference by block id. */
  refs: Map<string, string>
  versions: Map<string, number>
  /** The line each block showed as, for previews. */
  lines: Map<string, string>
  /** The blocks nested under each block, at any depth, as the page was read. */
  nested: Map<string, string[]>
  /** Blocks whose text has formatting edit_page can't write back (mentions, colors, …). */
  lossy?: Set<string>
}

/**
 * The blocks of `md` the agent saw: those `include` picks, such as the blocks a part drew. Only
 * those `whole` passes were seen in full, so only those can be changed.
 */
export function pageRead(
  loaded: LoadedPage,
  md: PageMarkdown,
  include: (id: string) => boolean,
  whole: (id: string) => boolean = () => true,
): PageRead {
  const blocks = (loaded.recordMap.block ?? {}) as Record<string, Block>
  const seen = include
  const refs = new Map([...md.refs].filter(([id]) => seen(id)))
  const versions = new Map<string, number>()
  const nested = new Map<string, string[]>()
  for (const id of [loaded.page.id, ...refs.keys()]) {
    if (blocks[id] && (id === loaded.page.id || whole(id))) versions.set(id, blocks[id].version)
  }
  // Table rows and layout columns are drawn as part of the block around them, without references
  // of their own; they were seen with it.
  for (const id of refs.keys()) {
    for (const d of descendants(blocks, id)) {
      if (DRAWN_WITH_PARENT.has(blocks[d].type)) versions.set(d, blocks[d].version)
    }
  }
  for (const id of refs.keys()) nested.set(id, descendants(blocks, id))
  return {
    pageId: loaded.page.id,
    title: md.title,
    ids: idsFor(refs),
    refs,
    versions,
    lines: new Map([...md.lines].filter(([id]) => refs.has(id))),
    nested,
    lossy: new Set(
      [...refs.keys()].filter((id) =>
        blocks[id]?.type === 'table'
          ? lossyTable(blocks, blocks[id], md.lines.get(id), loaded.recordMap.notion_user)
          : TEXT_TYPES.has(blocks[id]?.type) &&
            lossyText(blocks[id].properties?.title, md.lines.get(id), loaded.recordMap.notion_user),
      ),
    ),
  }
}

/** Adds what the agent saw later to what it saw before; later versions win. */
export function mergeReads(base: PageRead | undefined, later: PageRead): PageRead {
  if (!base || base.pageId !== later.pageId) return later
  const refs = new Map(base.refs)
  for (const [id, ref] of later.refs) {
    // The latest read keeps the short reference it just showed; an older block that had it
    // falls back to its full id.
    const taken = base.ids.get(ref)
    if (taken && taken !== id) refs.set(taken, hexId(taken))
    refs.set(id, ref)
  }
  return {
    pageId: base.pageId,
    title: later.title,
    ids: idsFor(refs),
    refs,
    versions: new Map([...base.versions, ...later.versions]),
    lines: new Map([...base.lines, ...later.lines]),
    nested: new Map([...base.nested, ...later.nested]),
    lossy: new Set([...[...(base.lossy ?? [])].filter((id) => !later.refs.has(id)), ...(later.lossy ?? [])]),
  }
}

/** Removes blocks that no longer exist from a read. */
export function forget(read: PageRead, ids: Iterable<string>): PageRead {
  const gone = new Set(ids)
  const keep = <V>(m: Map<string, V>) => new Map([...m].filter(([id]) => !gone.has(id)))
  const refs = keep(read.refs)
  return {
    ...read,
    refs,
    ids: idsFor(refs),
    versions: keep(read.versions),
    lines: keep(read.lines),
    nested: keep(read.nested),
    lossy: new Set([...(read.lossy ?? [])].filter((id) => !gone.has(id))),
  }
}

function idsFor(refs: Map<string, string>): Map<string, string> {
  // Short references, and full ids, which read_page shows for child pages and databases.
  return new Map([...refs].flatMap(([id, ref]) => [[ref, id] as const, [hexId(id), id] as const]))
}

const DRAWN_WITH_PARENT = new Set(['table_row', 'column_list', 'column'])
/** The original of a synced block; its copies on other pages show its content. */
const SYNCED_ORIGINAL = 'transclusion_container'

/** The alive blocks under `id`, at any depth, not looking inside child pages. */
function descendants(blocks: Record<string, Block>, id: string): string[] {
  const out: string[] = []
  const visit = (parent: string) => {
    for (const child of blocks[parent]?.content ?? []) {
      const block = blocks[child]
      if (!block || block.alive === false) continue
      out.push(child)
      if (!PAGE_TYPES.has(block.type)) visit(child)
    }
  }
  if (blocks[id] && !PAGE_TYPES.has(blocks[id].type)) visit(id)
  return out
}

/** Whether any block under `id` is named by its parent but missing from what was loaded. */
function hasUnloaded(blocks: Record<string, Block>, id: string): boolean {
  const block = blocks[id]
  if (!block || PAGE_TYPES.has(block.type)) return false
  return (block.content ?? []).some(
    (child) => !blocks[child] || (blocks[child].alive !== false && hasUnloaded(blocks, child)),
  )
}

/** The edit can't be made as asked; nothing was written. The message says why, for the model. */
export class EditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditError'
  }
}

export const READ_AGAIN = 'Read the page again with read_page, then redo the edit on what it shows now.'

/** One edit as the model asks for it. */
export interface EditArgs {
  action?: unknown
  block?: unknown
  position?: unknown
  markdown?: unknown
}

/** `people`: the user id of each person the edit's Markdown mentions, by the name it gives. */
export type Edit =
  | {
      action: 'insert'
      anchor?: string
      /** `inside`: at the start of what is nested in `anchor`. */
      position: 'after' | 'start' | 'end' | 'inside'
      markdown: string
      blocks: NewBlock[]
      people?: Map<string, string>
    }
  | { action: 'replace'; target: string; markdown: string; blocks: NewBlock[]; people?: Map<string, string> }
  | { action: 'delete'; target: string }

/** Checks the edits and resolves their references against the agent's read, before asking Notion anything. */
export function parseEdits(raw: unknown, read: PageRead): Edit[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new EditError('`edits` must be a list with at least one edit.')
  const touched = new Set<string>()
  const anchors = new Set<string>()
  const edits = raw.map((value, n): Edit => {
    const e = (value ?? {}) as EditArgs
    const where = `Edit ${n + 1}`
    const markdown = () => {
      if (typeof e.markdown !== 'string' || !e.markdown.trim()) throw new EditError(`${where} needs \`markdown\`.`)
      try {
        const blocks = parseMarkdown(e.markdown)
        if (!blocks.length) throw new EditError(`${where} needs \`markdown\` with some content.`)
        return { markdown: e.markdown, blocks }
      } catch (err) {
        if (err instanceof MarkdownError) throw new EditError(`${where}: ${err.message}`)
        throw err
      }
    }
    const block = () => {
      if (typeof e.block !== 'string' || !e.block.trim()) {
        throw new EditError(`${where} needs \`block\`, a reference such as ^1a2b3c4d.`)
      }
      const ref = e.block.trim().replace(/^\^/, '').toLowerCase()
      const id = read.ids.get(ref)
      if (!id) throw new EditError(`${where}: ^${ref} is not a block of the page as you last read it. ${READ_AGAIN}`)
      return id
    }
    switch (e.action) {
      case 'insert': {
        // null and '' mean "not given", as models often fill optional fields.
        const given = (v: unknown) => v !== undefined && v !== null && v !== ''
        const position = given(e.position) ? e.position : given(e.block) ? 'after' : 'end'
        if (position !== 'after' && position !== 'start' && position !== 'end' && position !== 'inside') {
          throw new EditError(`${where}: \`position\` must be "after", "inside", "start", or "end".`)
        }
        const anchor = position === 'after' || position === 'inside' ? block() : undefined
        if (anchor) anchors.add(anchor)
        return { action: 'insert', anchor, position, ...markdown() }
      }
      case 'replace':
      case 'delete': {
        const target = block()
        if (touched.has(target))
          throw new EditError(`${where}: ^${read.refs.get(target)} is changed by another edit too.`)
        touched.add(target)
        return e.action === 'replace' ? { action: 'replace', target, ...markdown() } : { action: 'delete', target }
      }
      default:
        throw new EditError(`${where}: \`action\` must be "insert", "replace", or "delete".`)
    }
  })
  for (const anchor of anchors) {
    if (touched.has(anchor)) {
      throw new EditError(
        `^${read.refs.get(anchor)} is replaced or deleted, so nothing can be inserted after or inside it in the same call.`,
      )
    }
  }
  return edits
}

export interface Plan {
  operations: Operation[]
  /** Ids of the top-level blocks created, in order. */
  created: string[]
  /** Every block created, nested ones too. */
  createdAll: string[]
  /** Blocks deleted, with what was nested under them. */
  deleted: string[]
  /** Blocks whose content or fields this edit changed (not counting created or deleted ones). */
  changed: string[]
  /** What the edit does, one line per edit, for the result. */
  summary: string[]
}

/**
 * Rich text marks edit_page writes back; others (comments, underlines, …) it can't. A mention of a
 * person (`u`) is written back when the person's name is known, as read_page then shows it.
 */
const WRITABLE_MARKS = new Set(['b', 'i', 's', 'c', 'a', 'p', 'd', 'e'])
/** Marks read_page shows a run by alone, dropping its color. */
const ALONE_MARKS = new Set(['p', 'lm', 'd', 'e'])

/** What becomes of formatting edit_page can't write back when text is rewritten. */
const LOST =
  "what read_page didn't show exactly (comments, underlines, people it can't name, and the like) is now as it was shown."

/** Blocks that show what is nested in them; a heading does only as a toggle heading. */
const HOLDERS = new Set(['text', 'bulleted_list', 'numbered_list', 'to_do', 'toggle', 'quote', 'callout'])

/**
 * Turns edits into operations on the page as it is now (`loaded`), refusing them if a block they
 * touch changed or went away since the agent read it.
 */
export function planEdit(
  loaded: LoadedPage,
  read: PageRead,
  edits: Edit[],
  { now = Date.now(), newId = () => crypto.randomUUID() } = {},
): Plan {
  const blocks = (loaded.recordMap.block ?? {}) as Record<string, Block>
  const { page, spaceId } = loaded
  const ref = (id: string) => `^${read.refs.get(id) ?? hexId(id)}`
  const check = (id: string, what = ref(id)) => {
    const block = blocks[id]
    // Shown as "[block not loaded]": reading again shows the same, so don't ask for that.
    if (!block && !read.versions.has(id)) throw new EditError(`${what} wasn't loaded, so it can't be edited.`)
    if (!block || block.alive === false) {
      throw new EditError(`${what} was deleted since you read the page. ${READ_AGAIN}`)
    }
    if (!read.versions.has(id)) {
      throw new EditError(
        `${what} wasn't shown to you in full: read each part of the page it is in, then redo the edit.`,
      )
    }
    if (block.version !== read.versions.get(id)) {
      throw new EditError(`${what} was changed since you read the page. ${READ_AGAIN}`)
    }
  }

  // Every block an edit points at must be as the agent read it, and so must everything a delete
  // removes with it.
  const deleted = new Set<string>()
  for (const e of edits) {
    const id = e.action === 'insert' ? e.anchor : e.target
    if (!id) continue
    check(id)
    if (e.action !== 'delete') continue
    // A page that didn't load in full may hide blocks under the target: don't delete what wasn't seen.
    if (hasUnloaded(blocks, e.target)) {
      throw new EditError(`${ref(e.target)} has nested blocks that weren't loaded, so it can't be deleted.`)
    }
    for (const d of descendants(blocks, e.target)) {
      if (PAGE_TYPES.has(blocks[d].type)) {
        throw new EditError(`${ref(e.target)} has a child page or database nested under it, so it can't be deleted.`)
      }
      if (blocks[d].type === SYNCED_ORIGINAL) {
        throw new EditError(`${ref(e.target)} has a synced block nested under it, so it can't be deleted.`)
      }
      check(d, `${ref(d)}, nested under ${ref(e.target)},`)
      deleted.add(d)
    }
    deleted.add(e.target)
  }
  // Blocks nested under a block this call deletes: nothing else in the call may touch them.
  const nestedUnderDeletes = new Set(edits.flatMap((e) => (e.action === 'delete' ? descendants(blocks, e.target) : [])))
  for (const e of edits) {
    const id = e.action === 'insert' ? e.anchor : e.target
    if (id && nestedUnderDeletes.has(id)) throw new EditError(`${ref(id)} is inside a block this call deletes.`)
  }

  const ops: Operation[] = []
  const created: string[] = []
  const createdAll: string[] = []
  const summary: string[] = []
  const changed = new Set<string>([page.id])
  const op = blockOps(spaceId, now, loaded.userId)
  /** Where the next block inserted at each place goes: after the last one inserted there. */
  const tails = new Map<string, string>()

  const parentOf = (id: string): Block => {
    const block = blocks[id]
    const parent = block.parent_table === 'block' && block.parent_id ? blocks[block.parent_id] : undefined
    if (!parent) throw new EditError(`${ref(id)} is not inside a block that can hold new content.`)
    return parent
  }
  // Blocks that weren't loaded stay in the list: inserting at the start goes before them too.
  const aliveChildren = (block: Block) =>
    (block.content ?? []).filter((id) => !blocks[id] || blocks[id].alive !== false)
  /** Each parent's list of children as this plan's operations leave it, so anchors are always current. */
  const lists = new Map<string, string[]>()
  const list = (parent: Block) => {
    if (!lists.has(parent.id)) lists.set(parent.id, aliveChildren(parent))
    return lists.get(parent.id)!
  }

  /** Creates `newBlocks` in `parent`, after `after` (or at the start or end). Returns the new top-level ids. */
  const insert = (newBlocks: NewBlock[], parent: Block, place: { after?: string; start?: boolean; key: string }) => {
    const ids: string[] = []
    for (const nb of newBlocks) {
      const id = create(nb, parent.id)
      const prev = tails.get(place.key) ?? place.after
      const children = list(parent)
      if (prev) {
        ops.push(op.listAfter(parent.id, id, prev))
        children.splice(children.indexOf(prev) + 1, 0, id)
      } else if (place.start && children.length) {
        ops.push(op.listBefore(parent.id, id, children[0]))
        children.unshift(id)
      } else {
        ops.push(op.listAfter(parent.id, id))
        children.push(id)
      }
      tails.set(place.key, id)
      ids.push(id)
    }
    changed.add(parent.id)
    return ids
  }

  const create = (nb: NewBlock, parentId: string): string => {
    return createBlock(op, ops, nb, parentId, newId, (id) => createdAll.push(id))
  }

  const remove = (id: string) => {
    const parent = parentOf(id)
    // Notion's editor removes a column once it is empty; these operations can't, so don't empty one.
    if (parent.type === 'column' && list(parent).filter((c) => c !== id).length === 0) {
      throw new EditError(
        `${ref(id)} is the last block in its column; edit_page can't remove columns. Replace it instead.`,
      )
    }
    ops.push(...op.remove(parent.id, id))
    const children = list(parent)
    if (children.includes(id)) children.splice(children.indexOf(id), 1)
    changed.add(parent.id)
  }

  /** Whether rewriting `block` loses something read_page didn't show exactly. */
  const lossy = (block: Block): boolean => {
    const users = loaded.recordMap.notion_user
    if (block.type !== 'table') return lossyText(block.properties?.title, read.lines.get(block.id), users)
    return lossyTable(blocks, block, read.lines.get(block.id), users)
  }

  /** The cells of a table as read_page showed them, parsed, row by row; none if they can't be. */
  const shownRows = (table: Block): RichText[][] | undefined => {
    try {
      return parseMarkdown(read.lines.get(table.id) ?? '')[0]?.rows
    } catch (err) {
      if (!(err instanceof MarkdownError)) throw err
      return undefined
    }
  }

  /**
   * Rewrites a table in place from `nb`. Columns are matched to the table's by their header cell,
   * and rows by their cells in those columns, so a row or column added or removed anywhere keeps
   * the others where they are; what doesn't match between two matches is changed in place, in
   * order. Cells the agent passed back as read_page showed them keep what they hold.
   */
  const rewriteTable = (table: Block, rows: string[], nb: NewBlock, people: Map<string, string>): string => {
    const tableRef = ref(table.id)
    const columns = (table.format?.table_block_column_order as string[] | undefined) ?? []
    const shown = rows.length ? shownRows(table) : []
    if (!shown || shown.length !== rows.length || shown.some((r) => r.length !== columns.length)) {
      throw new EditError(`${tableRef} isn't as read_page showed it. ${READ_AGAIN}`)
    }
    const key = (cell: RichText) => JSON.stringify(cell)
    const shownKeys = shown.map((row) => row.map((cell) => key(withPeople(cell, people, { keep: true }))))
    const newRows = nb.rows ?? []

    const oldHeads = columns.map((_, c) => shownKeys[0]?.[c] ?? '')
    const newHeads = (newRows[0] ?? []).map(key)
    /** For each new column, its index in the table as read, if it was there. */
    const was: (number | undefined)[] = newHeads.map(() => undefined)
    for (const p of align(oldHeads, newHeads)) if (p.a !== undefined && p.b !== undefined) was[p.b] = p.a
    // A column moved elsewhere is matched by its header too, so its cells move with it.
    newHeads.forEach((head, b) => {
      if (was[b] !== undefined) return
      const a = oldHeads.findIndex((h, n) => h === head && !was.includes(n))
      if (a >= 0) was[b] = a
    })
    const order = was.map((a) => (a === undefined ? columnId(newId) : columns[a]))
    const removedColumns = columns.filter((_, n) => !was.includes(n))
    const both = was.flatMap((a, b) => (a === undefined ? [] : [{ a, b }]))
    const rowPairs = align(
      shownKeys.map((row) => JSON.stringify(both.map((p) => row[p.a!]))),
      newRows.map((row) => JSON.stringify(both.map((p) => key(row[p.b!])))),
    )
    const counts = {
      cells: 0,
      rowsAdded: 0,
      rowsRemoved: 0,
      columnsAdded: was.filter((a) => a === undefined).length,
      columnsRemoved: removedColumns.length,
    }
    if (order.length !== columns.length || order.some((c, n) => c !== columns[n])) {
      ops.push(op.setFormat(table.id, { table_block_column_order: order }))
    }

    const users = loaded.recordMap.notion_user
    let lostCells = false
    let lostRows = false
    let prev: string | undefined
    const removed: string[] = []
    for (const p of rowPairs) {
      if (p.b === undefined) {
        removed.push(rows[p.a!])
        continue
      }
      const cells = newRows[p.b]
      if (p.a === undefined) {
        const id = createRow(op, ops, cells, order, table.id, newId)
        createdAll.push(id)
        // Before the first row when nothing comes before it; rows are removed only after this.
        ops.push(prev || !rows.length ? op.listAfter(table.id, id, prev) : op.listBefore(table.id, id, rows[0]))
        prev = id
        counts.rowsAdded++
        continue
      }
      const row = rows[p.a]
      const values: Record<string, unknown> = {}
      order.forEach((column, c) => {
        const cell = cells[c]
        if (was[c] !== undefined && shownKeys[p.a!][was[c]!] === key(cell)) return
        const old = blocks[row].properties?.[column]
        if (key((old ?? []) as RichText) === key(cell)) return
        if (lossyRich(old, was[c] === undefined ? [] : shown[p.a!][was[c]!], users)) lostCells = true
        values[column] = keepDates(cell, [old])
      })
      if (Object.keys(values).length) {
        ops.push(op.setProperties(row, values))
        changed.add(row)
        counts.cells += Object.keys(values).length
      }
      prev = row
    }
    for (const row of removed) {
      if (Object.values(blocks[row].properties ?? {}).some((v) => hasUnwritableMarks(v, users))) lostRows = true
      ops.push(...op.remove(table.id, row))
      deleted.add(row)
      counts.rowsRemoved++
    }
    // A removed column's cells stay in its rows, but the table no longer shows them.
    const lostColumns = rows.some((row) =>
      removedColumns.some((c) => hasUnwritableMarks(blocks[row].properties?.[c], users)),
    )

    const n = (count: number, what: string, done: string) =>
      count ? `${count} ${what}${count === 1 ? '' : 's'} ${done}` : ''
    const parts = [
      n(counts.cells, 'cell', 'changed'),
      n(counts.rowsAdded, 'row', 'added'),
      n(counts.rowsRemoved, 'row', 'removed'),
      n(counts.columnsAdded, 'column', 'added'),
      n(counts.columnsRemoved, 'column', 'removed'),
      both.some((p, i) => i > 0 && p.a < both[i - 1].a) ? 'columns moved' : '',
    ].filter(Boolean)
    if (!parts.length) return `${tableRef} already had that content; nothing changed.`
    changed.add(table.id)
    return (
      `Rewrote the table ${tableRef}: ${parts.join(', ')}.` +
      (lostCells ? ` In the cells it changed, ${LOST}` : '') +
      (lostRows
        ? " Rows it removed held formatting read_page doesn't show (such as comments); the page's history in " +
          'Notion can bring them back.'
        : '') +
      (lostColumns
        ? " Columns it removed held formatting read_page doesn't show (such as comments); the page's history in " +
          'Notion can bring them back.'
        : '')
    )
  }

  for (const e of edits) {
    if (e.action === 'insert') {
      // The end of a page that didn't load in full is past blocks nobody was shown.
      if (e.position === 'end' && !loaded.complete) {
        throw new EditError("The page didn't load in full, so its end isn't known. Insert after a block instead.")
      }
      if (e.position === 'inside') {
        const holder = blocks[e.anchor!]
        const toggle = HEADING_TYPES.has(holder.type) && holder.format?.toggleable === true
        if (!HOLDERS.has(holder.type) && !toggle) {
          throw new EditError(
            `${ref(holder.id)} can't hold nested blocks (it is ${PAGE_TYPES.has(holder.type) ? 'a page of its own' : `a ${holder.type} block`}). Insert after it instead.`,
          )
        }
        const ids = insert(e.blocks, holder, { start: true, key: `inside:${holder.id}` })
        created.push(...ids)
        summary.push(
          `Inserted ${ids.length} block${ids.length === 1 ? '' : 's'} at the start of ${ref(holder.id)}, nested in it.`,
        )
        continue
      }
      const parent = e.anchor ? parentOf(e.anchor) : page
      const key = e.anchor ?? e.position
      const ids = insert(e.blocks, parent, { after: e.anchor, start: e.position === 'start', key })
      created.push(...ids)
      const where = e.anchor ? `after ${ref(e.anchor)}` : `at the ${e.position} of the page`
      summary.push(`Inserted ${ids.length} block${ids.length === 1 ? '' : 's'} ${where}.`)
      continue
    }
    const target = blocks[e.target]
    if (PAGE_TYPES.has(target.type)) {
      throw new EditError(`${ref(e.target)} is a child page or database; edit_page can't change or delete it.`)
    }
    if (target.type === SYNCED_ORIGINAL) {
      // Deleting the original of a synced block removes it from every page that shows a copy.
      throw new EditError(
        `${ref(e.target)} is a synced block shown on other pages too; edit_page can't change or delete it.`,
      )
    }
    if (e.action === 'delete') {
      const nested = descendants(blocks, e.target).length
      remove(e.target)
      summary.push(
        `Deleted ${ref(e.target)}${nested ? ` and the ${nested} block${nested === 1 ? '' : 's'} nested under it` : ''}.`,
      )
      continue
    }
    if (target.type === 'table') {
      // A table's rows are drawn with it: each must be as the agent read it.
      if ((target.content ?? []).some((r) => !blocks[r])) {
        throw new EditError(`${ref(e.target)} has rows that weren't loaded, so it can't be rewritten.`)
      }
      const rows = aliveChildren(target)
      for (const r of rows) check(r, `A row of ${ref(e.target)}`)
      const [only] = e.blocks
      if (e.blocks.length === 1 && only.type === 'table') {
        summary.push(rewriteTable(target, rows, only, e.people ?? new Map()))
        continue
      }
    } else if (!TEXT_TYPES.has(target.type)) {
      throw new EditError(
        `${ref(e.target)} is content edit_page can't rewrite (${target.type}). Delete it if that's what you mean.`,
      )
    }
    const [only] = e.blocks
    if (e.blocks.length === 1 && only.type === target.type && !only.children.length) {
      // A caption passed back as read_page showed it is kept; a new or changed one can't be written.
      if (only.caption !== undefined && only.caption !== shownCaption(read.lines.get(target.id))) {
        throw new EditError(
          `${ref(e.target)}: code block captions can't be changed yet. Keep the [caption: …] line as read_page ` +
            'showed it, or leave it out; the block keeps its caption.',
        )
      }
      // The same kind of block: change it in place, keeping its id, children, and comments, and
      // only the fields that differ, so text the agent didn't change keeps what can't be written.
      const values = changedProperties(target, only, read.lines.get(target.id), e.people ?? new Map())
      if (values.title) values.title = keepDates(values.title as RichText, [target.properties?.title])
      if (Object.keys(values).length) {
        ops.push(op.setProperties(target.id, values))
      }
      const icon = only.type === 'callout' && only.icon && only.icon !== target.format?.page_icon
      if (icon) ops.push(op.setFormat(target.id, { page_icon: only.icon }))
      if (!Object.keys(values).length && !icon) {
        // The same content: nothing to write, and the block stays as the agent read it.
        summary.push(`${ref(e.target)} already had that content; nothing changed.`)
        continue
      }
      changed.add(target.id)
      const lost = values.title && lossy(target)
      summary.push(`Replaced the text of ${ref(e.target)}.` + (lost ? ` In its old text, ${LOST}` : ''))
      continue
    }
    // Anything nested, loaded or not, would go with the old block (a table's rows, checked above,
    // are part of it).
    if (target.type !== 'table' && (target.content ?? []).some((c) => !blocks[c] || blocks[c].alive !== false)) {
      throw new EditError(
        `${ref(e.target)} has nested blocks. Replace it with one block of the same kind and no nested lines, ` +
          'and change the nested blocks by their own references.',
      )
    }
    const dated = withDates(e.blocks, [target.properties?.title])
    const ids = insert(dated, parentOf(e.target), { after: e.target, key: e.target })
    remove(e.target)
    created.push(...ids)
    deleted.add(e.target)
    summary.push(
      `Replaced ${ref(e.target)} with ${ids.length} new block${ids.length === 1 ? '' : 's'}.` +
        (lossy(target) ? ` In its old ${target.type === 'table' ? 'cells' : 'text'}, ${LOST}` : ''),
    )
  }

  // Nothing to change (every edit was a no-op): no write at all, not even a touch.
  if (ops.length) {
    for (const id of changed) {
      if (deleted.has(id) || blocks[id]?.alive === false) continue
      ops.push(op.touch(id))
    }
  }
  return {
    operations: ops,
    created,
    createdAll,
    deleted: [...deleted],
    changed: [...changed].filter((id) => !deleted.has(id)),
    summary,
  }
}

/** The property values of a rewritten block that differ from the block as it is. */
function changedProperties(
  target: Block,
  nb: NewBlock,
  shownLine: string | undefined,
  people: Map<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (nb.type === 'code') {
    const code = runsText(target.properties?.title)
    if (code !== runsText(nb.title)) out.title = nb.title
    const language = runsText(target.properties?.language)
    if (nb.language && nb.language.toLowerCase() !== language.toLowerCase())
      out.language = [[notionLanguage(nb.language)]]
    return out
  }
  if (nb.type !== 'divider') {
    // The same Markdown as read_page showed means the same text: keep the stored text as it is.
    let before: NewBlock | undefined
    try {
      before = shownLine ? parseMarkdown(shownLine)[0] : undefined
      // People named as the new text names them; a person it no longer names stays a name, so the
      // text differs.
      if (before) before = { ...before, title: withPeople(before.title, people, { keep: true }) }
    } catch (err) {
      // Not Markdown that can be written back: treat the text as changed.
      if (!(err instanceof MarkdownError)) throw err
    }
    if (!before || JSON.stringify(before.title) !== JSON.stringify(nb.title)) out.title = nb.title
  }
  if (nb.type === 'to_do') {
    const checked = runsText(target.properties?.checked) === 'Yes'
    if (checked !== !!nb.checked) out.checked = [[nb.checked ? 'Yes' : 'No']]
  }
  return out
}

/** The caption read_page showed after a code block (the last line of its Markdown), if any. */
function shownCaption(shown: string | undefined): string | undefined {
  return /^\[caption: (.*)\]$/.exec(shown?.split('\n').at(-1)?.trim() ?? '')?.[1]
}

function runsText(value: unknown): string {
  return Array.isArray(value) ? value.map((r) => (Array.isArray(r) ? String(r[0]) : '')).join('') : ''
}

function hasUnwritableMarks(value: unknown, users: Record<string, NotionRecord> = {}): boolean {
  const named = (id: unknown) => typeof users[String(id)]?.name === 'string' && !!users[String(id)].name
  // read_page shows a mention without its link or code, so such a mention isn't written back whole.
  const writable = (m: unknown[], marks: unknown[][]) => {
    if (m[0] === 'u') return named(m[1]) && !marks.some((o) => o[0] === 'a' || o[0] === 'c')
    // read_page shows a color unless the run is shown by one mark alone (a page or a date, say).
    if (m[0] === 'h')
      return typeof m[1] === 'string' && COLOR.test(m[1]) && !marks.some((o) => ALONE_MARKS.has(String(o[0])))
    return WRITABLE_MARKS.has(String(m[0]))
  }
  return (
    Array.isArray(value) &&
    value.some(
      (r) => Array.isArray(r) && Array.isArray(r[1]) && r[1].some((m: unknown[]) => !writable(m, r[1] as unknown[][])),
    )
  )
}

/**
 * Whether rewriting text loses something: formatting edit_page can't write, or text read_page
 * showed in a way that doesn't parse back to what is stored (a date mention followed by a time
 * written as text, say).
 */
function lossyText(stored: unknown, shown: string | undefined, users: Record<string, NotionRecord> = {}): boolean {
  if (hasUnwritableMarks(stored, users)) return true
  if (!Array.isArray(stored) || !stored.length) return false
  let title: RichText | undefined
  try {
    title = shown === undefined ? undefined : parseMarkdown(shown)[0]?.title
  } catch (err) {
    if (!(err instanceof MarkdownError)) throw err
  }
  return lossyRich(stored, title, users)
}

/**
 * Whether replacing a table loses something read_page didn't show exactly in its cells, given
 * `shown`, the table's Markdown as read_page showed it.
 */
function lossyTable(
  blocks: Record<string, Block>,
  table: Block,
  shown: string | undefined,
  users: Record<string, NotionRecord> = {},
): boolean {
  const columns = (table.format?.table_block_column_order as string[] | undefined) ?? []
  let rows: RichText[][] | undefined
  try {
    rows = parseMarkdown(shown ?? '')[0]?.rows
  } catch (err) {
    if (!(err instanceof MarkdownError)) throw err
  }
  const alive = (table.content ?? []).filter((r) => blocks[r]?.alive !== false)
  return alive.some((r, n) =>
    Object.entries(blocks[r]?.properties ?? {}).some(([column, value]) => {
      const c = columns.indexOf(column)
      // A cell of a column the table no longer shows isn't shown at all.
      return c < 0 ? hasUnwritableMarks(value, users) : lossyRich(value, rows?.[n]?.[c], users)
    }),
  )
}

/**
 * Whether rewriting stored rich text loses something, given `shown`, the rich text read_page's
 * Markdown for it parses to (a table cell's, say); none means it couldn't be parsed.
 */
function lossyRich(stored: unknown, shown: RichText | undefined, users: Record<string, NotionRecord> = {}): boolean {
  if (hasUnwritableMarks(stored, users)) return true
  if (!Array.isArray(stored) || !stored.length) return false
  if (!shown) return true
  const ids = new Map(
    Object.entries(users).flatMap(([id, u]) => (typeof u.name === 'string' && u.name ? [[u.name, id] as const] : [])),
  )
  return canonical(keepDates(withPeople(shown, ids, { keep: true }), [stored])) !== canonical(stored as RichText)
}

/** Rich text in one form: marks sorted, runs with the same marks merged (mentions and equations kept apart). */
function canonical(text: RichText): string {
  const out: [string, string][] = []
  for (const run of text) {
    if (!Array.isArray(run) || typeof run[0] !== 'string' || !run[0]) continue
    const marks = (run[1] ?? []).map((m) => JSON.stringify(m)).sort()
    const key = JSON.stringify(marks)
    const alone = (run[1] ?? []).some((m) => ['p', 'u', 'd', 'e'].includes(m[0]))
    const last = out.at(-1)
    if (last && last[1] === key && !alone) last[0] += run[0]
    else out.push([run[0], key])
  }
  return JSON.stringify(out)
}

/** A block's property values as Notion stores them, for a new block. */
function properties(nb: NewBlock): Record<string, unknown> {
  return {
    title: nb.title as RichText,
    ...(nb.type === 'to_do' ? { checked: [[nb.checked ? 'Yes' : 'No']] } : {}),
    ...(nb.type === 'code' ? { language: [[notionLanguage(nb.language ?? 'plain text')]] } : {}),
  }
}

/** What an edit_page call changes, for the user to read on its card. */
export function previewEdits(raw: unknown, read: PageRead | undefined, page: string): string | undefined {
  if (!Array.isArray(raw)) return undefined
  const shown = (block: unknown) => {
    const ref = typeof block === 'string' ? block.trim().replace(/^\^/, '').toLowerCase() : ''
    const id = read?.ids.get(ref)
    const line = id ? read!.lines.get(id) : undefined
    return line ? `^${ref} “${clip(line.replace(/\n/g, ' ⏎ '))}”` : `^${ref}`
  }
  const nested = (block: unknown) => {
    const ref = typeof block === 'string' ? block.trim().replace(/^\^/, '').toLowerCase() : ''
    const id = read?.ids.get(ref)
    const n = id ? (read!.nested.get(id)?.length ?? 0) : 0
    return n ? ` and the ${n} block${n === 1 ? '' : 's'} nested under it` : ''
  }
  const body = (markdown: unknown) =>
    typeof markdown === 'string'
      ? markdown
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n')
      : '    (nothing)'
  const changes = raw.map((value) => {
    const e = (value ?? {}) as EditArgs
    switch (e.action) {
      case 'insert': {
        const where =
          e.position === 'start'
            ? 'at the start of the page'
            : !e.block || e.position === 'end'
              ? 'at the end of the page'
              : e.position === 'inside'
                ? `at the start of ${shown(e.block)}, nested in it`
                : `after ${shown(e.block)}`
        return `Insert ${where}:\n${body(e.markdown)}`
      }
      case 'replace': {
        const ref = typeof e.block === 'string' ? e.block.trim().replace(/^\^/, '').toLowerCase() : ''
        const id = read?.ids.get(ref)
        const lossy = id && read!.lossy?.has(id)
        return (
          `Replace ${shown(e.block)} with:\n${body(e.markdown)}` +
          (lossy
            ? "\n    (If its text changes, what read_page didn't show exactly, such as comments on it, is lost.)"
            : '')
        )
      }
      case 'delete':
        return `Delete ${shown(e.block)}${nested(e.block)}`
      default:
        return `Unknown edit: ${JSON.stringify(value)}`
    }
  })
  // Nobody is asked first, so say where removed text can be found again. On a call that failed, the
  // card's label says the changes may not have been made.
  const removes = raw.some((value) => {
    const action = (value as EditArgs | null)?.action
    return action === 'replace' || action === 'delete'
  })
  return [
    `On the page “${read?.title ?? page}”:`,
    ...changes,
    ...(removes ? ["What it replaced or deleted can be brought back from the page's history in Notion."] : []),
  ].join('\n\n')
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * The operations creating a page at the end of `parent`, titled `title`, holding `blocks`, made by
 * `userId`. With no parent, the page is created unplaced, for a later operation to put it somewhere.
 */
export function planNewPage(
  parent: { id: string; table: 'block' | 'collection' } | undefined,
  spaceId: string,
  title: string,
  blocks: NewBlock[],
  userId: string | undefined,
  { now = Date.now(), newId = () => crypto.randomUUID(), properties = {} as Record<string, unknown> } = {},
): { operations: Operation[]; pageId: string } {
  const op = blockOps(spaceId, now, userId)
  const operations: Operation[] = []
  const pageId = newId()
  // A database row's parent is the database's collection, which lists its rows itself.
  operations.push(
    op.create(pageId, 'page', parent?.id, {
      properties: { ...properties, title: [[title]] },
      ...(parent?.table === 'collection' ? { parent_table: 'collection' as const } : {}),
    }),
  )
  let prev: string | undefined
  for (const child of blocks) {
    const childId = createBlock(op, operations, child, pageId, newId)
    operations.push(op.listAfter(pageId, childId, prev))
    prev = childId
  }
  if (parent?.table === 'block') operations.push(op.listAfter(parent.id, pageId), op.touch(parent.id))
  return { operations, pageId }
}

/**
 * Adds the operations creating a block and its children to `ops`, and returns its id; `onCreate`
 * hears every id created, nested ones too. Each record exists before a list names it; the caller
 * puts the block itself in its parent's list.
 */
function createBlock(
  op: ReturnType<typeof blockOps>,
  ops: Operation[],
  nb: NewBlock,
  parentId: string,
  newId: () => string,
  onCreate?: (id: string) => void,
): string {
  if (nb.caption !== undefined) {
    throw new EditError("Code block captions can't be written yet. Leave out the [caption: …] line.")
  }
  const id = newId()
  onCreate?.(id)
  // A table's columns are named by ids of its own; its first row is a header, as Markdown's is.
  const columns = nb.rows?.[0]?.map(() => columnId(newId))
  const format = {
    ...(nb.icon ? { page_icon: nb.icon } : {}),
    ...(nb.toggleable ? { toggleable: true } : {}),
    ...(columns ? { table_block_column_order: columns, table_block_column_header: true } : {}),
  }
  ops.push(
    op.create(id, nb.type, parentId, {
      ...(nb.type === 'divider' || nb.type === 'table' ? {} : { properties: properties(nb) }),
      ...(Object.keys(format).length ? { format } : {}),
    }),
  )
  let prev: string | undefined
  for (const cells of nb.rows ?? []) {
    const rowId = createRow(op, ops, cells, columns!, id, newId)
    onCreate?.(rowId)
    ops.push(op.listAfter(id, rowId, prev))
    prev = rowId
  }
  // Children go inside it, in order, the same way top-level blocks go into the page.
  for (const child of nb.children) {
    const childId = createBlock(op, ops, child, id, newId, onCreate)
    ops.push(op.listAfter(id, childId, prev))
    prev = childId
  }
  return id
}

/** Adds the operations creating a table row holding `cells`, one per column of `columns`, and returns its id. */
function createRow(
  op: ReturnType<typeof blockOps>,
  ops: Operation[],
  cells: RichText[],
  columns: string[],
  tableId: string,
  newId: () => string,
): string {
  const id = newId()
  const properties = Object.fromEntries(columns.flatMap((c, n) => (cells[n]?.length ? [[c, cells[n]]] : [])))
  ops.push(op.create(id, 'table_row', tableId, { properties }))
  return id
}

/** An id for a new table column: Notion's own are short strings unique within the table. */
function columnId(newId: () => string): string {
  return hexId(newId()).slice(-8)
}

/**
 * Rich text whose date mentions keep what the old text stored for the same date (its time zone,
 * reminder, and format), which read_page doesn't show.
 */
function keepDates(title: RichText, old: unknown[]): RichText {
  const dates = new Map<string, unknown>()
  for (const value of old) {
    if (!Array.isArray(value)) continue
    for (const run of value) {
      for (const m of (Array.isArray(run) && Array.isArray(run[1]) ? run[1] : []) as unknown[][]) {
        if (m[0] === 'd' && !dates.has(formatDate(m[1]))) dates.set(formatDate(m[1]), m[1])
      }
    }
  }
  if (!dates.size) return title
  return title.map((run) => {
    if (!run[1]?.some((m) => m[0] === 'd')) return run
    return [
      run[0],
      run[1].map((m): [string, unknown?] =>
        m[0] === 'd' && dates.has(formatDate(m[1])) ? ['d', dates.get(formatDate(m[1]))] : m,
      ),
    ]
  })
}

/** Blocks with their date mentions kept as `old` stored them (see keepDates). */
function withDates(blocks: NewBlock[], old: unknown[]): NewBlock[] {
  return blocks.map((b) => ({ ...b, title: keepDates(b.title, old), children: withDates(b.children, old) }))
}

/**
 * Pairs up two lists: equal items in the longest run they share, in order, then what is left
 * between two such pairs one to one, in order, and the rest alone. Each pair names an index of
 * `a`, of `b`, or both; the pairs keep the order of both lists.
 */
function align(a: string[], b: string[]): { a?: number; b?: number }[] {
  // longest[i][j]: how many items a[i..] and b[j..] share in order.
  const longest = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      longest[i][j] = a[i] === b[j] ? longest[i + 1][j + 1] + 1 : Math.max(longest[i + 1][j], longest[i][j + 1])
    }
  }
  const out: { a?: number; b?: number }[] = []
  let left: number[] = []
  let right: number[] = []
  const flush = () => {
    for (let k = 0; k < Math.max(left.length, right.length); k++) out.push({ a: left[k], b: right[k] })
    left = []
    right = []
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      flush()
      out.push({ a: i++, b: j++ })
    } else if (longest[i + 1][j] >= longest[i][j + 1]) left.push(i++)
    else right.push(j++)
  }
  while (i < a.length) left.push(i++)
  while (j < b.length) right.push(j++)
  flush()
  return out
}
