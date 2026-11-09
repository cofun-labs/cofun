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
  /^(?:📄 |🗃 |↗ |\[(?:unsupported block: [^\]]+|(?:image|video|audio|pdf|file)(?::[^\]]*)?|embed: [^\]]*|block not loaded|empty table|link to a page)\]$)/

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
    if (PLACEHOLDER.test(line)) {
      throw new MarkdownError(
        `"${line.slice(0, 60)}" stands for content edit_page can't create (a child page, database, file, ` +
          'or unsupported block). Leave that block out of new Markdown; it stays as it is unless you delete it.',
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
      const callout = /^\[!([^\]]+)\]\s?(.*)$/.exec(quoted[0])
      if (callout) {
        // Only an emoji is an icon; `[!NOTE]` and other labels leave the callout's icon as it is.
        const icon = /^\p{Extended_Pictographic}/u.test(callout[1]) ? callout[1] : undefined
        add(indent, { type: 'callout', title: inline([callout[2], ...quoted.slice(1)].join('\n')), icon, children: [] })
      } else {
        add(indent, { type: 'quote', title: inline(quoted.join('\n')), children: [] })
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

/** Inline Markdown (bold, italic, strikethrough, code, links, links to pages) as rich text. */
export function inline(text: string, marks: Mark[] = []): RichText {
  const patterns: { re: RegExp; run: (m: RegExpExecArray) => RichText }[] = [
    // A backslash keeps the next character literal, as read_page escapes them.
    { re: /\\([\\`*_~[\]^|#><])/, run: (m) => [marks.length ? [m[1], marks] : [m[1]]] },
    { re: /`([^`]+)`/, run: (m) => [[m[1], [...marks, ['c']]]] },
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
  if (last && same(last[1], marks) && !marks.some(([m]) => m === 'p')) {
    last[0] += text
    return
  }
  out.push(marks.length ? [text, marks] : [text])
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

/** read_page's <br> for a line break inside a block; an escaped \\<br> is the literal text. */
function breaks(text: string): string {
  // Escaped only behind an odd number of backslashes: `\\<br>` is a backslash, then a line break.
  return text.replace(/(?<!(?:^|[^\\])(?:\\\\)*\\)<br\s*\/?>/gi, '\n')
}
