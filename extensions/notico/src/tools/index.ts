// Tools the agent can run in the extension, one module per area: reading pages (read.ts), finding
// them (find.ts), writing them (write.ts), databases (database.ts), organizing pages (organize.ts),
// comments (comments.ts), the current tab, on Notion or another site, and the tabs the user added
// (current.ts), web pages by their address and web searches (web.ts), and the long results those
// keep on the device (results.ts). This module lists them, and says for the side panel what a call did.
import type { HistoryMessage } from '@cofun/app/agent'
import { pageLink } from '../notion/hosts'
import type { Tool } from '@cofun/app/tool'
import { addComment, readComments } from './comments'
import { tabTools } from '@cofun/app/tools/current'
import { notionPages } from './current'
import { createDatabase, queryDatabase, updateDatabaseSchema } from './database'
import { listPages, searchPages } from './find'
import { duplicatePage, movePage, trashPage } from './organize'
import { getSelection, readPage } from './read'
import type { OpenPage } from './current'
import { readResult, searchResult } from '@cofun/app/tools/results'
import { webTools } from '@cofun/app/tools/web'
import { createPage, editPage, updatePages } from './write'

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
  ...tabTools('Notico', notionPages),
  ...webTools(notionPages),
  readResult,
  searchResult,
]

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
