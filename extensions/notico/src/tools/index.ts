// Tools the agent can run in the extension, one module per area: reading pages (read.ts), finding
// them (find.ts), writing them (write.ts), databases (database.ts), organizing pages (organize.ts),
// comments (comments.ts), undoing a question's changes (undo.ts), the current tab, on Notion or another site, and the tabs the user added
// (current.ts), and @cofun/tools's web pages by their address, web searches, and the long results
// those keep on the device. This module lists them, and says for the side panel what a call did.
import type { HistoryMessage, ToolDetails } from '@cofun/agent'
import { pageLink } from '../notion/hosts'
import type { Action, Tool } from '../tool'
import { addComment, readComments } from './comments'
import { readResult, searchResult, webTools } from '@cofun/tools'
import { getCurrentTab, notionSite, readCurrentTab, readTab } from './current'
import { createDatabase, queryDatabase, updateDatabaseSchema } from './database'
import { listPages, searchPages } from './find'
import { duplicatePage, movePage, trashPage } from './organize'
import { getSelection, readPage } from './read'
import type { OpenPage } from './current'
import { verb } from './shared'
import { undoChangesTool } from './undo'
import { createPage, editPage, updatePages } from './write'

export {
  carryPages,
  currentNotionPage,
  currentTabReadable,
  openNotionPages,
  openWebTabs,
  isDatabase,
  type OpenPage,
} from './current'
export { findPages, type FoundPage } from './find'
export type { ToolMemory } from './memory'
export { forgetUndone, undoQuestion } from './undo'
export { OPEN_A_PAGE, chatTitle, replyTitle, savePage, type SavedTurn } from './save'

const { readWebPage, renderWebPage, searchWeb } = webTools({ product: 'Notico', ownSite: notionSite })

export const TOOLS: Tool[] = [
  readPage,
  editPage,
  createPage,
  searchPages,
  getSelection,
  queryDatabase,
  updatePages,
  createDatabase,
  updateDatabaseSchema,
  listPages,
  movePage,
  duplicatePage,
  trashPage,
  undoChangesTool,
  readComments,
  addComment,
  getCurrentTab,
  readCurrentTab,
  readTab,
  readWebPage,
  renderWebPage,
  searchWeb,
  readResult,
  searchResult,
]

/** A call in the user's words, also one from a saved session whose tool is gone. */
export function describeCall(name: string, args: unknown, details?: ToolDetails): Action {
  return (
    TOOLS.find((t) => t.name === name)?.describe(args, details) ?? {
      verb: verb('use', 'using', 'used'),
      what: 'a tool',
    }
  )
}

/** What a question's calls that worked read and changed: the distinct pages and databases of each. */
export function touchedBy(calls: { details?: ToolDetails }[]): {
  read: number
  /** The ids of the pages and databases changed, each once. */
  changed: string[]
} {
  const read = new Set(calls.flatMap((call) => call.details?.read ?? []))
  const changed = new Set(calls.flatMap((call) => call.details?.changed ?? []))
  return { read: read.size, changed: [...changed] }
}

/** The tools that read a web page, from a tab or by its address; the one that renders it; and the web search. */
const WEB_READS = new Set([readWebPage, renderWebPage, readCurrentTab, readTab].map((tool) => tool.name))
const RENDER = renderWebPage.name
const SEARCH = searchWeb.name

/** What a question's calls that worked did on the web: the pages read (each read counts), how many were rendered, and the searches. */
export function webTouchedBy(calls: { name: string }[]): { read: number; rendered: number; searches: number } {
  const count = (test: (name: string) => boolean) => calls.filter((call) => test(call.name)).length
  return {
    read: count((name) => WEB_READS.has(name)),
    rendered: count((name) => name === RENDER),
    searches: count((name) => name === SEARCH),
  }
}

/**
 * The tools whose card names the very page the call read or changed. Others may name another page
 * than the one they touched (duplicate_page names the original, and touches the copy), so their
 * calls give no recent page.
 */
const NAMES_TOUCHED_PAGE = new Set(['read_page', 'query_database', 'edit_page', 'read_comments', 'add_comment'])

/**
 * The pages a saved conversation went with, newest first: the pages its questions carried, and the
 * one page each call that worked read or changed, when its card names that page (see
 * NAMES_TOUCHED_PAGE). Read from the conversation alone: no Notion request. `origin` is the Notion
 * host links are made on.
 */
export function pagesIn(messages: HistoryMessage[], origin: string): OpenPage[] {
  const pages: OpenPage[] = []
  for (const m of messages) {
    // A tab on another site is not a Notion page: it may be gone, and is added again from the tabs open.
    if (m.role === 'user') pages.push(...(m.pages ?? []).filter((p) => !p.web))
    else if (m.role === 'tool' && m.status === 'done' && NAMES_TOUCHED_PAGE.has(m.name)) {
      const ids = [...new Set([...(m.details?.read ?? []), ...(m.details?.changed ?? [])])]
      const title = ids.length === 1 ? m.details?.name : undefined
      if (title) pages.push({ title, url: pageLink(origin, ids[0]) })
    }
  }
  return pages.reverse()
}
