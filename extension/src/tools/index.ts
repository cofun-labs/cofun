// Tools the agent can run in the extension, one module per area: reading pages (read.ts), finding
// them (find.ts), writing them (write.ts), databases (database.ts), organizing pages (organize.ts),
// comments (comments.ts), the current tab, on Notion or another site, and the tabs the user added
// (current.ts), web pages by their address and web searches (web.ts), and the long results those
// keep on the device (results.ts); what a question carries is in carry.ts. This module says for the
// side panel what a call did; the product lists the tools its agent is offered (products/notico/product.ts).
import type { HistoryMessage, ToolDetails } from '../agent'
import type { HomeSite } from '../product'
import type { Action, Tool } from '../tool'
import type { OpenPage } from './carry'
import { verb } from './shared'

export {
  carryPages,
  openWebTabs,
  addedTabNow,
  SELECTION_END,
  selectionsCarried,
  titleOf,
  type FoundPage,
  type OpenPage,
  type WebTab,
} from './carry'
export type { ToolMemory } from './memory'
export { DATA_LINE } from './shared'

/** A call in the user's words, by the tool of `tools` it names; also one from a saved session whose tool is gone. */
export function describeCall(tools: Tool[], name: string, args: unknown, details?: ToolDetails): Action {
  return (
    tools.find((t) => t.name === name)?.describe(args, details) ?? {
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

/**
 * The pages a saved conversation went with, newest first: the pages its questions carried, and,
 * for a product with a site, the one page each call that worked read or changed, when its card
 * names that page (see the site's `namesTouchedPage`). Read from the conversation alone: no request
 * to the site. `origin` is the site's host links are made on.
 */
export function pagesIn(
  site: Pick<HomeSite, 'namesTouchedPage' | 'pageLink'> | undefined,
  messages: HistoryMessage[],
  origin: string | undefined,
): OpenPage[] {
  const pages: OpenPage[] = []
  for (const m of messages) {
    // A tab on another site is not the site's page: it may be gone, and is added again from the tabs open.
    if (m.role === 'user') pages.push(...(m.pages ?? []).filter((p) => !p.web))
    else if (site && origin && m.role === 'tool' && m.status === 'done' && site.namesTouchedPage.has(m.name)) {
      const ids = [...new Set([...(m.details?.read ?? []), ...(m.details?.changed ?? [])])]
      const title = ids.length === 1 ? m.details?.name : undefined
      if (title) pages.push({ title, url: site.pageLink(origin, ids[0]) })
    }
  }
  return pages.reverse()
}
