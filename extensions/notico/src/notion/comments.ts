// Comments on a Notion page, as the model reads them. Comments are written by anyone who can open
// the page, so everything in them is quoted: a comment can't end its line, start another thread, or
// pass for the tool's own words.
import { mergeRecordMaps, type NotionClient, type LoadedPage, type NotionRecord, type Pointer } from './api'
import { LAYOUT_TYPES, PAGE_TYPES, hexId, richMarkdown, userName, type PageMarkdown } from './markdown'

export interface Thread {
  id: string
  /** The block it is on; the page's own id for a comment on the page. */
  blockId: string
  resolved: boolean
  /** The text in the block it is about, for a comment on part of a block's text. */
  context?: string
  comments: { author: string; time?: number; text: string }[]
}

/** How much of one comment is shown at most. */
export const COMMENT_CHARS = 2000
/** How much of the block a thread is on is shown, so the model can tell which block it is. */
const EXCERPT_CHARS = 80

/** The blocks threads can be on, in page order: the page, then the blocks it shows. */
function anchors(loaded: LoadedPage, md: PageMarkdown): string[] {
  const blocks = loaded.recordMap.block ?? {}
  // A child page's comments are that page's own, not a block's of this one; columns only lay out
  // their blocks, and Notion shows no comments on them.
  const shown = [...md.refs.keys()].filter((id) => {
    const type = String(blocks[id]?.type)
    return !PAGE_TYPES.has(type) && !LAYOUT_TYPES.has(type)
  })
  return [loaded.page.id, ...shown]
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** The discussions on the page and its blocks, by the block they are on, in page order. */
function discussionsOf(loaded: LoadedPage, md: PageMarkdown): { blockId: string; id: string }[] {
  const blocks = loaded.recordMap.block ?? {}
  return anchors(loaded, md).flatMap((blockId) => ids(blocks[blockId]?.discussions).map((id) => ({ blockId, id })))
}

/**
 * How many comment threads the page and its blocks have, counted as loadThreads shows them: those
 * with a comment left. Only what the page load brought counts (Notion's load brings them all).
 */
export function threadCount(loaded: LoadedPage, md: PageMarkdown): number {
  const { discussion = {}, comment = {} } = loaded.recordMap
  const live = (r: NotionRecord | undefined) => !!r && r.alive !== false
  return discussionsOf(loaded, md).filter(
    ({ id }) => live(discussion[id]) && ids(discussion[id].comments).some((c) => live(comment[c])),
  ).length
}

/**
 * The page's threads in page order, with their comments in order. Discussions, comments, and
 * authors the page load didn't bring are looked up; deleted ones are left out.
 */
export async function loadThreads(client: NotionClient, loaded: LoadedPage, md: PageMarkdown): Promise<Thread[]> {
  const map = loaded.recordMap
  const spaceId = loaded.spaceId
  const lookUp = async (table: Pointer['table'], wanted: string[]) => {
    const missing = [...new Set(wanted)].filter((id) => !map[table]?.[id])
    if (missing.length) mergeRecordMaps(map, await client.findRecords(missing.map((id) => ({ table, id, spaceId }))))
  }
  const on = discussionsOf(loaded, md)
  await lookUp(
    'discussion',
    on.map((d) => d.id),
  )
  const live = (r: NotionRecord | undefined): r is NotionRecord => !!r && r.alive !== false
  const discussions = on.flatMap(({ blockId, id }) => {
    const d = map.discussion?.[id]
    return live(d) ? [{ blockId, record: d }] : []
  })
  await lookUp(
    'comment',
    discussions.flatMap((d) => ids(d.record.comments)),
  )
  const comments = (d: NotionRecord) =>
    ids(d.comments).flatMap((c) => (live(map.comment?.[c]) ? [map.comment![c]] : []))
  await lookUp(
    'notion_user',
    discussions.flatMap((d) => [
      ...mentionedUsers(d.record.context),
      ...comments(d.record).flatMap((c) => [
        ...(c.created_by_table === 'notion_user' && typeof c.created_by_id === 'string' ? [c.created_by_id] : []),
        ...mentionedUsers(c.text),
      ]),
    ]),
  )
  return discussions
    .map(({ blockId, record }) => ({
      id: record.id,
      blockId,
      resolved: record.resolved === true,
      context: Array.isArray(record.context) ? richMarkdown(map, record.context) : undefined,
      comments: comments(record).map((c) => ({
        author:
          c.created_by_table === 'notion_user' && typeof c.created_by_id === 'string'
            ? userName(map, c.created_by_id)
            : 'an integration',
        time: typeof c.created_time === 'number' ? c.created_time : undefined,
        text: richMarkdown(map, c.text),
      })),
    }))
    .filter((t) => t.comments.length > 0)
}

/** The users rich text mentions (`@Name`), so their names can be looked up. */
function mentionedUsers(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((run) =>
    Array.isArray(run) && Array.isArray(run[1])
      ? (run[1] as unknown[]).flatMap((mark) =>
          Array.isArray(mark) && mark[0] === 'u' && typeof mark[1] === 'string' ? [mark[1]] : [],
        )
      : [],
  )
}

/**
 * One thread as the model reads it, as its heading and one line per comment, so a long thread can
 * be split between comments. Everything from the page or its people is quoted.
 */
export function threadLines(
  thread: Thread,
  n: number,
  md: PageMarkdown,
  pageId: string,
): { head: (continued: boolean) => string[]; comments: string[] } {
  const where =
    thread.blockId === pageId
      ? 'On the page'
      : `On the block ^${md.refs.get(thread.blockId) ?? hexId(thread.blockId)} ${quote(clip(md.lines.get(thread.blockId) ?? '', EXCERPT_CHARS))}`
  return {
    head: (continued) => [
      `${n}. ${where}, ${thread.resolved ? 'resolved' : 'open'}${continued ? ', continued' : ''}:`,
      ...(thread.context ? [`   About the text: ${quote(clip(thread.context, EXCERPT_CHARS))}`] : []),
    ],
    comments: thread.comments.map(
      (c) =>
        `   - ${quote(c.author)}${c.time === undefined ? '' : `, ${when(c.time)}`}: ${quote(clip(c.text, COMMENT_CHARS))}` +
        (c.text.length > COMMENT_CHARS ? ` (cut off at ${COMMENT_CHARS} characters)` : ''),
    ),
  }
}

/**
 * Text as a JSON string: quotes, backslashes, and line breaks escaped, so it stays on its line and
 * inside its quotes. JSON leaves Unicode's own line separators as they are; those are escaped too.
 */
export function quote(text: string): string {
  return JSON.stringify(text).replace(
    /[\u0085\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

function when(time: number): string {
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** Text cut to `max` characters, ending with … when cut. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
