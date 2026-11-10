// Which approvals --allow may give: only for tool calls that stay inside the pages this tool created.
import { toUuid } from '../../extension/src/notion/hosts'

/** A record and where it sits, as far as walking up from a page needs. */
export interface Place {
  table: string
  id: string
}

/** The parent of a record, or undefined if it can't be read. */
export type ParentOf = (place: Place) => Promise<Place | undefined>

const ID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi

/** The Notion ids a tool call names anywhere in its text: in URLs, dashed, or plain. */
export function mentionedIds(text: string): string[] {
  return [...new Set((text.match(ID) ?? []).map((m) => toUuid(m)).filter((id): id is string => !!id))]
}

/** Whether block `id` is one of `created`, or inside one (page, child page, database, row). */
export async function insideOwn(id: string, created: string[], parentOf: ParentOf, maxDepth = 50): Promise<boolean> {
  let place: Place | undefined = { table: 'block', id }
  for (let depth = 0; place && depth < maxDepth; depth++) {
    if (place.table === 'block' && created.includes(place.id)) return true
    // The top of the workspace or a teamspace: no throwaway page above this one.
    if (place.table !== 'block' && place.table !== 'collection') return false
    place = await parentOf(place)
  }
  return false
}

/**
 * Whether a tool call waiting for approval stays inside the pages this tool created: it names at
 * least one page, and every one it names is one of them or inside one.
 */
export async function withinOwnPages(callText: string, created: string[], parentOf: ParentOf): Promise<boolean> {
  const ids = mentionedIds(callText)
  if (!ids.length) return false
  for (const id of ids) if (!(await insideOwn(id, created, parentOf))) return false
  return true
}
