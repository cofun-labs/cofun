// Notion pages as Markdown, the form the model reads them in. Each block ends with a reference
// (` ^<ref>`, like an Obsidian block reference) so tools that change the page can point at it.
// Child pages, databases, and links to pages carry the full page id, which read_page accepts.
import type { Block, LoadedPage, NotionRecord, RecordMap } from './api'

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
  /** The first line each block shows as, without its reference, by block id. */
  lines: Map<string, string>
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
const LAYOUT_TYPES = new Set(['column_list', 'column'])
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'pdf', 'file'])

export function pageToMarkdown({ page, recordMap }: LoadedPage): PageMarkdown {
  const blocks = (recordMap.block ?? {}) as Record<string, Block>
  const ctx = new Context(recordMap, blocks)
  const isDatabase = page.type === 'collection_view_page' || page.type === 'collection_view'
  const title = isDatabase ? ctx.databaseName(page) : ctx.plain(page.properties?.title)

  // References are assigned over every block shown, so they are unique within the page.
  const shown = isDatabase ? [] : ctx.descendants(page)
  ctx.refs = blockRefs(shown)
  const sections = isDatabase ? [] : ctx.children(page, 0).map((lines) => lines.join('\n'))
  return {
    title: title || 'Untitled',
    properties: ctx.properties(page),
    sections,
    kind: isDatabase ? 'database' : 'page',
    refs: ctx.refs,
    lines: ctx.lines,
  }
}

class Context {
  refs = new Map<string, string>()
  lines = new Map<string, string>()

  constructor(
    private readonly recordMap: RecordMap,
    private readonly blocks: Record<string, Block>,
  ) {}

  /** Ids of the blocks the page shows, in order: children, but not the content of child pages. */
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

  /** The children of `parent`, each rendered with its own children. */
  children(parent: Block, depth: number): string[][] {
    const out: string[][] = []
    let number = 0
    for (const id of parent.content ?? []) {
      const block = this.blocks[id]
      if (block?.alive === false) continue
      number = block?.type === 'numbered_list' ? number + 1 : 0
      if (block && LAYOUT_TYPES.has(block.type)) {
        out.push(...this.children(block, depth))
        continue
      }
      const lines = block ? this.block(block, depth, number) : [`${indent(depth)}[block not loaded]${this.ref(id)}`]
      if (lines.length) {
        out.push(lines)
        // The block's own Markdown: its lines up to the one carrying its reference, without its
        // children, its reference, or the indentation of its depth.
        const ref = this.ref(id).trim()
        const end = lines.findIndex((l) => l.endsWith(` ${ref}`) || l.trim() === ref)
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
        return line('')
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
        const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length))
        const fence = '`'.repeat(Math.max(3, longest + 1))
        return [
          `${pad}${fence}${language === 'plain text' ? '' : language}`,
          ...code.split('\n').map((l) => `${pad}${l}`),
          `${pad}${fence}`,
          // On its own line: text after a closing fence would stop it from closing the block.
          `${pad}${ref.trim()}`,
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
        return [...this.table(block, pad), `${pad}${ref.trim()}`]
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
    const own = withRef('', label, text, ref, 'lines')
    const children = this.children(block, 0).flat()
    return [...own, ...children].map((l) => `${pad}> ${l}`)
  }

  private table(block: Block, pad: string): string[] {
    const columns = (block.format?.table_block_column_order as string[] | undefined) ?? []
    const rows = (block.content ?? []).map((id) => this.blocks[id]).filter((r) => r?.alive !== false)
    if (!columns.length || !rows.length) return [`${pad}[empty table]`]
    // A cell can't hold a raw `|` or a line break; backslashes are escaped first so the escaping
    // can be undone.
    const cell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '<br>')
    const cells = rows.map((row) =>
      row
        ? columns.map((c) => cell(this.rich(row.properties?.[c])))
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
   * A database row's properties, in the order of the database's schema, skipping empty ones and the title.
   * Without its database (the user may see the row but not the database), there are none to show.
   */
  properties(page: Block): string[] {
    if (page.parent_table !== 'collection' || !page.parent_id) return []
    const collection = this.recordMap.collection?.[page.parent_id]
    const schema = (collection?.schema ?? {}) as Record<string, { name?: string; type?: string }>
    const out: string[] = []
    for (const [key, { name, type }] of Object.entries(schema)) {
      if (key === 'title' || type === 'title') continue
      const shown = this.property(page, key, type)
      if (shown) out.push(`${name ?? key}: ${shown}`)
    }
    return out
  }

  private property(page: Block, key: string, type: string | undefined): string {
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
        return typeof user === 'string' ? `@${this.userName(user)}` : ''
      }
      // Computed by Notion when it shows the database; the row doesn't store them.
      case 'formula':
      case 'rollup':
        return `[${type}, not shown]`
      case 'checkbox':
        return page.properties?.[key] === undefined ? '' : this.plain(page.properties[key]) === 'Yes' ? 'Yes' : 'No'
      default:
        return this.rich(page.properties?.[key])
    }
  }

  databaseName(block: Block): string {
    // Linked views name their database in the format instead.
    const pointer = block.format?.collection_pointer as { id?: string } | undefined
    const id = (block.collection_id as string | undefined) ?? pointer?.id
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
    return ` ^${this.refs.get(id) ?? hexId(id)}`
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
  rich(value: unknown): string {
    return runs(value)
      .map(([text, marks = []]) => this.run(text, marks))
      .join('')
  }

  private run(text: string, marks: [string, unknown?][]): string {
    let out = text
    let link: string | undefined
    for (const [mark, arg] of marks) {
      switch (mark) {
        case 'p':
          return `[${this.pageTitle(String(arg))}](${hexId(String(arg))})`
        case 'u':
          return `@${this.userName(String(arg))}`
        case 'd':
          return `@${formatDate(arg)}`
        case 'e':
          return `$${String(arg)}$`
        case 'a': {
          // Notion links to its own pages by path (`/<id>`, `/Title-<id>`); show those as page ids,
          // which read_page opens.
          const href = String(arg)
          const page = href.startsWith('/')
            ? /[0-9a-f]{32}$/i.exec(href.split(/[?#]/)[0].replace(/-/g, ''))?.[0]
            : undefined
          link = page ? page.toLowerCase() : href
          break
        }
      }
    }
    const has = (m: string) => marks.some(([mark]) => mark === m)
    if (has('c')) out = wrap(out, '`')
    if (has('b')) out = wrap(out, '**')
    if (has('i')) out = wrap(out, '*')
    if (has('s')) out = wrap(out, '~~')
    if (link) out = `[${out}](${link})`
    return out
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
  const [first, ...rest] = text.split('\n')
  const lines = [`${pad}${prefix}${first}`, ...rest.map((l) => `${pad}${' '.repeat(prefix.length)}${l}`)]
  lines[lines.length - 1] += ref
  return lines
}

/** Puts Markdown marks around text, keeping surrounding spaces outside them (`**a** `, not `**a **`). */
function wrap(text: string, mark: string): string {
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!
  return core ? `${lead}${mark}${core}${mark}${trail}` : text
}

function formatDate(arg: unknown): string {
  const d = (arg ?? {}) as { start_date?: string; start_time?: string; end_date?: string; end_time?: string }
  const start = [d.start_date, d.start_time].filter(Boolean).join(' ')
  const end = [d.end_date, d.end_time].filter(Boolean).join(' ')
  return end ? `${start} → ${end}` : start || 'date'
}

/**
 * Groups sections into parts of at most `max` characters, breaking only between sections, unless
 * one section alone is longer: then it is broken between lines.
 */
export function splitIntoParts(sections: string[], max: number): string[] {
  const parts: string[] = []
  let current = ''
  let started = false
  const push = () => {
    if (started) parts.push(current)
    current = ''
    started = false
  }
  for (const section of sections) {
    const joined = started ? `${current}\n${section}` : section
    if (joined.length <= max) {
      current = joined
      started = true
      continue
    }
    push()
    if (section.length <= max) {
      current = section
      started = true
      continue
    }
    for (const whole of section.split('\n')) {
      // A single line longer than a part is cut into pieces of the part's size.
      for (let at = 0; at < Math.max(whole.length, 1); at += max) {
        const line = whole.slice(at, at + max)
        if (started && current.length + 1 + line.length > max) push()
        // `started`, not `current`: a blank line that starts a part is still a line.
        current = started ? `${current}\n${line}` : line
        started = true
      }
    }
  }
  push()
  return parts.length ? parts : ['']
}
