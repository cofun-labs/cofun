// Tools the agent can run in the extension, one module per area: reading pages (read.ts), finding
// them (find.ts), writing them (write.ts), databases (database.ts), organizing pages (organize.ts),
// comments (comments.ts), and the current tab (current.ts). This module lists them, and says for
// the side panel what a call did.
import type { HistoryMessage } from '../agent'
import { pageLink } from '../notion/hosts'
import type { Action, Tool } from '../tool'
import { addComment, readComments } from './comments'
import { getCurrentTab } from './current'
import { createDatabase, queryDatabase, updateDatabaseSchema } from './database'
import { listPages, searchPages } from './find'
import { duplicatePage, movePage, trashPage } from './organize'
import { getSelection, readPage } from './read'
import type { OpenPage } from './current'
import { NONE, verb } from './shared'
import { createPage, editPage, updatePages } from './write'

export { carryPages, currentNotionPage, openNotionPages, type OpenPage } from './current'
export { findPages, type FoundPage } from './find'
export { forgetReads } from './memory'
export { OPEN_A_PAGE, chatTitle, replyTitle, savePage, type SavedTurn } from './save'

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
  readComments,
  addComment,
  getCurrentTab,
]

/** A call in the user's words, also one from a saved session whose tool is gone. */
export function describeCall(name: string, args: unknown, result?: string): Action {
  return (
    TOOLS.find((t) => t.name === name)?.describe(args, result) ?? { verb: verb('use', 'using', 'used'), what: 'a tool' }
  )
}

/** What a question's calls that worked read and changed: the distinct pages and databases of each. */
export function touchedBy(calls: { name: string; args: unknown; result: string }[]): {
  read: number
  /** The ids of the pages and databases changed, each once. */
  changed: string[]
} {
  const read = new Set<string>()
  const changed = new Set<string>()
  for (const call of calls) {
    const t = TOOLS.find((tool) => tool.name === call.name)?.touched(call.args, call.result) ?? NONE
    for (const id of t.read ?? []) read.add(id)
    for (const id of t.changed ?? []) changed.add(id)
  }
  return { read: read.size, changed: [...changed] }
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
  const calls = new Map<string, unknown>()
  const pages: OpenPage[] = []
  for (const m of messages) {
    if (m.role === 'user') pages.push(...(m.pages ?? []))
    else if (m.role === 'assistant') {
      for (const part of m.parts) if (part.type === 'tool_call') calls.set(part.id, part.args)
    } else if (m.status === 'done' && NAMES_TOUCHED_PAGE.has(m.name)) {
      const tool = TOOLS.find((t) => t.name === m.name)
      const args = calls.get(m.id)
      const touched = tool?.touched(args, m.result) ?? NONE
      const ids = [...new Set([...(touched.read ?? []), ...(touched.changed ?? [])])]
      const title = ids.length === 1 ? tool?.describe(args, m.result).name : undefined
      if (title) pages.push({ title, url: pageLink(origin, ids[0]) })
    }
  }
  return pages.reverse()
}
