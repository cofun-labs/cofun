// Writing a clip (src/clip.ts) to the Notion page the user chose: a page becomes a new page at its
// end, a selection a quote there. The user starts it from the context menu; it is not a tool the
// agent is offered, so Read only (which limits what the agent may change) doesn't apply to it, and
// nothing of it goes to the model or the worker.
import { readPage } from '@cofun/tools/tab'
import { saveClipTarget, type ClipRequest, type ClipTarget } from '../clip'
import { blockOps, fieldsOf, NotionError, waitText } from '../notion/api'
import type { NewBlock, RichText } from '../notion/blocks'
import { planAppend, planNewPage } from '../notion/edit'
import { pageIdFromUrl, pageLink, showsDatabase } from '../notion/hosts'
import { hexId } from '../notion/markdown'
import { activeNotionTab, notionCooldown, showNotionPage, type NotionTab } from '../notion/tab'
import { runsText } from '../notion/tree'
import { chatTitle, replyBlocks } from './save'

/** How much of a page's Markdown a clip keeps: one transaction holds it all. */
const CLIP_CHARS = 50_000

/** For the user: the picker searches the workspace of the Notion page in the current tab. */
const OPEN_NOTION = 'Open a Notion page in the current tab to search its workspace.'

/** The title of the private page clips go to unless the user picks another. */
export const DEFAULT_TARGET = 'Notico Clips'

/** A page the Settings picker offers: its id and title. */
export interface PageChoice {
  id: string
  title: string
}

/**
 * Where the Settings picker finds pages: the Notion tab in front, its workspace (by the page it
 * shows), and that page, when it is one clips can go to.
 */
export interface ClipPlace {
  tab: NotionTab
  spaceId: string
  current?: PageChoice
}

/** The Notion page in the current tab and its workspace, or why there is none, for the user. */
export async function clipPlace(): Promise<ClipPlace | string> {
  try {
    const tab = await activeNotionTab({ counted: false })
    const id = tab.pageId
    if (!id) return OPEN_NOTION
    // findRecords, not getRecords: a page in the trash is left out, and its workspace can't be told then.
    const page = (await tab.client.findRecords([{ table: 'block', id }])).block?.[id]
    const spaceId = page?.space_id
    if (typeof spaceId !== 'string' || !spaceId) return OPEN_NOTION
    return {
      tab,
      spaceId,
      ...(page?.type === 'page' && !showsDatabase(tab.url) ? { current: { id, title: titleOf(page) } } : {}),
    }
  } catch (err) {
    return problem(err, OPEN_NOTION)
  }
}

/** The pages of the place's workspace whose title or content holds `query`, as Notion's quick find has them. */
export async function findTargets(place: ClipPlace, query: string): Promise<PageChoice[] | string> {
  try {
    const found = await place.tab.client.search(place.spaceId, query, 8)
    return found.results.flatMap((r) => {
      const block = found.recordMap.block?.[r.id]
      // Only pages: clips can't go into a database.
      return block?.type === 'page' && block.alive !== false ? [{ id: r.id, title: titleOf(block) }] : []
    })
  } catch (err) {
    return problem(err, OPEN_NOTION)
  }
}

/** Makes `page`, in the place's workspace, the one clips go to. */
export async function chooseTarget(place: ClipPlace, page: PageChoice): Promise<void> {
  await saveClipTarget({ url: pageLink(place.tab.url, hexId(page.id)), title: page.title })
}

/**
 * Makes the private page "Notico Clips" of the place's workspace the one clips go to: the one the
 * user's Private section already has, else a new one, put there. Returns it, with whether it was
 * made, or why it couldn't be, for the user. Sent once: a failed write is not retried.
 */
export function defaultTarget(place: ClipPlace): Promise<(PageChoice & { made: boolean }) | string> {
  // One at a time, whoever asks (the switch, or the picker's option): two at once would each find no
  // page in Private, and each make one.
  making ??= makeDefault(place).finally(() => (making = undefined))
  return making
}

/** The default page being found or made, while it is. */
let making: Promise<(PageChoice & { made: boolean }) | string> | undefined

/** Whether the default page is being found or made now. */
export const makingDefault = () => making !== undefined

async function makeDefault(place: ClipPlace): Promise<(PageChoice & { made: boolean }) | string> {
  try {
    const { client } = place.tab
    const section = await client.privateSection(place.spaceId)
    // The first hundred are enough to find it: a new private page goes at the top.
    const pages = section.pages.slice(0, 100)
    const listed = pages.length
      ? (await client.findRecords(pages.map((id) => ({ table: 'block' as const, id })))).block
      : undefined
    const kept = pages.find(
      (id) => listed?.[id]?.type === 'page' && listed[id].alive !== false && titleOf(listed[id]) === DEFAULT_TARGET,
    )
    if (kept) {
      const page = { id: kept, title: DEFAULT_TARGET }
      await chooseTarget(place, page)
      return { ...page, made: false }
    }
    if (!section.view) return `Couldn't find your Private section in ${section.name}. Search for a page instead.`
    const made = planNewPage(undefined, place.spaceId, [[DEFAULT_TARGET]], [], section.view.userId)
    const operations = [
      ...made.operations,
      blockOps(place.spaceId, Date.now(), section.view.userId).moveToPrivate(made.pageId, section.view),
    ]
    await client.submitTransaction(place.spaceId, operations, 'Notico: clip page')
    const page = { id: made.pageId, title: DEFAULT_TARGET }
    await chooseTarget(place, page)
    return { ...page, made: true }
  } catch (err) {
    if (err instanceof NotionError && err.code === 'outcome_unknown')
      return `Notion didn't say whether “${DEFAULT_TARGET}” was created. Look in your Private section before trying again.`
    return problem(err, OPEN_NOTION)
  }
}

/** A page record's title as text (AGENTS.md: "Untrusted values": rich text is read by hand). */
function titleOf(page: { properties?: unknown }): string {
  return runsText(fieldsOf(page.properties)?.title).replace(/\s+/g, ' ').trim() || 'Untitled'
}

/** What a failed Notion read or write in Settings says to the user. */
function problem(err: unknown, offNotion: string): string {
  if (!(err instanceof NotionError)) throw err
  if (err.code === 'no_notion_tab') return offNotion
  if (err.code === 'no_access') return "The Notion account signed in can't see this page."
  if (err.code === 'rate_limited')
    return `Notion is turning requests away right now. Wait ${waitText(notionCooldown.left() || 60_000)}, then try again.`
  return `Couldn't reach Notion: ${err.message}`
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
