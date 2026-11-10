// Notion pages as Markdown, the form the model reads them in. Each block ends with a reference
// (` ^<ref>`, like an Obsidian block reference) so tools that change the page can point at it.
// Child pages, databases, and links to pages carry the full page id, which read_page accepts.
import type { Block, LoadedPage, NotionRecord, Pointer, RecordMap } from './api'
import { COLOR } from './blocks'

/** A run of text and its decorations, as Notion stores rich text: `[text, [[mark, value?], …]?]`. */
type Run = [string, [string, unknown?][]?]

export interface PageMarkdown {
  title: string
  /** `name: value` lines for a database row's properties; empty for other pages. */
  properties: string[]
  /** The page's top-level blocks, each with its children, in page order. */
  sections: string[]
  /** What kind of page this is when it has no content of its own (a database). */
  kind: 'page' | 'database'
  /** The reference shown for each block, by block id. */
  refs: Map<string, string>
  /** Each block's own Markdown (without children or reference), by block id. */
  lines: Map<string, string>
  /** For each section, the id of the block each of its lines belongs to. */
  owners: string[][]
}

/** Ids as the Markdown shows them: 32 hex digits, no dashes. */
export function hexId(id: string): string {
  return id.replace(/-/g, '').toLowerCase()
}

const REF_LENGTH = 8

/**
 * Short references for blocks: the last 8 hex digits of the id, or the whole id for blocks whose
 * last digits another block on the page shares.
 */
export function blockRefs(ids: string[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const id of ids) {
    const short = hexId(id).slice(-REF_LENGTH)
    counts.set(short, (counts.get(short) ?? 0) + 1)
  }
  return new Map(
    ids.map((id) => {
      const hex = hexId(id)
      const short = hex.slice(-REF_LENGTH)
      return [id, counts.get(short)! > 1 ? hex : short]
    }),
  )
}

/** Blocks that are pages of their own: shown as links, never expanded into the page. */
export const PAGE_TYPES = new Set(['page', 'collection_view_page', 'collection_view'])
/** Blocks that only lay out their children; their children are shown in their place. */
export const LAYOUT_TYPES = new Set(['column_list', 'column'])
/** The collection a database block shows; a linked view names it in its format instead. */
export function collectionId(block: NotionRecord): string | undefined {
  const pointer = (block.format as { collection_pointer?: { id?: unknown } } | undefined)?.collection_pointer
  const id = block.collection_id ?? pointer?.id
  return typeof id === 'string' ? id : undefined
}
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'pdf', 'file'])
/** Paragraph text that Markdown would read as another kind of block, or whose leading spaces it would drop. */
const LOOKS_LIKE_BLOCK = /^(?:\s|#{1,3}\s|[-*+]\s|\d+[.)]\s|>|▸|`{3}|\$\$|\||\\|📄 |🗃 |↗ |(?:-{3,}|\*{3,}|_{3,})$)/

export function pageToMarkdown({ page, recordMap }: LoadedPage): PageMarkdown {
  const blocks = (recordMap.block ?? {}) as Record<string, Block>
  const ctx = new Context(recordMap, blocks)
  const isDatabase = page.type === 'collection_view_page' || page.type === 'collection_view'
  const title = isDatabase ? ctx.databaseName(page) : ctx.plain(page.properties?.title)

  // References are assigned over every block shown, so they are unique within the page.
  const shown = isDatabase ? [] : ctx.descendants(page)
  ctx.refs = blockRefs(shown)
  ctx.topLevel = true
  const sections = isDatabase ? [] : ctx.children(page, 0).map((lines) => lines.join('\n'))
  return {
    title: title || 'Untitled',
    properties: ctx.properties(page),
    sections,
    kind: isDatabase ? 'database' : 'page',
    refs: ctx.refs,
    lines: ctx.lines,
    owners: ctx.sectionOwners,
  }
}

/** The most people and pages `unnamedMentions` asks for: one request's worth. */
const UNNAMED_MAX = 100

/**
 * People and pages a page shows as mentions (in its text, and in the row properties it shows)
 * whose records `loadPage` didn't return, so they would show as `@someone` and `[page](id)`.
 * Loading them shows their names. Only for a page: a database shows no text of its own.
 */
export function unnamedMentions({ page, recordMap, spaceId }: LoadedPage): Pointer[] {
  if (page.type !== 'page') return []
  const blocks = (recordMap.block ?? {}) as Record<string, Block>
  const ctx = new Context(recordMap, blocks)
  const users = new Set<string>()
  const pages = new Map<string, string>()
  const scan = (value: unknown) => {
    for (const [, marks = []] of runs(value)) {
      for (const [mark, arg, space] of marks as [string, unknown?, unknown?][]) {
        if (mark === 'u' && typeof arg === 'string') users.add(arg)
        if (mark === 'p' && typeof arg === 'string') pages.set(arg, typeof space === 'string' ? space : spaceId)
      }
    }
  }
  // What synced copies show is drawn too, from their originals (a copy inside its own original,
  // once).
  const shown = ctx.descendants(page)
  for (let n = 0; n < shown.length; n++) {
    const block = blocks[shown[n]]
    for (const value of Object.values(block?.properties ?? {})) scan(value)
    const original = block?.type === 'transclusion_reference' ? ctx.original(block) : undefined
    if (original && !shown.includes(original.id)) shown.push(original.id, ...ctx.descendants(original))
  }
  // A row's properties show only with its database, which names them.
  const schema = (
    page.parent_table === 'collection' ? recordMap.collection?.[String(page.parent_id)]?.schema : undefined
  ) as Schema | undefined
  for (const [key, { type }] of Object.entries(schema ?? {})) {
    if (type === 'created_by' || type === 'last_edited_by') {
      const user = page[`${type}_id`]
      if (typeof user === 'string') users.add(user)
    } else if (type !== 'title') scan(page.properties?.[key])
  }
  const pointers: Pointer[] = [
    ...[...users].filter((id) => !recordMap.notion_user?.[id]).map((id) => ({ table: 'notion_user' as const, id })),
    ...[...pages].filter(([id]) => !blocks[id]).map(([id, space]) => ({ table: 'block' as const, id, spaceId: space })),
  ]
  return pointers.slice(0, UNNAMED_MAX)
}

/**
 * The people and pages database rows mention (a relation's pages, a person, a page mentioned in
 * text) that `recordMap` doesn't hold, so they can be looked up and shown by name.
 */
export function unnamedRowMentions(recordMap: RecordMap, rows: Block[], spaceId: string): Pointer[] {
  const users = new Set<string>()
  const pages = new Map<string, string>()
  for (const row of rows) {
    for (const value of Object.values(row.properties ?? {})) {
      for (const [, marks = []] of runs(value)) {
        for (const [mark, arg, space] of marks as [string, unknown?, unknown?][]) {
          if (mark === 'u' && typeof arg === 'string') users.add(arg)
          if (mark === 'p' && typeof arg === 'string') pages.set(arg, typeof space === 'string' ? space : spaceId)
        }
      }
    }
  }
  const pointers: Pointer[] = [
    ...[...users].filter((id) => !recordMap.notion_user?.[id]).map((id) => ({ table: 'notion_user' as const, id })),
    ...[...pages]
      .filter(([id]) => !recordMap.block?.[id])
      .map(([id, space]) => ({ table: 'block' as const, id, spaceId: space })),
  ]
  return pointers.slice(0, UNNAMED_MAX)
}

/** Rich text from outside a page's blocks (a comment, say) as Markdown, with mentions named from `recordMap`. */
export function richMarkdown(recordMap: RecordMap, value: unknown): string {
  return new Context(recordMap, (recordMap.block ?? {}) as Record<string, Block>).rich(value)
}

/** A Notion user's name as `recordMap` has it, or "someone". */
export function userName(recordMap: RecordMap, id: string): string {
  return new Context(recordMap, {}).userName(id)
}

/** A database's property definitions, by property id (the title's is `title`). */
export type Schema = Record<
  string,
  { name?: string; type?: string; options?: { value?: string }[]; defaultOption?: unknown }
>

const isTitle = ([key, s]: [string, { type?: string }]) => key === 'title' || s.type === 'title'

/** A database's properties as [key, definition]: the title first, then the rest in the schema's order. */
export function titleFirst(schema: Schema): [string, Schema[string]][] {
  const entries = Object.entries(schema)
  return [...entries.filter(isTitle), ...entries.filter((e) => !isTitle(e))]
}

/**
 * Each property of a database row as text, in titleFirst's order. With `table`, each value is
 * escaped to sit in a Markdown table cell: no `|` in it can end the cell.
 */
export function rowValues(
  recordMap: RecordMap,
  row: Block,
  schema: Schema,
  { table = false } = {},
): { name: string; type: string; value: string }[] {
  const ctx = new Context(recordMap, (recordMap.block ?? {}) as Record<string, Block>)
  return titleFirst(schema).map(([key, s]) => ({
    name: s.name ?? key,
    type: s.type ?? 'text',
    value: isTitle([key, s]) ? ctx.rich(row.properties?.title, { table }) : ctx.property(row, key, s, { table }),
  }))
}

class Context {
  refs = new Map<string, string>()
  lines = new Map<string, string>()
  /** For each top-level section, the id of the block each of its lines belongs to. */
  sectionOwners: string[][] = []
  /** Whether children() is drawing the page's top level, where each block starts a section. */
  topLevel = false
  /** Line owners of the blocks drawn inside each block being drawn. */
  private ownerFrames: string[][] = []
  /**
   * The originals of the synced copies being drawn, outermost first. Their blocks live where the
   * original is, so they are drawn without references: tools can't change them from this page.
   */
  private within: string[] = []

  constructor(
    private readonly recordMap: RecordMap,
    private readonly blocks: Record<string, Block>,
  ) {}

  /**
   * Ids of the blocks the page shows, in order: children, but not the content of child pages, nor
   * what a synced copy shows (those blocks are the original's, on its page).
   */
  descendants(parent: Block): string[] {
    const out: string[] = []
    for (const id of parent.content ?? []) {
      const block = this.blocks[id]
      if (block?.alive === false) continue
      out.push(id)
      if (block && !PAGE_TYPES.has(block.type)) out.push(...this.descendants(block))
    }
    return out
  }

  /** The original a synced copy shows, if it was loaded. */
  original(block: Block): Block | undefined {
    const pointer = block.format?.transclusion_reference_pointer as { id?: unknown } | undefined
    const original = typeof pointer?.id === 'string' ? this.blocks[pointer.id] : undefined
    return original && original.alive !== false ? original : undefined
  }

  /** The children of `parent`, each rendered with its own children. */
  children(parent: Block, depth: number): string[][] {
    const out: string[][] = []
    const content = parent.content ?? []
    let number = 0
    for (let at = 0; at < content.length; at++) {
      const id = content[at]
      const block = this.blocks[id]
      if (block?.alive === false) continue
      // A list counts from where its first item says (Notion's "start at"), or from 1.
      const start = Number(block?.format?.list_start_index)
      number =
        block?.type === 'numbered_list' ? (number ? number + 1 : Number.isInteger(start) && start > 0 ? start : 1) : 0
      if (block && LAYOUT_TYPES.has(block.type)) {
        out.push(...this.children(block, depth))
        continue
      }
      // Blocks that weren't loaded (the rest of a page too long to load, usually) are one line
      // together, carrying the first one's reference.
      let missing = 0
      if (!block) {
        while (at + missing < content.length && !this.blocks[content[at + missing]]) missing++
        at += missing - 1
      }
      // Which block each line belongs to: the lines blocks nested in this one draw are collected
      // while it is drawn.
      const top = this.topLevel
      this.topLevel = false
      this.ownerFrames.push([])
      const lines = block
        ? this.block(block, depth, number)
        : [`${indent(depth)}[${missing === 1 ? 'block' : `${missing} blocks`} not loaded]${this.ref(id)}`]
      const nestedOwners = this.ownerFrames.pop()!
      this.topLevel = top
      if (lines.length) {
        out.push(lines)
        // The block's own Markdown: its lines up to the one carrying its reference, without its
        // children, its reference, or the indentation of its depth.
        const ref = this.ref(id).trim()
        const end = ref ? lines.findIndex((l) => l.endsWith(` ${ref}`) || l.trim() === ref) : 0
        const owners = [...Array<string>(end < 0 ? 1 : end + 1).fill(id), ...nestedOwners]
        while (owners.length < lines.length) owners.push(id)
        owners.length = lines.length
        this.ownerFrames.at(-1)?.push(...owners)
        if (top) this.sectionOwners.push(owners)
        const pad = indent(depth)
        const own = lines
          .slice(0, end < 0 ? 1 : end + 1)
          .map((l) => (l.startsWith(pad) ? l.slice(pad.length) : l.trimStart()))
          .map((l) => (l.trim() === ref ? '' : l.endsWith(` ${ref}`) ? l.slice(0, -ref.length - 1) : l))
        while (own.length > 1 && !own.at(-1)!.trim()) own.pop()
        this.lines.set(id, own.join('\n'))
      }
    }
    return out
  }

  private block(block: Block, depth: number, number: number): string[] {
    const pad = indent(depth)
    const ref = this.ref(block.id)
    const text = this.rich(block.properties?.title)
    const children = () => this.children(block, depth + 1).flat()
    const line = (prefix: string, body = text) => [...withRef(pad, prefix, body, ref), ...children()]

    switch (block.type) {
      case 'text':
        // Empty paragraphs are only spacing.
        if (!text && !block.content?.length) return []
        // Text that would read as a list, heading, quote, or code starts with a backslash.
        return line(LOOKS_LIKE_BLOCK.test(text) ? '\\' : '')
      case 'header':
        return line('# ')
      case 'sub_header':
        return line('## ')
      case 'sub_sub_header':
        return line('### ')
      case 'bulleted_list':
        return line('- ')
      case 'numbered_list':
        return line(`${number}. `)
      case 'to_do':
        return line(this.plain(block.properties?.checked) === 'Yes' ? '- [x] ' : '- [ ] ')
      case 'toggle':
        return line('▸ ')
      case 'quote':
        return this.quoted(block, pad, '', text, ref)
      case 'callout': {
        // Only an emoji is a label; uploaded and custom icons are URLs.
        const icon = block.format?.page_icon
        const label = typeof icon === 'string' && !/[/:]/.test(icon) ? icon : 'callout'
        return this.quoted(block, pad, `[!${label}] `, text, ref)
      }
      case 'code': {
        const language = this.plain(block.properties?.language).toLowerCase()
        const code = this.plain(block.properties?.title)
        // The fence is longer than any run of backticks in the code, so the code can't close it.
        const fence = '`'.repeat(Math.max(3, longestRun(code) + 1))
        const caption = this.rich(block.properties?.caption).replace(/\n/g, '<br>')
        return [
          `${pad}${fence}${language === 'plain text' ? '' : language}`,
          ...code.split('\n').map((l) => `${pad}${l}`),
          `${pad}${fence}`,
          // On its own line: text after a closing fence would stop it from closing the block.
          ...(caption ? [`${pad}[caption: ${caption}]${ref}`] : refLine(pad, ref)),
          ...children(),
        ]
      }
      case 'divider':
        return [`${pad}---${ref}`]
      case 'equation':
        return [`${pad}$$${this.plain(block.properties?.title)}$$${ref}`]
      case 'bookmark': {
        const link = this.plain(block.properties?.link)
        return line('', `[${this.plain(block.properties?.title) || link}](${link})`)
      }
      case 'embed':
        return line('', `[embed: ${this.plain(block.properties?.source)}]`)
      case 'page':
        // A child page's own content stays in that page.
        return [`${pad}📄 ${this.plain(block.properties?.title) || 'Untitled'}${this.fullRef(block.id)}`]
      case 'collection_view':
      case 'collection_view_page':
        return [`${pad}🗃 ${this.databaseName(block)} (database)${this.fullRef(block.id)}`]
      case 'alias': {
        const target = (block.format?.alias_pointer as { id?: string } | undefined)?.id
        if (!target) return line('', '[link to a page]')
        return line('↗ ', `[${this.pageTitle(target)}](${hexId(target)})`)
      }
      case 'table':
        return [...this.table(block, pad), ...refLine(pad, ref)]
      case 'transclusion_container':
        // The original of a synced block: its content is this page's, and shows on other pages too.
        return line('', '[synced block]')
      case 'transclusion_reference': {
        // A copy of a synced block shows its original's content, which lives where the original is:
        // drawn without references, so an edit on this page can't change another page.
        const original = this.original(block)
        if (!original || this.within.includes(original.id)) return line('', '[synced copy, not loaded]')
        this.within.push(original.id)
        try {
          return [...withRef(pad, '', '[synced copy]', ref), ...this.children(original, depth + 1).flat()]
        } finally {
          this.within.pop()
        }
      }
      default:
        if (MEDIA_TYPES.has(block.type)) {
          const caption = this.rich(block.properties?.caption) || this.plain(block.properties?.title)
          return line('', `[${block.type}${caption ? `: ${caption}` : ''}]`)
        }
        // A block we can't show: say what it is, so the model knows something is there.
        return line('', `[unsupported block: ${block.type}]`)
    }
  }

  /** A quote or callout: every line, its children's too, stays inside the blockquote. */
  private quoted(block: Block, pad: string, label: string, text: string, ref: string): string[] {
    // Every line of a quote is marked as quoted, so its line breaks stay real lines.
    // As for paragraphs: a line that would read as a list, heading, or code starts with a backslash.
    const escaped = text
      .split('\n')
      .map((l) => (LOOKS_LIKE_BLOCK.test(l) ? `\\${l}` : l))
      .join('\n')
    const own = withRef('', label, escaped, ref, 'lines')
    // Nested blocks are indented under the quote's own text, inside it, so they read as nested.
    const children = this.children(block, 1).flat()
    return [...own, ...children].map((l) => `${pad}> ${l}`)
  }

  private table(block: Block, pad: string): string[] {
    const columns = (block.format?.table_block_column_order as string[] | undefined) ?? []
    const rows = (block.content ?? []).map((id) => this.blocks[id]).filter((r) => r?.alive !== false)
    if (!columns.length || !rows.length) return [`${pad}[empty table]`]
    // A cell can't hold a raw `|` or a line break; backslashes are escaped first so the escaping
    // can be undone.
    // Text is already escaped (pipes included), so a cell only needs its line breaks kept on one line.
    const cell = (text: string) => text.replace(/\n/g, '<br>')
    const cells = rows.map((row) =>
      row
        ? columns.map((c) => cell(this.rich(row.properties?.[c], { table: true })))
        : ['[row not loaded]', ...columns.slice(1).map(() => '')],
    )
    // Markdown tables need a header row; Notion's first row is one when the table says so, and is
    // shown as one either way.
    const [head, ...body] = cells
    return [
      `${pad}| ${head.join(' | ')} |`,
      `${pad}|${columns.map(() => ' --- ').join('|')}|`,
      ...body.map((r) => `${pad}| ${r.join(' | ')} |`),
    ]
  }

  /**
   * A database row's properties, skipping empty ones and the title, in the order of the database's
   * first view (as Notion shows its columns), then any the view doesn't list in the schema's order.
   * Without its database (the user may see the row but not the database), there are none to show.
   */
  properties(page: Block): string[] {
    if (page.parent_table !== 'collection' || !page.parent_id) return []
    const collection = this.recordMap.collection?.[page.parent_id]
    const schema = (collection?.schema ?? {}) as Schema
    const keys = Object.keys(schema)
    const order = this.viewOrder(collection).filter((key) => key in schema)
    const out: string[] = []
    for (const key of new Set([...order, ...keys])) {
      const { name, type } = schema[key]
      if (key === 'title' || type === 'title') continue
      const shown = this.property(page, key, schema[key])
      if (shown) out.push(`${name ?? key}: ${shown}`)
    }
    return out
  }

  /** The properties in the order the first view of a database lists them, if that view was loaded. */
  private viewOrder(collection: NotionRecord | undefined): string[] {
    const database = collection?.parent_table === 'block' ? this.blocks[String(collection.parent_id)] : undefined
    const viewId = (database?.view_ids as unknown[] | undefined)?.[0]
    const view = typeof viewId === 'string' ? this.recordMap.collection_view?.[viewId] : undefined
    // Each kind of view keeps its own list: `table_properties`, `board_properties`, and so on.
    const listed = (view?.format as Record<string, unknown> | undefined)?.[`${String(view?.type)}_properties`]
    if (!Array.isArray(listed)) return []
    return listed.flatMap((p: { property?: unknown }) => (typeof p?.property === 'string' ? [p.property] : []))
  }

  property(page: Block, key: string, def: Schema[string], { table = false } = {}): string {
    const type = def.type
    switch (type) {
      // Notion keeps these on the row itself, not in its properties.
      case 'created_time':
      case 'last_edited_time': {
        const time = page[type]
        return typeof time === 'number' ? new Date(time).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : ''
      }
      case 'created_by':
      case 'last_edited_by': {
        const user = page[`${type}_id`]
        return typeof user === 'string' ? this.mention(user) : ''
      }
      // Computed by Notion when it shows the database; the row doesn't store them.
      case 'formula':
      case 'rollup':
        return `[${type}, not shown]`
      case 'checkbox':
        // A checkbox never ticked has no value stored; Notion shows it unticked.
        return this.plain(page.properties?.[key]) === 'Yes' ? 'Yes' : 'No'
      case 'status': {
        // A row with no status stored shows the database's default option, as Notion does.
        const shown = this.rich(page.properties?.[key], { table })
        const fallback = def.defaultOption
        if (shown || typeof fallback !== 'string' || !def.options?.some((o) => o.value === fallback)) return shown
        return escapeMarkdown(fallback)
      }
      default:
        return this.rich(page.properties?.[key], { table })
    }
  }

  databaseName(block: Block): string {
    const id = collectionId(block)
    const collection = id ? this.recordMap.collection?.[id] : undefined
    return this.plain(collection?.name) || 'Untitled database'
  }

  private pageTitle(id: string): string {
    const block = this.blocks[id]
    if (!block) return 'page'
    if (block.type === 'collection_view_page') return this.databaseName(block)
    return this.plain(block.properties?.title) || 'Untitled'
  }

  private ref(id: string): string {
    return this.within.length ? '' : ` ^${this.refs.get(id) ?? hexId(id)}`
  }

  private fullRef(id: string): string {
    return ` ^${hexId(id)}`
  }

  /** Rich text as plain text. */
  plain(value: unknown): string {
    return runs(value)
      .map(([text]) => text)
      .join('')
  }

  /** Rich text as Markdown, with mentions resolved to names. */
  /**
   * In a table, every `|` is escaped (in code, equations, mentioned names, and link targets too), so
   * it can't split a cell.
   */
  rich(value: unknown, { table = false } = {}): string {
    let afterPerson = false
    return runs(value)
      .map(([text, marks = []]) => {
        let out = this.run(text, marks, table)
        // `@[Name](` would read as an @ before a link: the parenthesis after a mention stays literal.
        if (afterPerson && out.startsWith('(')) out = `\\${out}`
        afterPerson = /@\[.*\]$/s.test(out) && marks.some(([m]) => m === 'u')
        return out
      })
      .join('')
  }

  private run(text: string, marks: [string, unknown?][], table = false): string {
    // A link target is read as it is, a table cell's `\|` aside, so only its pipes are escaped.
    const target = (href: string) => (table ? href.split('|').join('\\|') : href)
    const code = marks.some(([m]) => m === 'c')
    // Code and equations keep their text as it is; in a table only their pipes are escaped, as
    // GFM reads `\|` there.
    const raw = (t: string) => (table ? t.split('|').join('\\|') : t)
    // Characters Markdown would read as formatting stay literal behind a backslash.
    let out = code ? raw(text) : escapeMarkdown(text)
    let link: string | undefined
    let color: string | undefined
    for (const [mark, arg] of marks) {
      switch (mark) {
        case 'p':
          // The title is Markdown-escaped, pipes included, so `[WIP] Plan` or `C:\temp` stays one link.
          return `[${escapeMarkdown(this.pageTitle(String(arg)))}](${hexId(String(arg))})`
        case 'lm': {
          // A link mention (a web page shown as a preview) is a link to that page.
          const { href, title } = (arg ?? {}) as { href?: unknown; title?: unknown }
          if (typeof href !== 'string' || !href) break
          return `[${escapeMarkdown(typeof title === 'string' && title ? title : href)}](${target(href)})`
        }
        case 'u':
          // Its bold, italic, and strikethrough still apply, as for text (a link can't: `[@[Name]](url)`
          // wouldn't read back). The name is Markdown-escaped, so its pipes are too.
          out = this.mention(String(arg))
          break
        case 'd':
          return `@${formatDate(arg)}`
        case 'e':
          return `$${raw(String(arg))}$`
        case 'h':
          if (typeof arg === 'string' && COLOR.test(arg)) color = arg
          break
        case 'a': {
          // Notion links to its own pages by path (`/Title-<id>`); show those as `/<id>` (keeping any
          // `#block`), which read_page opens and which stays a link, unlike a mention's `(<id>)`.
          const href = String(arg)
          const [path, hash] = href.split('#')
          const page = href.startsWith('/')
            ? /[0-9a-f]{32}$/i.exec(path.split('?')[0].replace(/-/g, ''))?.[0]
            : undefined
          link = page ? `/${page.toLowerCase()}${hash ? `#${hash}` : ''}` : target(href)
          break
        }
      }
    }
    const has = (m: string) => marks.some(([mark]) => mark === m)
    // A mention in backticks would read back as code, not a mention.
    if (has('c') && !has('u')) out = codeSpan(out)
    if (has('b')) out = wrap(out, '**')
    if (has('i')) out = wrap(out, '*')
    if (has('s')) out = wrap(out, '~~')
    if (color) out = `<span color="${color}">${out}</span>`
    if (link && !marks.some(([m]) => m === 'u')) out = `[${out}](${link})`
    return out
  }

  /**
   * A mention of a person as `@[Name]`, which edit_page writes back as the same mention. A person
   * whose name isn't known shows as `@someone`, which is plain text when written back.
   */
  private mention(id: string): string {
    const user = this.recordMap.notion_user?.[id] as (NotionRecord & { name?: string }) | undefined
    return user?.name ? `@[${escapeMarkdown(user.name)}]` : '@someone'
  }

  userName(id: string): string {
    const user = this.recordMap.notion_user?.[id] as (NotionRecord & { name?: string }) | undefined
    return user?.name || 'someone'
  }
}

function runs(value: unknown): Run[] {
  return Array.isArray(value) ? (value.filter((r) => Array.isArray(r) && typeof r[0] === 'string') as Run[]) : []
}

function indent(depth: number): string {
  return '  '.repeat(depth)
}

/** A block's lines: the prefix and text, continuation lines indented under it, the reference last. */
function withRef(pad: string, prefix: string, text: string, ref: string, breaks: 'br' | 'lines' = 'br'): string[] {
  // A line break inside a block stays inside its one line, so it can't be read as another block.
  if (breaks === 'br') return [`${pad}${prefix}${text.replace(/\n/g, '<br>')}${ref}`]
  // Each line is already marked as quoted, so later lines aren't indented under the label.
  const [first, ...rest] = text.split('\n')
  const lines = [`${pad}${prefix}${first}`, ...rest.map((l) => `${pad}${l}`)]
  lines[lines.length - 1] += ref
  return lines
}

/** A reference on a line of its own, after a block whose last line can't carry it; none for none. */
function refLine(pad: string, ref: string): string[] {
  return ref ? [`${pad}${ref.trim()}`] : []
}

/** The length of the longest run of backticks in `text`. */
function longestRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
}

/**
 * Inline code: in more backticks than it has in a row, so it can't close early, with a space inside
 * each end when it starts or ends with a backtick, or with spaces on both ends (Markdown drops one
 * there). A line break ends the code and starts it again on the next line, so `<br>` stays text.
 */
export function codeSpan(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line) return ''
      const fence = '`'.repeat(longestRun(line) + 1)
      const pad = /^`|`$/.test(line) || (/^ [\s\S]* $/.test(line) && line.trim()) ? ' ' : ''
      return `${fence}${pad}${line}${pad}${fence}`
    })
    .join('\n')
}

/** Puts Markdown marks around text, keeping surrounding spaces outside them (`**a** `, not `**a **`). */
function wrap(text: string, mark: string): string {
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!
  return core ? `${lead}${mark}${core}${mark}${trail}` : text
}

/** A date mention's date as read_page shows it, after the `@`. */
export function formatDate(arg: unknown): string {
  const d = (arg ?? {}) as { start_date?: string; start_time?: string; end_date?: string; end_time?: string }
  const start = [d.start_date, d.start_time].filter(Boolean).join(' ')
  const end = [d.end_date, d.end_time].filter(Boolean).join(' ')
  return end ? `${start} → ${end}` : start || 'date'
}

/**
 * Groups sections into parts of at most `max` characters, breaking only between sections, unless
 * one section alone is longer: then it is broken between lines (and a line longer than `max`, into
 * pieces). A code block open at such a break is closed at the end of the part and opened again at
 * the start of the next, and a piece of a quoted line is quoted too. `members` lists the sections
 * each part shows, whole or in part.
 */
export function splitSections(
  sections: string[],
  max: number,
): { parts: string[]; members: { section: number; from: number; to: number }[][] } {
  type Member = { section: number; from: number; to: number }
  const parts: string[] = []
  const members: Member[][] = []
  let current = ''
  let started = false
  let inPart: Member[] = []
  const push = () => {
    if (started) {
      parts.push(current)
      members.push(inPart)
    }
    current = ''
    started = false
    inPart = []
  }
  /** Adds lines `from`..`to` (exclusive) of section `section`. */
  const add = (text: string, section: number, from: number, to: number) => {
    current = started ? `${current}\n${text}` : text
    started = true
    const last = inPart.at(-1)
    if (last && last.section === section && last.to >= from) last.to = Math.max(last.to, to)
    else inPart.push({ section, from, to })
  }
  sections.forEach((section, n) => {
    const count = section.split('\n').length
    if ((started ? current.length + 1 : 0) + section.length <= max) return add(section, n, 0, count)
    push()
    if (section.length <= max) return add(section, n, 0, count)
    /** The code block open at the current line: its opening fence line, and the line closing it. */
    let code: { open: string; close: string; prefix: string } | undefined
    section.split('\n').forEach((whole, i) => {
      const closes = !!code && whole.trimEnd() === code.close
      // A code block nested in a quote is indented after the quote marks.
      const fence = code ? undefined : /^(\s*(?:>\s*)*)(`{3,})[^`]*$/.exec(whole)
      const opens = fence ? { open: whole, close: `${fence[1]}${fence[2]}`, prefix: fence[1] } : undefined
      // Room kept for closing an open code block at the end of a part and opening it again.
      const reserve = code && !closes ? code.open.length + code.close.length + 2 : 0
      const prefix = code ? code.prefix : (/^\s*(?:>\s?)+/.exec(whole)?.[0] ?? '')
      const size = Math.max(1, max - reserve - prefix.length)
      for (let at = 0; at < Math.max(whole.length, 1); at += at ? size : size + prefix.length) {
        const line = at ? prefix + whole.slice(at, at + size) : whole.slice(0, size + prefix.length)
        // Room for the fence that closes the block this line leaves open.
        const open = closes ? undefined : (code ?? opens)
        const room = open ? open.close.length + 1 : 0
        if (started && current.length + 1 + line.length + room > max) {
          if (code) current += `\n${code.close}`
          push()
          if (code) {
            current = code.open
            started = true
          }
        }
        // A blank line that starts a part is still a line.
        add(line, n, i, i + 1)
      }
      if (closes) code = undefined
      else code ??= opens
    })
  })
  push()
  return parts.length ? { parts, members } : { parts: [''], members: [[]] }
}

/** The text of each part, as `splitSections` groups them. */
export function splitIntoParts(sections: string[], max: number): string[] {
  return splitSections(sections, max).parts
}

/**
 * Escapes characters that inline Markdown would read as formatting, links, or references, a `$`
 * that could open an inline equation, and an `@` that would read as a date.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*~[\]^|<]/g, '\\$&')
    .replace(/(?<!\w)_|_(?!\w)/g, '\\_')
    .replace(/\$(?!\s)|@(?=\d{4}-\d{2}-\d{2})/g, '\\$&')
}
