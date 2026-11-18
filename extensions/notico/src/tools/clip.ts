// Writing a clip (src/clip.ts) to the Notion page the user chose: a page becomes a new page at its
// end, a selection a quote there. The user starts it from the context menu; it is not a tool the
// agent is offered, so Read only (which limits what the agent may change) doesn't apply to it, and
// nothing of it goes to the model or the worker.
import { readPage } from '@cofun/tools/tab'
import { saveClipTarget, type ClipRequest, type ClipTarget } from '../clip'
import { fieldsOf, NotionError, waitText } from '../notion/api'
import type { NewBlock, RichText } from '../notion/blocks'
import { planAppend, planNewPage } from '../notion/edit'
import { pageIdFromUrl, pageLink, showsDatabase } from '../notion/hosts'
import { hexId } from '../notion/markdown'
import { activeNotionTab, notionCooldown, showNotionPage } from '../notion/tab'
import { chatTitle, replyBlocks } from './save'

/** How much of a page's Markdown a clip keeps: one transaction holds it all. */
const CLIP_CHARS = 50_000

/** For the user: why the current tab's page can't be chosen as the one clips go to. */
const OPEN_A_TARGET = 'Open the Notion page to clip into in the current tab, then choose it here.'
const NOT_A_PAGE = "Clips can't go into a database. Open a page, then choose it here."

/**
 * Makes the Notion page open in the current tab the one clips go to, once it has read it there, as
 * this Notion account sees it: its title, for Settings to show, and that it is a page. Returns why
 * it can't be, for the user, if it can't.
 */
export async function chooseTarget(): Promise<string | undefined> {
  try {
    const tab = await activeNotionTab({ counted: false })
    const id = tab.pageId
    if (!id) return OPEN_A_TARGET
    if (showsDatabase(tab.url)) return NOT_A_PAGE
    const page = (await tab.client.getRecords([{ table: 'block', id }])).block![id]
    if (page.type !== 'page') return page.type === 'collection_view_page' ? NOT_A_PAGE : OPEN_A_TARGET
    // A title's runs, read by hand (AGENTS.md: "Untrusted values"): only their text is kept.
    const runs = fieldsOf(page.properties)?.title
    const title = (Array.isArray(runs) ? runs : [])
      .map((run: unknown) => (Array.isArray(run) && typeof run[0] === 'string' ? run[0] : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    await saveClipTarget({ url: pageLink(tab.url, hexId(id)), title: title || 'Untitled' })
    return undefined
  } catch (err) {
    if (!(err instanceof NotionError)) throw err
    if (err.code === 'no_notion_tab') return OPEN_A_TARGET
    if (err.code === 'no_access')
      return "The Notion account signed in can't see this page. Switch to a Notion account that can, then choose it again."
    if (err.code === 'in_trash') return 'This page is in the trash. Restore it, or open another page.'
    return `Couldn't read the page in Notion: ${err.message}`
  }
}

/** For the user: no page is chosen to clip to. */
export const CHOOSE_A_TARGET = 'Choose the Notion page to clip to in Settings first.'

/**
 * Writes the clip to the end of `target`, shown in a tab of window `windowId`, and returns a link to
 * what it made. Sent once: a failure is never retried, since the clip may have been written. What
 * it throws says, for the user, what went wrong.
 */
export async function writeClip(windowId: number, target: ClipTarget, clip: ClipRequest): Promise<{ url: string }> {
  try {
    return await write(windowId, target, clip)
  } catch (err) {
    if (!(err instanceof NotionError)) throw err
    const name = `“${target.title}”`
    if (err.code === 'no_access')
      throw new Error(
        `The Notion account signed in can't see ${name}, the page clips go to. Switch to a Notion account that can, or choose another page in Settings.`,
        { cause: err },
      )
    if (err.code === 'in_trash')
      throw new Error(
        `${name}, the page clips go to, is in the trash. Restore it, or choose another page in Settings.`,
        {
          cause: err,
        },
      )
    // Nothing more is sent until the wait Notion asked for is over (NotionCooldown).
    if (err.code === 'rate_limited')
      throw new Error(
        'Notion is turning requests away right now (too many requests, or too busy), so nothing was clipped. ' +
          `Wait ${waitText(notionCooldown.left() || 60_000)}, then try again.`,
        { cause: err },
      )
    if (err.code === 'outcome_unknown')
      throw new Error(
        `Notion didn't say whether the clip was written. Look at the end of ${name} before clipping again.`,
        {
          cause: err,
        },
      )
    throw new Error(`Couldn't clip to Notion: ${err.message}`, { cause: err })
  }
}

async function write(windowId: number, target: ClipTarget, clip: ClipRequest): Promise<{ url: string }> {
  // Read before the target's tab is shown: the click lets the extension read the page only until it goes elsewhere.
  const content = clip.text === undefined ? await pageContent(clip) : undefined
  const targetId = pageIdFromUrl(target.url)
  if (!targetId) throw new Error(CHOOSE_A_TARGET)
  const tab = await showNotionPage(windowId, target.url)
  const page = (await tab.client.getRecords([{ table: 'block', id: targetId }])).block![targetId]
  if (page.type !== 'page') throw new Error(`“${target.title}” is no longer a page. Choose another page in Settings.`)
  const spaceId = page.space_id
  if (typeof spaceId !== 'string' || !spaceId)
    throw new NotionError('notion_error', 'Notion returned the page without its workspace.')
  if (clip.text !== undefined) {
    const blocks: NewBlock[] = [
      // As the page shows it: its words are not read as Markdown.
      { type: 'quote', title: [[clip.text.trim()]], children: [] },
      { type: 'text', title: source(clip), children: [] },
    ]
    await tab.client.submitTransaction(
      spaceId,
      planAppend(targetId, spaceId, blocks, tab.client.userId),
      'Notico: clip',
    )
    return { url: pageLink(tab.url, hexId(targetId)) }
  }
  const made = planNewPage(
    { id: targetId, table: 'block' },
    spaceId,
    [[chatTitle(clip.title || clip.url)]],
    [{ type: 'text', title: source(clip), children: [] }, ...content!],
    tab.client.userId,
  )
  await tab.client.submitTransaction(spaceId, made.operations, 'Notico: clip')
  return { url: pageLink(tab.url, hexId(made.pageId)) }
}

/** The page in the clip's tab as blocks, up to CLIP_CHARS of it, saying so when it was longer. */
async function pageContent(clip: ClipRequest): Promise<NewBlock[]> {
  const read = await readPage(clip.tabId, new URL(clip.url).origin, CLIP_CHARS, 'Notico', 'the tab')
  if ('reason' in read) throw new Error(`Nothing was clipped. ${read.reason}`)
  const cut = read.longer || read.chars > read.text.length
  return [...replyBlocks(read.text), ...(cut ? [gray('The page was longer: only its start was clipped.')] : [])]
}

/**
 * A gray line naming the clip's page, "From <title>", which links it when it is on the web: a local
 * file's address would show a path on the user's computer to whoever reads the Notion page.
 */
function source(clip: ClipRequest): RichText {
  const marks: [string, unknown?][] = [['h', 'gray']]
  const web = /^https?:\/\//i.test(clip.url)
  return [
    ['From ', marks],
    [clip.title.trim() || (web ? clip.url : 'a local file'), web ? [...marks, ['a', clip.url]] : marks],
  ]
}

function gray(text: string): NewBlock {
  return { type: 'text', title: [[text, [['h', 'gray']]]], children: [] }
}
