// Planning an edit_page call: checking the edits against the page as the agent read it and as it
// is now, and turning them into one Notion transaction. Nothing here talks to Notion.
import { blockOps, type Block, type LoadedPage, type Operation } from './api'
import { MarkdownError, TEXT_TYPES, notionLanguage, parseMarkdown, type NewBlock, type RichText } from './blocks'
import { PAGE_TYPES, hexId, type PageMarkdown } from './markdown'

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

/** The blocks of `md` the agent saw: those `include` picks, such as the blocks a part drew. */
export function pageRead(loaded: LoadedPage, md: PageMarkdown, include: (id: string) => boolean): PageRead {
  const blocks = (loaded.recordMap.block ?? {}) as Record<string, Block>
  const seen = include
  const refs = new Map([...md.refs].filter(([id]) => seen(id)))
  const versions = new Map<string, number>()
  const nested = new Map<string, string[]>()
  for (const id of [loaded.page.id, ...refs.keys()]) {
    if (blocks[id]) versions.set(id, blocks[id].version)
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
    lossy: new Set([...refs.keys()].filter((id) => hasUnwritableMarks(blocks[id]?.properties?.title))),
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

export type Edit =
  | { action: 'insert'; anchor?: string; position: 'after' | 'start' | 'end'; markdown: string; blocks: NewBlock[] }
  | { action: 'replace'; target: string; markdown: string; blocks: NewBlock[] }
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
        if (position !== 'after' && position !== 'start' && position !== 'end') {
          throw new EditError(`${where}: \`position\` must be "after", "start", or "end".`)
        }
        const anchor = position === 'after' ? block() : undefined
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
        `^${read.refs.get(anchor)} is replaced or deleted, so nothing can be inserted after it in the same call.`,
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

/** Rich text marks edit_page writes back; others (mentions of people and dates, colors, …) it can't. */
const WRITABLE_MARKS = new Set(['b', 'i', 's', 'c', 'a', 'p'])

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
      throw new EditError(`${what} wasn't shown to you: read the part of the page it is in, then redo the edit.`)
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
  const op = blockOps(spaceId, now)
  /** Where the next block inserted at each place goes: after the last one inserted there. */
  const tails = new Map<string, string>()

  const parentOf = (id: string): Block => {
    const block = blocks[id]
    const parent = block.parent_table === 'block' && block.parent_id ? blocks[block.parent_id] : undefined
    if (!parent) throw new EditError(`${ref(id)} is not inside a block that can hold new content.`)
    return parent
  }
  const aliveChildren = (block: Block) => (block.content ?? []).filter((id) => blocks[id] && blocks[id].alive !== false)
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

  for (const e of edits) {
    if (e.action === 'insert') {
      // The end of a page that didn't load in full is past blocks nobody was shown.
      if (e.position === 'end' && !loaded.complete) {
        throw new EditError("The page didn't load in full, so its end isn't known. Insert after a block instead.")
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
    if (!TEXT_TYPES.has(target.type)) {
      throw new EditError(
        `${ref(e.target)} is content edit_page can't rewrite (${target.type}). Delete it if that's what you mean.`,
      )
    }
    const [only] = e.blocks
    if (e.blocks.length === 1 && only.type === target.type && !only.children.length) {
      // The same kind of block: change it in place, keeping its id, children, and comments, and
      // only the fields that differ, so text the agent didn't change keeps what can't be written.
      const values = changedProperties(target, only, read.lines.get(target.id))
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
      const lost = values.title && hasUnwritableMarks(target.properties?.title)
      summary.push(
        `Replaced the text of ${ref(e.target)}.` +
          (lost
            ? ' Mentions of people or dates, colors, and similar formatting in its old text are now plain text.'
            : ''),
      )
      continue
    }
    // Anything nested, loaded or not, would go with the old block.
    if ((target.content ?? []).some((c) => !blocks[c] || blocks[c].alive !== false)) {
      throw new EditError(
        `${ref(e.target)} has nested blocks. Replace it with one block of the same kind and no nested lines, ` +
          'and change the nested blocks by their own references.',
      )
    }
    const ids = insert(e.blocks, parentOf(e.target), { after: e.target, key: e.target })
    remove(e.target)
    created.push(...ids)
    deleted.add(e.target)
    summary.push(
      `Replaced ${ref(e.target)} with ${ids.length} new block${ids.length === 1 ? '' : 's'}.` +
        (hasUnwritableMarks(target.properties?.title)
          ? ' Mentions of people or dates, colors, and similar formatting in its old text are now plain text.'
          : ''),
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
function changedProperties(target: Block, nb: NewBlock, shownLine: string | undefined): Record<string, unknown> {
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
    } catch {
      // Not Markdown that can be written back: treat the text as changed.
    }
    if (!before || JSON.stringify(before.title) !== JSON.stringify(nb.title)) out.title = nb.title
  }
  if (nb.type === 'to_do') {
    const checked = runsText(target.properties?.checked) === 'Yes'
    if (checked !== !!nb.checked) out.checked = [[nb.checked ? 'Yes' : 'No']]
  }
  return out
}

function runsText(value: unknown): string {
  return Array.isArray(value) ? value.map((r) => (Array.isArray(r) ? String(r[0]) : '')).join('') : ''
}

function hasUnwritableMarks(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (r) => Array.isArray(r) && Array.isArray(r[1]) && r[1].some((m: unknown[]) => !WRITABLE_MARKS.has(String(m[0]))),
    )
  )
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
            ? '\n    (If its text changes, its mentions, dates, colors, and similar formatting become plain text.)'
            : '')
        )
      }
      case 'delete':
        return `Delete ${shown(e.block)}${nested(e.block)}`
      default:
        return `Unknown edit: ${JSON.stringify(value)}`
    }
  })
  // Nobody is asked first, so say where removed text can be found again.
  const removes = raw.some((value) => {
    const action = (value as EditArgs | null)?.action
    return action === 'replace' || action === 'delete'
  })
  return [
    `On the page “${read?.title ?? page}”:`,
    ...changes,
    ...(removes ? ["What was replaced or deleted can be brought back from the page's history in Notion."] : []),
  ].join('\n\n')
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The operations creating a page at the end of `parentId`, titled `title`, holding `blocks`. */
export function planNewPage(
  parent: { id: string; table: 'block' | 'collection' },
  spaceId: string,
  title: string,
  blocks: NewBlock[],
  { now = Date.now(), newId = () => crypto.randomUUID(), properties = {} as Record<string, unknown> } = {},
): { operations: Operation[]; pageId: string } {
  const op = blockOps(spaceId, now)
  const operations: Operation[] = []
  const pageId = newId()
  // A database row's parent is the database's collection, which lists its rows itself.
  operations.push(
    op.create(pageId, 'page', parent.id, {
      properties: { ...properties, title: [[title]] },
      ...(parent.table === 'collection' ? { parent_table: 'collection' as const } : {}),
    }),
  )
  let prev: string | undefined
  for (const child of blocks) {
    const childId = createBlock(op, operations, child, pageId, newId)
    operations.push(op.listAfter(pageId, childId, prev))
    prev = childId
  }
  if (parent.table === 'block') operations.push(op.listAfter(parent.id, pageId), op.touch(parent.id))
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
  const id = newId()
  onCreate?.(id)
  ops.push(
    op.create(id, nb.type, parentId, {
      ...(nb.type === 'divider' ? {} : { properties: properties(nb) }),
      ...(nb.icon ? { format: { page_icon: nb.icon } } : {}),
    }),
  )
  // Children go inside it, in order, the same way top-level blocks go into the page.
  let prev: string | undefined
  for (const child of nb.children) {
    const childId = createBlock(op, ops, child, id, newId, onCreate)
    ops.push(op.listAfter(id, childId, prev))
    prev = childId
  }
  return id
}
