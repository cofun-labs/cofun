// Published page reads and searches use the same REST and pagination rules as the other tools.
import { z } from '../zod'
import { collection, collectionStart } from './collection'
import { spaceKey } from './navigation'
import { readableText } from './readable-text'
import { fetchPublishedPage, pageLink, publishedPage } from './references'
import type { ConfluenceTab } from './tab'

const pageBody = publishedPage.extend({ body: z.object({ view: z.object({ value: z.string() }) }) })

export async function readPage(tab: ConfluenceTab, signal?: AbortSignal) {
  const page = await fetchPublishedPage(tab, undefined, pageBody, 'body.view', signal)
  return { ...pageLink(tab.instance, page), text: readableText(page.body.view.value) }
}

export const SearchArgs = z.strictObject({
  query: z.string().trim().min(1).max(200).describe('Text to find in published pages.'),
  field: z.enum(['text', 'title']).default('text').describe('Search the full page or only the title.'),
  spaceKey: spaceKey.optional().describe('Restrict the search to a space key.'),
  start: collectionStart,
})

const searchHit = z.object({ content: publishedPage, excerpt: z.string().max(16_000).optional() })

/** Compare what the user wrote with the same whitespace the CQL query will use. */
export const normalizeSearchText = (text: string) => text.trim().replace(/\s+/g, ' ')

const cqlString = (value: string) => JSON.stringify(value)

export async function searchPages(tab: ConfluenceTab, input: z.output<typeof SearchArgs>, signal?: AbortSignal) {
  const filter = input.spaceKey ? ' AND space = ' + cqlString(input.spaceKey) : ''
  const cql = 'type = page AND ' + input.field + ' ~ ' + cqlString(normalizeSearchText(input.query)) + filter
  const { items, ...next } = await collection(tab, 'search', { cql }, input.start, searchHit, { signal })
  const results = items.map(({ content, excerpt }) => ({
    ...pageLink(tab.instance, content),
    ...(excerpt && { excerpt: readableText(excerpt.replace(/@@@(?:end)?hl@@@/gi, '')).slice(0, 320) }),
  }))
  return { results, ...next }
}
