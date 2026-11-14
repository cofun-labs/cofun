// Tools the agent can run in the extension, one module per area: reading pages (read.ts), finding
// them (find.ts), writing them (write.ts), databases (database.ts), organizing pages (organize.ts),
// comments (comments.ts), and the current tab (current.ts). This module lists them, and says for
// the side panel what a call did.
import type { Action, Tool } from '../tool'
import { addComment, readComments } from './comments'
import { getCurrentTab } from './current'
import { createDatabase, queryDatabase, updateDatabaseSchema } from './database'
import { listPages, searchPages } from './find'
import { duplicatePage, movePage, trashPage } from './organize'
import { getSelection, readPage } from './read'
import { NONE, verb } from './shared'
import { createPage, editPage, updatePages } from './write'

export { carryOpenPage, currentNotionPage, type OpenPage } from './current'
export { forgetReads } from './memory'

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
export function touchedBy(calls: { name: string; args: unknown; result: string }[]): { read: number; changed: number } {
  const read = new Set<string>()
  const changed = new Set<string>()
  for (const call of calls) {
    const t = TOOLS.find((tool) => tool.name === call.name)?.touched(call.args, call.result) ?? NONE
    for (const id of t.read ?? []) read.add(id)
    for (const id of t.changed ?? []) changed.add(id)
  }
  return { read: read.size, changed: changed.size }
}
