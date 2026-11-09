// Planning an edit_page call: checking the edits against the page as the agent read it and as it
// is now, and turning them into one Notion transaction. Nothing here talks to Notion.
import type { Block, LoadedPage, Operation } from './api'
import { MarkdownError, TEXT_TYPES, parseMarkdown, type NewBlock } from './blocks'
import { PAGE_TYPES, type PageMarkdown } from './markdown'

/** What the agent saw when it last read a page: the references it was shown, and each block's version. */
export interface PageRead {
  pageId: string
  /** Block id by the reference read_page showed for it. */
  ids: Map<string, string>
  /** Reference by block id. */
  refs: Map<string, string>
  versions: Map<string, number>
  /** The line each block showed as, for previews. */
  lines: Map<string, string>
}

export function pageRead(loaded: LoadedPage, md: PageMarkdown): PageRead {
  const blocks = (loaded.recordMap.block ?? {}) as Record<string, Block>
  const versions = new Map<string, number>()
  for (const id of [loaded.page.id, ...md.refs.keys()]) {
    const block = blocks[id]
    if (block) versions.set(id, block.version)
  }
  return {
    pageId: loaded.page.id,
    // Short references, and full ids, which read_page shows for child pages and databases.
    ids: new Map([...md.refs].flatMap(([id, ref]) => [[ref, id] as const, [id.replace(/-/g, ''), id] as const])),
    refs: md.refs,
    versions,
    lines: md.lines,
  }
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
      if (typeof e.block !== 'string' || !e.block.trim())
        throw new EditError(`${where} needs \`block\`, a reference such as ^1a2b3c4d.`)
      const ref = e.block.trim().replace(/^\^/, '').toLowerCase()
      const id = read.ids.get(ref)
      if (!id) throw new EditError(`${where}: ^${ref} is not a block of the page as you last read it. ${READ_AGAIN}`)
      return id
    }
    switch (e.action) {
      case 'insert': {
        const position = e.position ?? (e.block === undefined || e.block === null || e.block === '' ? 'end' : 'after')
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
  /** What the edit does, one line per edit, for the result. */
  summary: string[]
}

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
  const ref = (id: string) => `^${read.refs.get(id) ?? id.replace(/-/g, '')}`

  // Every block an edit points at must be as the agent read it.
  for (const e of edits) {
    const id = e.action === 'insert' ? e.anchor : e.target
    if (!id) continue
    const block = blocks[id]
    if (!block || block.alive === false)
      throw new EditError(`${ref(id)} was deleted since you read the page. ${READ_AGAIN}`)
    if (block.version !== read.versions.get(id)) {
      throw new EditError(`${ref(id)} was changed since you read the page. ${READ_AGAIN}`)
    }
  }

  const ops: Operation[] = []
  const created: string[] = []
  const summary: string[] = []
  const edited = new Set<string>([page.id])
  const pointer = (id: string) => ({ table: 'block' as const, id, spaceId })
  /** Where the next block inserted at each place goes: after the last one inserted there. */
  const tails = new Map<string, string>()

  const parentOf = (id: string): Block => {
    const block = blocks[id]
    const parent = block.parent_table === 'block' && block.parent_id ? blocks[block.parent_id] : undefined
    if (!parent) throw new EditError(`${ref(id)} is not inside a block that can hold new content.`)
    return parent
  }
  const aliveChildren = (block: Block) => (block.content ?? []).filter((id) => blocks[id] && blocks[id].alive !== false)

  /** Creates `newBlocks` in `parent`, after `after` (or at the start or end). Returns the new top-level ids. */
  const insert = (newBlocks: NewBlock[], parent: Block, place: { after?: string; start?: boolean; key: string }) => {
    const ids: string[] = []
    for (const nb of newBlocks) {
      const id = create(nb, parent.id)
      const prev = tails.get(place.key) ?? place.after
      if (prev) {
        ops.push({ pointer: pointer(parent.id), path: ['content'], command: 'listAfter', args: { after: prev, id } })
      } else if (place.start && aliveChildren(parent).length) {
        ops.push({
          pointer: pointer(parent.id),
          path: ['content'],
          command: 'listBefore',
          args: { before: aliveChildren(parent)[0], id },
        })
      } else {
        ops.push({ pointer: pointer(parent.id), path: ['content'], command: 'listAfter', args: { id } })
      }
      tails.set(place.key, id)
      ids.push(id)
    }
    edited.add(parent.id)
    return ids
  }

  const create = (nb: NewBlock, parentId: string): string => {
    const id = newId()
    const childIds = nb.children.map((child) => create(child, id))
    ops.unshift({
      pointer: pointer(id),
      path: [],
      command: 'set',
      args: {
        id,
        type: nb.type,
        version: 1,
        alive: true,
        parent_id: parentId,
        parent_table: 'block',
        space_id: spaceId,
        created_time: now,
        last_edited_time: now,
        ...(nb.type === 'divider' ? {} : { properties: properties(nb) }),
        ...(nb.icon ? { format: { page_icon: nb.icon } } : {}),
        ...(childIds.length ? { content: childIds } : {}),
      },
    })
    return id
  }

  const remove = (id: string) => {
    const parent = parentOf(id)
    ops.push({ pointer: pointer(id), path: [], command: 'update', args: { alive: false, last_edited_time: now } })
    ops.push({ pointer: pointer(parent.id), path: ['content'], command: 'listRemove', args: { id } })
    edited.add(parent.id)
  }

  for (const e of edits) {
    if (e.action === 'insert') {
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
    if (e.action === 'delete') {
      remove(e.target)
      summary.push(`Deleted ${ref(e.target)}.`)
      continue
    }
    if (!TEXT_TYPES.has(target.type)) {
      throw new EditError(
        `${ref(e.target)} is content edit_page can't rewrite (${target.type}). Delete it if that's what you mean.`,
      )
    }
    const [only] = e.blocks
    if (e.blocks.length === 1 && only.type === target.type && !only.children.length) {
      // The same kind of block: change it in place, keeping its id, children, and comments.
      if (only.type !== 'divider') {
        ops.push({
          pointer: pointer(target.id),
          path: ['properties'],
          command: 'updateBlockPropertyValue',
          args: { primitiveOp: { command: 'update', args: properties(only) } },
        })
      }
      if (only.type === 'callout' && only.icon && only.icon !== target.format?.page_icon) {
        ops.push({ pointer: pointer(target.id), path: ['format'], command: 'update', args: { page_icon: only.icon } })
      }
      edited.add(target.id)
      summary.push(`Replaced the text of ${ref(e.target)}.`)
      continue
    }
    if (aliveChildren(target).length) {
      throw new EditError(
        `${ref(e.target)} has nested blocks. Replace it with one block of the same kind and no nested lines, ` +
          'and change the nested blocks by their own references.',
      )
    }
    const ids = insert(e.blocks, parentOf(e.target), { after: e.target, key: e.target })
    remove(e.target)
    created.push(...ids)
    summary.push(`Replaced ${ref(e.target)} with ${ids.length} new block${ids.length === 1 ? '' : 's'}.`)
  }

  for (const id of edited) {
    if (blocks[id]?.alive === false) continue
    ops.push({ pointer: pointer(id), path: [], command: 'update', args: { last_edited_time: now } })
  }
  return { operations: ops, created, summary }
}

/** A block's property values as Notion stores them. */
function properties(nb: NewBlock): Record<string, unknown> {
  return {
    title: nb.title,
    ...(nb.type === 'to_do' ? { checked: [[nb.checked ? 'Yes' : 'No']] } : {}),
    ...(nb.type === 'code' ? { language: [[nb.language ?? 'plain text']] } : {}),
  }
}

/** What an edit_page call would change, for the user to read before agreeing. */
export function previewEdits(raw: unknown, read: PageRead | undefined): string | undefined {
  if (!Array.isArray(raw)) return undefined
  const shown = (block: unknown) => {
    const ref = typeof block === 'string' ? block.trim().replace(/^\^/, '').toLowerCase() : ''
    const id = read?.ids.get(ref)
    const line = id ? read!.lines.get(id) : undefined
    return line ? `^${ref} “${clip(line)}”` : `^${ref}`
  }
  const body = (markdown: unknown) =>
    typeof markdown === 'string'
      ? markdown
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n')
      : '    (nothing)'
  return raw
    .map((value) => {
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
        case 'replace':
          return `Replace ${shown(e.block)} with:\n${body(e.markdown)}`
        case 'delete':
          return `Delete ${shown(e.block)}`
        default:
          return `Unknown edit: ${JSON.stringify(value)}`
      }
    })
    .join('\n\n')
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
