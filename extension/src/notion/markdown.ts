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
const PAGE_TYPES = new Set(['page', 'collection_view_page', 'collection_view'])
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
  }
}

class Context {
  refs = new Map<string, string>()

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
      if (lines.length) out.push(lines)
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
        return line('> ')
      case 'callout': {
        const icon = block.format?.page_icon
        const label = typeof icon === 'string' && !icon.startsWith('http') && !icon.startsWith('/') ? icon : 'callout'
        return line(`> [!${label}] `)
      }
      case 'code': {
        const language = this.plain(block.properties?.language).toLowerCase()
        const code = this.plain(block.properties?.title)
        return [
          `${pad}\`\`\`${language === 'plain text' ? '' : language}`,
          ...code.split('\n').map((l) => `${pad}${l}`),
          `${pad}\`\`\`${ref}`,
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

  private table(block: Block, pad: string): string[] {
    const columns = (block.format?.table_block_column_order as string[] | undefined) ?? []
    const rows = (block.content ?? []).map((id) => this.blocks[id]).filter((r) => r && r.alive !== false)
    if (!columns.length || !rows.length) return [`${pad}[empty table]`]
    const cells = rows.map((row) => columns.map((c) => this.rich(row.properties?.[c]).replace(/\|/g, '\\|')))
    // Markdown tables need a header row; Notion's first row is one when the table says so, and is
    // shown as one either way.
    const [head, ...body] = cells
    return [
      `${pad}| ${head.join(' | ')} |`,
      `${pad}|${columns.map(() => ' --- ').join('|')}|`,
      ...body.map((r) => `${pad}| ${r.join(' | ')} |`),
    ]
  }

  /** A database row's properties, in the database's order, skipping empty ones and the title. */
  properties(page: Block): string[] {
    if (page.parent_table !== 'collection' || !page.parent_id) return []
    const collection = this.recordMap.collection?.[page.parent_id]
    const schema = (collection?.schema ?? {}) as Record<string, { name?: string; type?: string }>
    const out: string[] = []
    for (const [key, { name, type }] of Object.entries(schema)) {
      if (key === 'title' || type === 'title') continue
      const value = page.properties?.[key]
      if (value === undefined) continue
      const shown = type === 'checkbox' ? (this.plain(value) === 'Yes' ? 'Yes' : 'No') : this.rich(value)
      if (shown) out.push(`${name ?? key}: ${shown}`)
    }
    return out
  }

  databaseName(block: Block): string {
    const id = block.collection_id as string | undefined
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
        case 'a':
          link = String(arg)
          break
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

  private userName(id: string): string {
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
function withRef(pad: string, prefix: string, text: string, ref: string): string[] {
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
  const push = () => {
    if (current) parts.push(current)
    current = ''
  }
  for (const section of sections) {
    const joined = current ? `${current}\n${section}` : section
    if (joined.length <= max) {
      current = joined
      continue
    }
    push()
    if (section.length <= max) {
      current = section
      continue
    }
    for (const line of section.split('\n')) {
      if (current && current.length + 1 + line.length > max) push()
      current = current ? `${current}\n${line}` : line
    }
  }
  push()
  return parts.length ? parts : ['']
}
