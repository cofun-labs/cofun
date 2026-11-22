// The pages a Confluence tool may name: one a Confluence tool returned in this question, or a link to
// a page on the captured site. Reads and writes take a page the same way.
import { linkedPage, pageReference, type PageReference } from '../confluence/references'
import type { ConfluenceTab } from '../confluence/tab'
import { z } from '../zod'
import type { ToolMemory } from './memory'

export function remember(memory: ToolMemory, pages: readonly { ref: PageReference }[]) {
  for (const { ref } of pages) memory.confluenceResources.add(JSON.stringify([ref.instance, ref.id]))
}

export const folderKey = (ref: PageReference) => JSON.stringify([ref.instance, ref.id, 'folder'])

/** A page reference the model passes must be one a Confluence tool returned in this question. */
function requirePage(memory: ToolMemory, page?: PageReference) {
  if (!page || memory.confluenceResources.has(JSON.stringify([page.instance, page.id]))) return
  if (memory.confluenceResources.has(folderKey(page)))
    throw new Error('This reference is a folder. Pass it to browse_page_tree as folder.')
  throw new Error(
    'Use a page reference returned by a Confluence tool during this question, a link to a page on this Confluence site, or omit page.',
  )
}

/** A page a call names: a reference from a Confluence tool, or a link to a page on this site. */
export const pageTarget = z.union([
  pageReference,
  z.string().min(1).max(2048).describe('A link to a published page on the Confluence site in the current tab.'),
])
type PageTarget = z.output<typeof pageTarget>

export const page = pageTarget
  .optional()
  .describe(
    'The page: a page reference returned by a Confluence tool in this question, or a link to a page on this Confluence site. Omit for the page open in the current tab.',
  )

/** Refuse a reference no Confluence tool returned, before the call reads anything. */
export function requireTarget(memory: ToolMemory, at: PageTarget | undefined) {
  if (typeof at === 'object') requirePage(memory, at)
}

/** The page a call names, on the captured site. */
export function pageAt(memory: ToolMemory, tab: ConfluenceTab, at: PageTarget): PageReference {
  if (typeof at !== 'string') {
    requirePage(memory, at)
    return at
  }
  const linked = linkedPage(tab, at)
  if (!linked)
    throw new Error(
      'Confluco reads a page link only as …/pages/viewpage.action?pageId=<id> or …/spaces/<key>/pages/<id> on the ' +
        'Confluence site in the current tab. For another form, find the page with search_pages and pass its reference.',
    )
  return linked
}

/** The page a call names, or `undefined` for the page open in the tab. */
export function resolvePage(
  memory: ToolMemory,
  tab: ConfluenceTab,
  at: PageTarget | undefined,
): PageReference | undefined {
  return at === undefined ? undefined : pageAt(memory, tab, at)
}
