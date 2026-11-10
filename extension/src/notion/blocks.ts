// Markdown, as the model writes it, back into Notion blocks: the reverse of markdown.ts for the
// blocks that can be written. Lines that stand for content that can't be written (child pages,
// databases, media, unsupported blocks) are refused, so an edit can't replace them by accident.

/** Rich text as Notion stores it: runs of `[text, [[mark, value?], …]?]`. */
export type RichText = ([string] | [string, [string, unknown?][]])[]

/** A block to create, with its children. */
export interface NewBlock {
  type: string
  title: RichText
  checked?: boolean
  language?: string
  icon?: string
  /**
   * A code block's caption as read_page shows it (`[caption: …]` right after the fence), as
   * Markdown. Captions can't be written yet: it only lets a rewrite pass the caption back unchanged.
   */
  caption?: string
  /** A heading with blocks nested under it: Notion shows those only under a toggle heading. */
  toggleable?: boolean
  /** A table's cells, row by row, the first row being its header; every row has the same length. */
  rows?: RichText[][]
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

/** Heading types: a heading holds nested blocks only as a toggle heading. */
export const HEADING_TYPES = new Set(['header', 'sub_header', 'sub_sub_header'])

/** Blocks Notion shows nothing nested under. */
const LEAF_NAMES: Record<string, string> = {
  code: 'code block',
  divider: 'divider',
  equation: 'equation',
  table: 'table',
}
const LEAF_TYPES = new Set(Object.keys(LEAF_NAMES))

/** A block reference at the end of a line (` ^1a2b3c4d` or a full id), as read_page writes them. */
const TRAILING_REF = /\s+\^[0-9a-f]{8}(?:[0-9a-f]{24})?\s*$/i
const REF_LINE = /^\s*\^[0-9a-f]{8}(?:[0-9a-f]{24})?\s*$/i
/** Lines read_page writes for content that can't be written back, and nothing else (not a `[file](url)` link). */
const PLACEHOLDER =
  /^(?:📄 |🗃 |↗ |\[(?:unsupported block: [^\]]+|(?:image|video|audio|pdf|file)(?::[^\]]*)?|embed: [^\]]*|(?:block|\d+ blocks) not loaded|empty table|link to a page|synced block|synced copy(?:, not loaded)?)\]$)/
/** The line read_page writes after a code block that has a caption. */
const CAPTION = /^\[caption: (.*)\]$/
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
    // Notion hides blocks nested under code, dividers, equations, and tables: refuse rather than
    // misplace them.
    if (parent && LEAF_TYPES.has(parent.type)) {
      throw new MarkdownError(`Lines can't be nested under a ${LEAF_NAMES[parent.type]}; un-indent them.`)
    }
    // Lines nested under a heading make it a toggle heading, as read_page shows one.
    if (parent && HEADING_TYPES.has(parent.type)) parent.toggleable = true
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
      // The caption line read_page writes right after the fence belongs to the code block.
      const caption = i + 1 < lines.length ? CAPTION.exec(lines[i + 1].trim().replace(TRAILING_REF, '')) : null
      if (caption) i++
      // No language on the fence means none given: a rewrite keeps the block's own.
      add(indent, {
        type: 'code',
        title: [[code.join('\n')]],
        ...(language ? { language } : {}),
        ...(caption ? { caption: caption[1] } : {}),
        children: [],
      })
      continue
    }
    if (CAPTION.test(line)) {
      throw new MarkdownError(
        "A [caption: …] line belongs right after a code block's closing fence. Code block captions can't be " +
          'written yet; a code block you rewrite keeps its caption.',
      )
    }
    if (PLACEHOLDER.test(line)) {
      throw new MarkdownError(
        `"${line.slice(0, 60)}" stands for content edit_page can't create (a child page, database, file, ` +
          'synced block, or unsupported block). Leave that block out of new Markdown; it stays as it is unless ' +
          'you delete it.',
      )
    }
    if (line.startsWith('|')) {
      // A table runs over the following `|` lines at the same indentation.
      const rows = [line]
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|') && leading(lines[i + 1]) === indent) {
        rows.push(lines[++i].trim().replace(TRAILING_REF, ''))
      }
      add(indent, table(rows))
      continue
    }

    if (line.startsWith('>')) {
      // A quote or callout runs over the following `>` lines at the same indentation: first its own
      // text, a line break between each, then the blocks nested in it. read_page indents those by
      // two spaces after the `>`; written by hand, a line that starts a list, heading, or other
      // block starts them too (text that only looks like one starts with a backslash).
      const own = [line.replace(/^>\s?/, '')]
      // read_page draws blocks nested in a quote that way; on its own, such a line isn't a quote.
      if (/^\s{2}/.test(own[0])) {
        throw new MarkdownError(
          '`>   ` starts a block nested in a quote or callout, as read_page draws it. To write that block by ' +
            'its own reference, leave out the `>` and the indentation after it.',
        )
      }
      const nested: string[] = []
      const callout = /^\[!([^\]]+)\]\s?(.*)$/.exec(own[0])
      if (callout && BLOCK_START.test(callout[2])) {
        own[0] = `[!${callout[1]}]`
        nested.push(callout[2])
      } else if (!callout && BLOCK_START.test(own[0])) {
        nested.push(own.pop()!)
      }
      // A line that carries a block reference ends that block: after the quote's own text, the
      // next line at its own indentation is another block, as read_page draws two quotes in a row.
      let referenced = TRAILING_REF.test(raw)
      // The fence of a code block open among the nested lines: its lines, blank ones too, are its own.
      let fence: string | undefined
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('>') && leading(lines[i + 1]) === indent) {
        // Only the start is trimmed: a code line keeps its trailing spaces, and a blank one (`>   `)
        // its indentation.
        const next = lines[i + 1].trimStart().replace(/^>\s?/, '')
        const deeper = /^\s{2}/.test(next)
        // A line that starts a block is nested in the quote even after its reference: read_page
        // starts the text of a quote with a backslash when it looks like one.
        if (!deeper && referenced && !fence && !BLOCK_START.test(next)) break
        i++
        if (deeper || nested.length || BLOCK_START.test(next)) {
          nested.push(next)
          const code = /^\s*(`{3,})/.exec(next)
          if (!fence && code) fence = code[1]
          else if (fence && /^`+$/.test(next.trim().replace(TRAILING_REF, '')) && next.trim().startsWith(fence))
            fence = undefined
        } else own.push(next.replace(TRAILING_REF, '').trimEnd())
        if (TRAILING_REF.test(next)) referenced = true
      }
      // A leading backslash keeps a line that looks like a list or heading as text.
      const unlead = (l: string) => (l.startsWith('\\') ? l.slice(1) : l)
      const children = nested.length ? parseMarkdown(nested.join('\n')) : []
      if (callout) {
        // Only an emoji is an icon; `[!NOTE]` and other labels leave the callout's icon as it is.
        const icon = /^\p{Extended_Pictographic}/u.test(callout[1]) ? callout[1] : undefined
        const first = /^\[![^\]]+\]\s?(.*)$/.exec(own[0])![1]
        const text = [first, ...own.slice(1)].map(unlead).join('\n')
        add(indent, { type: 'callout', title: inline(text), icon, children })
      } else {
        add(indent, { type: 'quote', title: inline(own.map(unlead).join('\n')), children })
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

/** A line inside a quote that starts a block of its own, not more of the quote's text. */
const BLOCK_START = /^(?:#{1,3}\s|[-*+]\s|\d+[.)]\s|>|▸|`{3}|\$\$|\||(?:-{3,}|\*{3,}|_{3,})$)/

/**
 * A Markdown table as a table block: its first row is the header, and a line of dashes after it
 * is left out. A `|` escaped by a backslash is part of a cell, in code too, as read_page writes it.
 */
function table(lines: string[]): NewBlock {
  // A separator line has a cell of three dashes or more, or dashes with a colon (`:-`), in each
  // column, as in GFM; a row of single dashes is data (`| - | - |` for "none").
  const separator = (row: string[]) => row.every((c) => /^(?:-{3,}|:-+:?|-+:)$/.test(c.trim()))
  const rows = lines.map(cells).filter((row, n) => !(n === 1 && separator(row)))
  const width = rows[0].length
  if (rows.some((row) => row.length > width)) {
    throw new MarkdownError('A table row has more cells than the header row. Give every row the same columns.')
  }
  if (rows.some((row) => row.some((c) => PLACEHOLDER.test(c.trim()) || /^\[row not loaded\]$/.test(c.trim())))) {
    throw new MarkdownError("A table cell stands for content edit_page can't write. Leave that row out.")
  }
  return {
    type: 'table',
    title: [],
    rows: rows.map((row) =>
      [...row, ...Array<string>(width - row.length).fill('')].map((c) => inline(breaks(c.trim()))),
    ),
    children: [],
  }
}

/** The cells of a table row: split at each `|` not behind a backslash, with `\|` read as `|`. */
function cells(line: string): string[] {
  const inner = line.replace(/^\|/, '').replace(/(?<!\\)\|\s*$/, '')
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|'))
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

/** A date mention's value as Notion stores it. */
export interface DateValue {
  type: 'date' | 'datetime' | 'daterange' | 'datetimerange'
  start_date: string
  start_time?: string
  end_date?: string
  end_time?: string
}

/** A date as read_page shows a date mention: `@2026-11-10`, with a time and an end if it has them. */
const DATE = /(?<![\w@])@(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?(?: → (\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?)?/

/** Text colors and backgrounds, as Notion stores them (`red`, `blue_background`, …); Notion's green is `teal`. */
export const COLOR = /^(?:gray|brown|orange|yellow|teal|blue|purple|pink|red)(?:_background)?$/

/**
 * Inline Markdown (bold, italic, strikethrough, code, links, links to pages, people, dates, inline
 * equations, colors) as rich text.
 */
export function inline(text: string, marks: Mark[] = []): RichText {
  const patterns: { re: RegExp; run: (m: RegExpExecArray) => RichText }[] = [
    // A backslash keeps the next character literal, as read_page escapes them.
    { re: /\\([\\`*_~[\]^|#><$@])/, run: (m) => [marks.length ? [m[1], marks] : [m[1]]] },
    {
      // `$x^2$` is an inline equation, its LaTeX as it is. As in Pandoc, `$` opens one only before
      // a non-space and closes it only after one, and not before a letter or digit, so prices and
      // `$HOME/$USER` stay text.
      re: /\$(?=\S)((?:\\.|[^$\\\n])+?)(?<=\S)\$(?!\w)/,
      run: (m) => [['⁍', [...marks, ['e', m[1]]]]],
    },
    {
      re: DATE,
      run: (m) => {
        // A date or time that doesn't exist stays text rather than being sent to Notion.
        if (![m[1], m[3]].every((d) => !d || realDate(d)) || ![m[2], m[4]].every((t) => !t || realTime(t))) {
          return [marks.length ? [m[0], marks] : [m[0]]]
        }
        // A range has a time at both ends or at neither: one given at one end is taken for both.
        const time = m[3] ? (m[2] ?? m[4]) : m[2]
        const value: DateValue = {
          type: m[3] ? (time ? 'datetimerange' : 'daterange') : time ? 'datetime' : 'date',
          start_date: m[1],
          ...(time ? { start_time: m[2] ?? time } : {}),
          ...(m[3] ? { end_date: m[3] } : {}),
          ...(m[3] && time ? { end_time: m[4] ?? time } : {}),
        }
        return [['‣', [...marks, ['d', value]]]]
      },
    },
    {
      // A colored run, as read_page shows one.
      // An escaped `\</span>` is text inside it.
      re: /<span color="([^"]*)">([\s\S]+?)(?<!(?:^|[^\\])(?:\\\\)*\\)<\/span>/,
      run: (m) => {
        // Green as the Notion app names it.
        const color = m[1].replace(/^green(?=$|_)/, 'teal')
        if (!COLOR.test(color)) {
          throw new MarkdownError(
            `"${m[1]}" isn't a Notion color. Use one of gray, brown, orange, yellow, green, blue, purple, pink, ` +
              'or red, each also as a background (red_background).',
          )
        }
        return inline(m[2], [...marks, ['h', color]])
      },
    },
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
    // The earliest match wins; only it is turned into runs, so a pattern that refuses what it
    // matched (an unknown color) doesn't fire inside one that comes first (inline code).
    let best: { index: number; length: number; m: RegExpExecArray; run: (m: RegExpExecArray) => RichText } | undefined
    for (const { re, run } of patterns) {
      const m = re.exec(rest)
      if (m && (!best || m.index < best.index)) best = { index: m.index, length: m[0].length, m, run }
    }
    if (!best) {
      push(out, rest, marks)
      break
    }
    if (best.index) push(out, rest.slice(0, best.index), marks)
    for (const r of best.run(best.m)) push(out, r[0], r[1] ?? [])
    rest = rest.slice(best.index + best.length)
  }
  return out
}

/** Marks of runs that each stand for one thing (a page, a person, a date, an equation). */
const MENTION_MARKS = new Set(['p', 'u', 'd', 'e'])

/** Adds a run, merging it into the previous one when their marks are the same. */
function push(out: RichText, text: string, marks: Mark[]) {
  if (!text) return
  const last = out.at(-1)
  const same = (a: Mark[] = [], b: Mark[]) => JSON.stringify(a) === JSON.stringify(b)
  // Each mention and inline equation is a run of its own.
  if (last && same(last[1], marks) && !marks.some(([m]) => MENTION_MARKS.has(m))) {
    last[0] += text
    return
  }
  out.push(marks.length ? [text, marks] : [text])
}

/** The rich text of blocks (a table's cells too) and of everything nested in them. */
export function blockTitles(blocks: NewBlock[]): RichText[] {
  return blocks.flatMap((b) => [b.title, ...(b.rows?.flat() ?? []), ...blockTitles(b.children)])
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
  return blocks.map((b) => ({
    ...b,
    title: withPeople(b.title, ids),
    ...(b.rows ? { rows: b.rows.map((row) => row.map((cell) => withPeople(cell, ids))) } : {}),
    children: blocksWithPeople(b.children, ids),
  }))
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

/** Whether `YYYY-MM-DD` is a day on the calendar. */
function realDate(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === date
}

/** Whether `HH:MM` is a time of day. */
function realTime(time: string): boolean {
  const [h, m] = time.split(':').map(Number)
  return h < 24 && m < 60
}
