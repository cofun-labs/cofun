// Markdown, as the model writes it, back into Notion blocks: the reverse of markdown.ts for the
// blocks that can be written. Lines that stand for content that can't be written (child pages,
// databases, media, tables, unsupported blocks) are refused, so an edit can't replace them by accident.

/** Rich text as Notion stores it: runs of `[text, [[mark, value?], …]?]`. */
export type RichText = ([string] | [string, [string, unknown?][]])[]

/** A block to create, with its children. */
export interface NewBlock {
  type: string
  title: RichText
  checked?: boolean
  language?: string
  icon?: string
  children: NewBlock[]
}

/** The Markdown can't be turned into blocks; nothing was written. */
export class MarkdownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarkdownError'
  }
}

/** Block types an edit can rewrite in place: they hold only text (and a few simple fields). */
export const TEXT_TYPES = new Set([
  'text',
  'header',
  'sub_header',
  'sub_sub_header',
  'bulleted_list',
  'numbered_list',
  'to_do',
  'toggle',
  'quote',
  'callout',
  'code',
  'equation',
  'divider',
])

const LEAF_NAMES: Record<string, string> = {
  header: 'heading',
  sub_header: 'heading',
  sub_sub_header: 'heading',
  code: 'code block',
  divider: 'divider',
  equation: 'equation',
  quote: 'quote',
  callout: 'callout',
}
const LEAF_TYPES = new Set(Object.keys(LEAF_NAMES))

/** A block reference at the end of a line (` ^1a2b3c4d` or a full id), as read_page writes them. */
const TRAILING_REF = /\s+\^[0-9a-f]{8}(?:[0-9a-f]{24})?\s*$/i
const REF_LINE = /^\s*\^[0-9a-f]{8}(?:[0-9a-f]{24})?\s*$/i
/** Lines read_page writes for content that can't be written back, and nothing else (not a `[file](url)` link). */
const PLACEHOLDER =
  /^(?:📄 |🗃 |↗ |\[(?:unsupported block: [^\]]+|(?:image|video|audio|pdf|file)(?::[^\]]*)?|embed: [^\]]*|(?:block|\d+ blocks) not loaded|empty table|link to a page|synced block|synced copy(?:, not loaded)?)\]$)/
/** The line read_page writes after a code block that has a caption. */
const CAPTION = /^\[caption: .*\]$/
/**
 * Inline code as read_page writes it: in a run of backticks the code has none as long as, with one
 * space inside each end when the code starts or ends with a backtick.
 */
const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/

export function parseMarkdown(markdown: string): NewBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const root: NewBlock[] = []
  // The open blocks by indentation, so indented lines become children.
  const stack: { indent: number; block: NewBlock }[] = []
  const add = (indent: number, block: NewBlock) => {
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop()
    const parent = stack.at(-1)?.block
    // Notion hides blocks nested under headings, code, dividers, and equations; quotes and callouts
    // show them, but their nested blocks can't be written back yet. Refuse rather than misplace them.
    if (parent && LEAF_TYPES.has(parent.type)) {
      throw new MarkdownError(`Lines can't be nested under a ${LEAF_NAMES[parent.type]}; un-indent them.`)
    }
    ;(parent?.children ?? root).push(block)
    stack.push({ indent, block })
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.trim() || REF_LINE.test(raw)) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim().replace(TRAILING_REF, '')

    const fence = /^(`{3,})(.*)$/.exec(line)
    if (fence) {
      const code: string[] = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const close = lines[j].trim().replace(TRAILING_REF, '')
        if (close.startsWith(fence[1]) && /^`+$/.test(close)) break
        code.push(lines[j].slice(Math.min(indent, lines[j].length - lines[j].trimStart().length)))
      }
      if (j === lines.length) throw new MarkdownError('A code block is missing its closing fence.')
      i = j
      const language = fence[2].trim()
      // No language on the fence means none given: a rewrite keeps the block's own.
      add(indent, { type: 'code', title: [[code.join('\n')]], ...(language ? { language } : {}), children: [] })
      continue
    }
    if (CAPTION.test(line)) {
      throw new MarkdownError(
        "Code block captions can't be written yet. Leave out the [caption: …] line; a code block you rewrite " +
          'keeps its caption.',
      )
    }
    if (PLACEHOLDER.test(line)) {
      throw new MarkdownError(
        `"${line.slice(0, 60)}" stands for content edit_page can't create (a child page, database, file, ` +
          'synced block, or unsupported block). Leave that block out of new Markdown; it stays as it is unless ' +
          'you delete it.',
      )
    }
    if (line.startsWith('|')) throw new MarkdownError("Tables can't be written yet. Write the content as a list.")

    if (line.startsWith('>')) {
      // A quote or callout runs over the following `>` lines at the same indentation.
      const quoted = [line.replace(/^>\s?/, '')]
      // …but a line that carries a block reference ends it: the next `>` line is another block.
      let ended = TRAILING_REF.test(raw)
      while (
        !ended &&
        i + 1 < lines.length &&
        lines[i + 1].trim().startsWith('>') &&
        leading(lines[i + 1]) === indent
      ) {
        ended = TRAILING_REF.test(lines[i + 1])
        quoted.push(lines[++i].trim().replace(TRAILING_REF, '').replace(/^>\s?/, ''))
      }
      // read_page draws blocks nested in a quote with the quote's prefix; those can't be written yet.
      const nested = quoted.some((l, n) =>
        /^(?:[-*+]\s|\d+[.)]\s|#{1,3}\s|▸|`{3})/.test(n ? l : l.replace(/^\[![^\]]+\]\s?/, '')),
      )
      if (nested) {
        throw new MarkdownError(
          "Blocks nested inside a quote or callout (lists, headings, toggles, code) can't be written yet; " +
            'write them after it instead.',
        )
      }
      // A leading backslash keeps a line that looks like a list or heading as text.
      const unlead = (l: string) => (l.startsWith('\\') ? l.slice(1) : l)
      const callout = /^\[!([^\]]+)\]\s?(.*)$/.exec(quoted[0])
      if (callout) {
        // Only an emoji is an icon; `[!NOTE]` and other labels leave the callout's icon as it is.
        const icon = /^\p{Extended_Pictographic}/u.test(callout[1]) ? callout[1] : undefined
        const text = [callout[2], ...quoted.slice(1)].map(unlead).join('\n')
        add(indent, { type: 'callout', title: inline(text), icon, children: [] })
      } else {
        add(indent, { type: 'quote', title: inline(quoted.map(unlead).join('\n')), children: [] })
      }
      continue
    }

    add(indent, lineBlock(line))
  }
  return root
}

function leading(line: string): number {
  return line.length - line.trimStart().length
}

function lineBlock(line: string): NewBlock {
  // A backslash keeps text that looks like a list, heading, or quote as a paragraph.
  if (line.startsWith('\\')) return { type: 'text', title: inline(breaks(line.slice(1))), children: [] }
  const block = (type: string, text: string, extra: Partial<NewBlock> = {}): NewBlock => ({
    type,
    // read_page shows line breaks inside a block as <br>.
    title: inline(breaks(text)),
    children: [],
    ...extra,
  })
  let m: RegExpExecArray | null
  if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
    return block(['header', 'sub_header', 'sub_sub_header'][m[1].length - 1], m[2])
  }
  if ((m = /^[-*+]\s+\[([ xX])\]\s?(.*)$/.exec(line))) return block('to_do', m[2], { checked: m[1] !== ' ' })
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) return { type: 'divider', title: [], children: [] }
  if ((m = /^[-*+]\s+(.*)$/.exec(line))) return block('bulleted_list', m[1])
  if ((m = /^\d+[.)]\s+(.*)$/.exec(line))) return block('numbered_list', m[1])
  if ((m = /^▸\s?(.*)$/.exec(line))) return block('toggle', m[1])
  if ((m = /^\$\$(.+)\$\$$/.exec(line))) return { type: 'equation', title: [[m[1]]], children: [] }
  return block('text', line)
}

type Mark = [string, unknown?]

/**
 * A mention of a person by the name `@[Name]` gives, stored in a `u` mark until it is matched to a
 * member's id (see people.ts).
 */
export interface PersonName {
  name: string
}

/** Inline Markdown (bold, italic, strikethrough, code, links, links to pages, people) as rich text. */
export function inline(text: string, marks: Mark[] = []): RichText {
  const patterns: { re: RegExp; run: (m: RegExpExecArray) => RichText }[] = [
    // A backslash keeps the next character literal, as read_page escapes them.
    { re: /\\([\\`*_~[\]^|#><])/, run: (m) => [marks.length ? [m[1], marks] : [m[1]]] },
    {
      re: CODE_SPAN,
      // Markdown drops one space from each end of code that has spaces on both (and isn't all spaces).
      run: (m) => [[/^ [\s\S]* $/.test(m[2]) && m[2].trim() ? m[2].slice(1, -1) : m[2], [...marks, ['c']]]],
    },
    {
      // `@[Name]` mentions a person, as read_page shows mentions; `@[text](url)` is an @ before a link.
      // read_page writes a parenthesis right after a mention as `\(`; the backslash goes with the mention.
      re: /@\[((?:\\.|[^\]\\])+)\](?!\()(?:\\(?=\())?/,
      run: (m) => {
        const name = m[1].replace(/\\(.)/g, '$1').trim()
        return name ? [['‣', [...marks, ['u', { name } satisfies PersonName]]]] : [[m[0], marks]]
      },
    },
    {
      // A URL may hold one level of parentheses, as in …/wiki/Foo_(bar).
      re: /\[((?:\\.|[^\]\\])+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/,
      run: (m) => {
        // A link to a 32-hex id is a link to a Notion page, as read_page shows mentions.
        const page = /^[0-9a-f]{32}$/i.test(m[2]) ? dashed(m[2].toLowerCase()) : undefined
        if (page) return [['‣', [...marks, ['p', page]]]]
        // Only web, mail, and Notion page links; anything else (javascript:, data:, …) stays text.
        if (!/^(?:https?:|mailto:|\/(?!\/))/i.test(m[2])) return [marks.length ? [m[0], marks] : [m[0]]]
        return inline(m[1], [...marks, ['a', m[2]]])
      },
    },
    { re: /\*\*\*(.+?)\*\*\*/, run: (m) => inline(m[1], [...marks, ['b'], ['i']]) },
    { re: /\*\*(.+?)\*\*/, run: (m) => inline(m[1], [...marks, ['b']]) },
    { re: /~~(.+?)~~/, run: (m) => inline(m[1], [...marks, ['s']]) },
    { re: /(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/, run: (m) => inline(m[1], [...marks, ['i']]) },
    { re: /(?<![_\w])_(?![\s_])(.+?)(?<![\s_])_(?![_\w])/, run: (m) => inline(m[1], [...marks, ['i']]) },
  ]
  const out: RichText = []
  let rest = text
  while (rest) {
    let best: { index: number; length: number; runs: RichText } | undefined
    for (const { re, run } of patterns) {
      const m = re.exec(rest)
      if (m && (!best || m.index < best.index)) best = { index: m.index, length: m[0].length, runs: run(m) }
    }
    if (!best) {
      push(out, rest, marks)
      break
    }
    if (best.index) push(out, rest.slice(0, best.index), marks)
    for (const r of best.runs) push(out, r[0], r[1] ?? [])
    rest = rest.slice(best.index + best.length)
  }
  return out
}

/** Adds a run, merging it into the previous one when their marks are the same. */
function push(out: RichText, text: string, marks: Mark[]) {
  if (!text) return
  const last = out.at(-1)
  const same = (a: Mark[] = [], b: Mark[]) => JSON.stringify(a) === JSON.stringify(b)
  // Each mention is a run of its own.
  if (last && same(last[1], marks) && !marks.some(([m]) => m === 'p' || m === 'u')) {
    last[0] += text
    return
  }
  out.push(marks.length ? [text, marks] : [text])
}

/** The rich text of blocks and of everything nested in them. */
export function blockTitles(blocks: NewBlock[]): RichText[] {
  return blocks.flatMap((b) => [b.title, ...blockTitles(b.children)])
}

function personName(mark: Mark): string | undefined {
  const value = mark[1] as Partial<PersonName> | undefined
  return mark[0] === 'u' && typeof value?.name === 'string' ? value.name : undefined
}

/** The names `@[Name]` mentions in rich text, each once. */
export function personNames(titles: RichText[]): string[] {
  const names = titles.flatMap((t) => t.flatMap((r) => (r[1] ?? []).flatMap((m) => personName(m) ?? [])))
  return [...new Set(names)]
}

/**
 * Rich text with each person's name replaced by their user id, from `ids` (by name). `keep` leaves
 * a name `ids` lacks as it is; otherwise one is a bug, since names are looked up before writing.
 */
export function withPeople(title: RichText, ids: Map<string, string>, { keep = false } = {}): RichText {
  return title.map((run) => {
    if (!run[1]?.some((m) => personName(m) !== undefined)) return run
    const marks = run[1].map((m): Mark => {
      const name = personName(m)
      if (name === undefined) return m
      const id = ids.get(name)
      if (!id && keep) return m
      if (!id) throw new Error(`No member was found for @[${name}].`)
      return ['u', id]
    })
    return [run[0], marks]
  })
}

/** Blocks with each person's name replaced by their user id, from `ids` (by name). */
export function blocksWithPeople(blocks: NewBlock[], ids: Map<string, string>): NewBlock[] {
  return blocks.map((b) => ({ ...b, title: withPeople(b.title, ids), children: blocksWithPeople(b.children, ids) }))
}

function dashed(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Notion's names for the languages people write most; others are kept as given. */
const LANGUAGES: Record<string, string> = Object.fromEntries(
  [
    'Bash',
    'C',
    'C#',
    'C++',
    'CSS',
    'Dart',
    'Docker',
    'Go',
    'GraphQL',
    'HTML',
    'Java',
    'JavaScript',
    'JSON',
    'Kotlin',
    'Markdown',
    'Mermaid',
    'PHP',
    'Plain Text',
    'PowerShell',
    'Python',
    'Ruby',
    'Rust',
    'Scala',
    'Shell',
    'SQL',
    'Swift',
    'TypeScript',
    'XML',
    'YAML',
  ].map((name) => [name.toLowerCase(), name]),
)
const ALIASES: Record<string, string> = {
  js: 'JavaScript',
  ts: 'TypeScript',
  py: 'Python',
  sh: 'Shell',
  yml: 'YAML',
  md: 'Markdown',
  '': 'Plain Text',
}

/** A code fence's language as Notion names it (`typescript` → `TypeScript`). */
export function notionLanguage(language: string): string {
  const key = language.trim().toLowerCase()
  return LANGUAGES[key] ?? ALIASES[key] ?? language.trim()
}

/**
 * read_page's <br> for a line break inside a block; an escaped \\<br> is the literal text, and so is
 * a <br> inside inline code (read_page ends the code before a line break).
 */
function breaks(text: string): string {
  // A backtick behind an odd number of backslashes is a literal backtick, not the start of code.
  const code = new RegExp(`(?<!(?:^|[^\\\\])(?:\\\\\\\\)*\\\\)${CODE_SPAN.source}`, 'g')
  let out = ''
  let at = 0
  for (const m of text.matchAll(code)) {
    out += lineBreaks(text.slice(at, m.index)) + m[0]
    at = m.index + m[0].length
  }
  return out + lineBreaks(text.slice(at))
}

function lineBreaks(text: string): string {
  // Escaped only behind an odd number of backslashes: `\\<br>` is a backslash, then a line break.
  return text.replace(/(?<!(?:^|[^\\])(?:\\\\)*\\)<br\s*\/?>/gi, '\n')
}
