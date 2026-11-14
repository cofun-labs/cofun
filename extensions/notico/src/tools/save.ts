// Saving a reply, or a whole chat, as a new Notion page at the end of the page open in the current
// tab. The user starts it from the side panel; it is not a tool the agent is offered, so Read only
// (which limits what the agent may change) doesn't apply to it.
import { NotionError, waitText } from '../notion/api'
import { MarkdownError, blocksWithNames, parseMarkdown, type NewBlock, type RichText } from '../notion/blocks'
import { planNewPage } from '../notion/edit'
import { pageLink, toUuid } from '../notion/hosts'
import { hexId } from '../notion/markdown'
import { activeNotionTab, notionCooldown } from '../notion/tab'

/** One question and its reply, as the page holds them. */
export interface SavedTurn {
  question: string
  /** What the reply wrote, as the model's Markdown, without the tools it ran in between. */
  markdown: string
  /** How many pages the reply's tools read, and the ids of those they changed. */
  read: number
  changed: string[]
}

/** For the user: the current tab is not a Notion page, or shows none (say, Notion's home). */
export const OPEN_A_PAGE = 'Open a Notion page to save under it.'
/** For the user: the open page is a database, which a save can't go into. */
const NOT_A_DATABASE = "Saving into a database isn't supported. Open a page to save under it."

/** How much of a question a reply's title keeps, and how long a title may be in all. */
const QUESTION_CHARS = 80
const TITLE_CHARS = 150

/**
 * The title of a page holding one reply: the chat's title, then the question it answers, each cut
 * to fit. A chat still titled with this very question gets it once.
 */
export function replyTitle(chat: string, question: string): string {
  const one = (text: string) => text.replace(/\s+/g, ' ').trim()
  const asked = cut(one(question), QUESTION_CHARS)
  const title = one(chat)
  if (!title || title === one(question) || title === asked) return asked || 'Untitled'
  return asked ? `${cut(title, TITLE_CHARS - asked.length - 3)} — ${asked}` : cut(title, TITLE_CHARS)
}

/** `text` in at most `max` characters, counted as people see them: an emoji is never cut in two. */
function cut(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : text
}

/**
 * Creates a page titled `title` holding `turns` at the end of the page open in the current tab, and
 * returns its link. Sent once: a failure is never retried, since the page may have been made. What
 * it throws says, for the user, what went wrong.
 */
export async function savePage(title: string, turns: SavedTurn[]): Promise<{ url: string }> {
  try {
    return await createSaved(title, turns)
  } catch (err) {
    if (!(err instanceof NotionError)) throw err
    if (err.code === 'no_notion_tab') throw new Error(OPEN_A_PAGE, { cause: err })
    // Nothing more is sent until the wait Notion asked for is over (NotionCooldown).
    if (err.code === 'rate_limited')
      throw new Error(
        'Notion is turning requests away right now (too many requests, or too busy), so nothing was saved. ' +
          `Wait ${waitText(notionCooldown.left() || 60_000)}, then try again.`,
        { cause: err },
      )
    if (err.code === 'outcome_unknown')
      throw new Error(
        "Notion didn't say whether the page was created. Look at the end of the open page in Notion before saving again.",
        { cause: err },
      )
    throw new Error(`Couldn't save to Notion: ${err.message}`, { cause: err })
  }
}

async function createSaved(title: string, turns: SavedTurn[]): Promise<{ url: string }> {
  // Outside any question: its requests count toward none.
  const tab = await activeNotionTab({ counted: false })
  const parentId = tab.pageId
  if (!parentId) throw new Error(OPEN_A_PAGE)
  const blocks = pageBlocks(turns)
  const parent = (await tab.client.getRecords([{ table: 'block', id: parentId }])).block![parentId]
  if (parent.type === 'collection_view_page' || parent.type === 'collection_view') throw new Error(NOT_A_DATABASE)
  if (parent.type !== 'page') throw new Error(OPEN_A_PAGE)
  const spaceId = parent.space_id
  if (typeof spaceId !== 'string' || !spaceId)
    throw new NotionError('notion_error', 'Notion returned the page without its workspace.')
  const page = planNewPage({ id: parentId, table: 'block' }, spaceId, [[title]], blocks, tab.client.userId)
  await tab.client.submitTransaction(spaceId, page.operations, 'Notico: save to Notion')
  return { url: pageLink(tab.url, hexId(page.pageId)) }
}

/** The page's blocks: each question as a quote, then its reply, and a divider between turns. */
function pageBlocks(turns: SavedTurn[]): NewBlock[] {
  return turns.flatMap((turn, i) => [
    ...(i ? [{ type: 'divider', title: [], children: [] }] : []),
    // As the user typed it: their words are not read as Markdown.
    { type: 'quote', title: [[turn.question.trim()]], children: [] } satisfies NewBlock,
    ...replyBlocks(turn.markdown),
    ...summary(turn),
  ])
}

/**
 * A reply's Markdown as blocks, the same way the agent's own writes parse it, with no person
 * mentioned. A reply that doesn't parse (a color Notion lacks, say) is kept as plain paragraphs.
 */
function replyBlocks(markdown: string): NewBlock[] {
  if (!markdown.trim()) return []
  try {
    // A code block's caption can't be written yet; the code itself is kept.
    const uncaptioned = (blocks: NewBlock[]): NewBlock[] =>
      blocks.map((b) => ({ ...b, caption: undefined, children: uncaptioned(b.children) }))
    return blocksWithNames(uncaptioned(parseMarkdown(markdown)))
  } catch (err) {
    if (!(err instanceof MarkdownError)) throw err
    return markdown
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((p) => ({ type: 'text', title: [[p.trim()]], children: [] }))
  }
}

/** One gray line of what a reply read and changed, linking the pages it changed; none when it touched nothing. */
function summary({ read, changed }: SavedTurn): NewBlock[] {
  const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
  const ids = changed.flatMap((id) => toUuid(id) ?? [])
  const words = [read && `Read ${counted(read, 'page')}`, ids.length && `Changed ${counted(ids.length, 'page')}`]
  const text = words.filter(Boolean).join(' · ')
  if (!text) return []
  const gray: [string, unknown?][] = [['h', 'gray']]
  const title: RichText = [[ids.length ? `${text}: ` : text, gray]]
  ids.forEach((id, i) => {
    if (i) title.push([', ', gray])
    title.push(['‣', [...gray, ['p', id]]])
  })
  return [{ type: 'text', title, children: [] }]
}
