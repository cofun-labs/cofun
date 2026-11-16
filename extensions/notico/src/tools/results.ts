// Long results of the tools that read outside content (the tabs, web pages): the full text is kept
// on the device (KeptResult, in the saved sessions' store), and the model gets its first part, an
// outline, and an id, with which read_result reads another part and search_result finds text in it.
// Notion's tools read Notion live, in parts of their own, and keep nothing.
import type { KeptResult, ToolResult } from '@cofun/base/agent'
import { clip } from '../notion/comments'
import { defineTool, type ToolContext } from '../tool'
import { z } from '@cofun/base/zod'
import { READ, SEARCH, asData, asPageText, count, nameOf, partArg } from './shared'

/** How much of a kept result one part holds; a result no longer than this is given whole, and not kept. */
const RESULT_PART_CHARS = 20_000
/** How much of one result is kept at most (about 4 MB); the rest is dropped, and the result says so. */
export const KEPT_CHARS = 2_000_000

/** Headings an outline lists at most; a long outline would crowd out the part it goes with. */
const OUTLINE_HEADINGS = 80
const HEADING_CHARS = 120
const TITLE_CHARS = 200
const URL_CHARS = 2000
/** Matches search_result gives at most, and how much of a long line it shows around a match. */
const MATCHES = 20
const LINE_CHARS = 300
const QUERY_CHARS = 200
/**
 * How much of a question's tool results read_result adds parts to, at most: well under the 200,000
 * characters the hosted model takes for a whole request, with the system prompt and the tools.
 */
const QUESTION_PART_CHARS = 120_000

const en = (n: number) => n.toLocaleString('en-US')

/**
 * Where each part of `text` starts. A part ends before a heading when one starts in its second
 * half, else at a line break there, so sections and lines are seldom cut; and never inside a
 * character that takes two UTF-16 units.
 */
function partStarts(text: string, size = RESULT_PART_CHARS): number[] {
  const starts = [0]
  let at = 0
  while (text.length - at > size) {
    let end = at + size
    const half = at + Math.ceil(size / 2)
    // Only the second half is searched, so splitting a long text stays linear.
    const second = text.slice(half, end)
    const heading = second.lastIndexOf('\n#', second.length - 2)
    const newline = second.lastIndexOf('\n')
    if (heading >= 0) end = half + heading + 1
    else if (newline >= 0) end = half + newline + 1
    else if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--
    starts.push(end)
    at = end
  }
  return starts
}

/** The part (from 1) the character at `offset` is in. */
const partAt = (starts: number[], offset: number) => starts.findLastIndex((start) => start <= offset) + 1

/** The text of part `part` (from 1). */
const partText = (text: string, starts: number[], part: number) => text.slice(starts[part - 1], starts[part])

/** What precedes the text: how a tool labels it. */
const label = (kept: Pick<KeptResult, 'markdown'>) => (kept.markdown ? 'Content, as Markdown:' : 'Text:')

/**
 * The Markdown headings of `text` with the part each starts in, as lines; the titles as JSON, so
 * they stay inside their quotes; none when the text has no headings. A plain read's text marks its
 * headings too, and a render's is Markdown. Headings in code blocks are left out.
 */
function outline(text: string, starts: number[]): string[] {
  const headings: string[] = []
  let total = 0
  let fenced = false
  let offset = 0
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const heading = fenced ? undefined : headingOf(line)
    if (heading) {
      total++
      if (headings.length < OUTLINE_HEADINGS)
        headings.push(
          `- part ${partAt(starts, offset)}: ${heading.marks} ${JSON.stringify(clip(heading.title, HEADING_CHARS))}`,
        )
    }
    offset += line.length + 1
  }
  if (!headings.length) return []
  return [
    'Outline (its headings, with the part each starts in):',
    ...headings,
    ...(total > headings.length ? [`- and ${count(total - headings.length, 'more heading')}`] : []),
  ]
}

/**
 * A Markdown heading line's marks and title, without the closing marks it may end with. Read by
 * hand, not with one regex: a line from the page with a long run of spaces would make a regex
 * backtrack for seconds, on the side panel's thread.
 */
function headingOf(line: string): { marks: string; title: string } | undefined {
  const open = /^#{1,6}\s/.exec(line)
  if (!open) return undefined
  let title = line.slice(open[0].length).trim()
  let end = title.length
  while (end > 0 && title[end - 1] === '#') end--
  if (end < title.length && (end === 0 || /\s/.test(title[end - 1]))) title = title.slice(0, end).trim()
  return title ? { marks: open[0].trimEnd(), title } : undefined
}

/** The page a kept result is of, on one line: its title and URL as JSON. */
const pageOf = (kept: Pick<KeptResult, 'title' | 'url'>) =>
  JSON.stringify({ title: clip(kept.title, TITLE_CHARS), url: clip(kept.url, URL_CHARS) })

/** The note on what of the text was kept, when not all of it. */
function droppedNote(kept: Pick<KeptResult, 'text' | 'chars'>, longer: boolean): string[] {
  if (kept.text.length >= kept.chars && !longer) return []
  return [
    `[Only the first ${en(kept.text.length)} of the page's ${longer ? 'more than ' : ''}${en(kept.chars)} ` +
      'characters were read: the rest of it is out of reach.]',
  ]
}

/** What a tool that reads outside content gives for its text: see `withText`. */
export interface ReadText {
  /** The tool, and the page the text is of. */
  tool: string
  title: string
  url: string
  markdown: boolean
  /** The text read, up to KEPT_CHARS. */
  text: string
  /** How long the whole text is; more than `text` when it was clipped. */
  chars: number
  /** The page is longer still than `chars` says: it was cut before its length was known. */
  longer?: boolean
}

/**
 * A tool's result for text read from outside: `header`, its own lines, then the text. Text no
 * longer than one part is given whole. Longer text is kept on the device, and the result gives its
 * first part, its outline, and its id, which `details.result` names it by, so the conversation can
 * read the other parts. When it can't be kept, the result gives the first part, clipped.
 */
export async function withText(
  header: string[],
  read: ReadText,
  name: string,
  context: ToolContext,
): Promise<ToolResult> {
  const { longer = false, ...rest } = read
  const kept = { ...rest, text: read.text.slice(0, KEPT_CHARS) }
  if (kept.text.length <= RESULT_PART_CHARS) {
    const lines = [...header, ...clippedNote(kept, longer), label(kept), asPageText(kept.text)]
    return { text: asData(lines), details: { name } }
  }
  const starts = partStarts(kept.text)
  const first = partText(kept.text, starts, 1)
  let id: string | undefined
  try {
    id = await context.keep(kept)
  } catch (err) {
    console.error('Could not keep a long result', err)
  }
  if (!id) {
    const note =
      `[Clipped: this shows the first ${en(first.length)} of the page's ${longer ? 'more than ' : ''}` +
      `${en(kept.chars)} characters. The rest could not be kept on the device, so no other part can be read.]`
    return { text: asData([...header, note, label(kept), asPageText(first)]), details: { name } }
  }
  const lines = [
    ...header,
    `[Kept as result ${id}: ${en(kept.text.length)} characters in ${starts.length} parts; this is part 1. Read ` +
      'another part with read_result, or find text in it with search_result.]',
    ...droppedNote(kept, longer),
    ...outline(kept.text, starts),
    label(kept),
    asPageText(first),
  ]
  return { text: asData(lines), details: { name, result: id } }
}

/** The note that the text shown is the first part of a longer one: none when it is all of it. */
function clippedNote(shown: { text: string; chars: number }, longer: boolean): string[] {
  if (shown.text.length >= shown.chars && !longer) return []
  return [
    `[Clipped: this shows the first ${en(shown.text.length)} of the page's ${longer ? 'more than ' : ''}` +
      `${en(shown.chars)} characters.]`,
  ]
}

const ResultArg = z.string().describe('The id of the kept result, as its note gave it ("r_…").')

/** The kept result the model named, or why it can't be read. */
async function keptResult(id: string, context: ToolContext): Promise<KeptResult> {
  const given = id.trim()
  const kept = await context.kept(given)
  if (kept === 'unknown')
    throw new Error(
      `No result ${JSON.stringify(clip(given, 40))} was kept in this chat: give an id a note in this chat gave ` +
        '("Kept as result r_…").',
    )
  if (kept === 'gone')
    throw new Error(
      `Result ${given} is not kept on this device any more (a result is kept for 7 days, and site data may ` +
        'have been cleared): read the page again.',
    )
  return kept
}

export const readResult = defineTool({
  name: 'read_result',
  description:
    'Reads another part of a long result a tool kept on the device, such as a long web page or tab: a result ' +
    'whose note says "Kept as result r_…" gives only its first part. Give the part to read, from 1; the note ' +
    'and the outline say how many there are and where each heading starts. Read the parts the question needs, ' +
    'not all of them: for a fact or a passage, search_result finds it first.',
  describe: (_args, details) =>
    details?.name ? { verb: READ, name: details.name } : { verb: READ, what: 'more of a page' },
  args: z.strictObject({
    result: ResultArg,
    part: partArg('The part to read, from 1.'),
  }),
  run: async ({ result, part = 1 }, _signal, context) => {
    const kept = await keptResult(result, context)
    const starts = partStarts(kept.text)
    if (part > starts.length)
      throw new Error(
        `Result ${kept.id} has ${count(starts.length, 'part')}: give \`part\` from 1 to ${starts.length}.`,
      )
    const text = partText(kept.text, starts, part)
    // A question's own tool results are all sent with each step, and the hosted model takes
    // MAX_CONTENT_CHARS in all (worker/src/routes/chat-request.ts): past this, read no more parts.
    const used = context.questionChars()
    if (used + text.length > QUESTION_PART_CHARS)
      throw new Error(
        `Not read: this question already holds ${en(used)} characters of results, and another part would leave no ` +
          'room for the answer. Answer from what you read, find what is missing with search_result, or tell the user ' +
          'which part to read in a next question.',
      )
    const from = starts[part - 1]
    const lines = [
      `Result ${kept.id}, of ${kept.tool}: ${pageOf(kept)}`,
      `[Part ${part} of ${starts.length}: characters ${en(from + 1)} to ${en(from + text.length)} of ` +
        `${en(kept.text.length)}.]`,
      label(kept),
      asPageText(text),
    ]
    return { text: asData(lines), details: { name: nameOf(kept.title) } }
  },
})

export const searchResult = defineTool({
  name: 'search_result',
  description:
    'Finds text in a long result a tool kept on the device (its note says "Kept as result r_…"): the lines that ' +
    `contain the text, ignoring case, at most ${MATCHES}, each with the part it is in, so read_result can read ` +
    'around it. The text is matched as it is, not as a pattern. Use it to find a fact, a name, or a passage ' +
    'in a long page instead of reading every part.',
  describe: (args, details) => {
    const text = args?.text.trim()
    return text
      ? { verb: SEARCH, what: details?.name ? `${details.name} for` : 'a page for', name: text }
      : { verb: SEARCH, what: 'a page' }
  },
  args: z.strictObject({
    result: ResultArg,
    text: z.string().describe('The text to find, on one line.'),
  }),
  run: async ({ result, text }, _signal, context) => {
    const query = text.trim()
    if (!query) throw new Error('Not searched: `text` is empty.')
    if (query.includes('\n'))
      throw new Error('Not searched: `text` must be on one line; lines are matched one at a time.')
    if (query.length > QUERY_CHARS)
      throw new Error(`Not searched: \`text\` is ${query.length} characters long; at most ${QUERY_CHARS} are searched.`)
    const kept = await keptResult(result, context)
    const starts = partStarts(kept.text)
    const needle = query.toLowerCase()
    const matches: string[] = []
    let found = 0
    let offset = 0
    kept.text.split('\n').forEach((line, n) => {
      const at = line.toLowerCase().indexOf(needle)
      if (at >= 0) {
        found++
        if (matches.length < MATCHES)
          matches.push(
            `Part ${partAt(starts, offset + at)}, line ${en(n + 1)}: ${asPageText(around(line, at, query.length))}`,
          )
      }
      offset += line.length + 1
    })
    const lines = [
      `Search of result ${kept.id}, of ${kept.tool}, for ${JSON.stringify(query)}: ${pageOf(kept)}`,
      found
        ? `[${count(found, 'line')} of ${en(kept.text.length)} characters in ${count(starts.length, 'part')} ` +
          `${found === 1 ? 'contains' : 'contain'} it${found > MATCHES ? `; the first ${MATCHES} are shown` : ''}.]`
        : `[No line of its ${count(starts.length, 'part')} contains it.]`,
      ...matches,
    ]
    return { text: asData(lines), details: { name: nameOf(kept.title) } }
  },
})

/** A line as a match shows it: whole when short, else the stretch around the match, marked where cut. */
function around(line: string, at: number, length: number): string {
  if (line.length <= LINE_CHARS) return line
  const start = Math.max(0, Math.min(at - Math.floor((LINE_CHARS - length) / 2), line.length - LINE_CHARS))
  const end = start + LINE_CHARS
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`
}
