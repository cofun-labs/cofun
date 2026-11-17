// Published page reads and searches use the same REST and pagination rules as the other tools.
import { z } from '../zod'
import { readCloudPage, searchCloudPages } from './cloud'
import { collection } from './collection'
import { spaceKey } from './navigation'
import { readableText } from './readable-text'
import { fetchPublishedPage, pageLink, publishedPage } from './references'
import type { ConfluenceTab } from './tab'

const pageBody = publishedPage.extend({ body: z.object({ view: z.object({ value: z.string() }) }) })

export async function readPage(tab: ConfluenceTab, signal?: AbortSignal) {
  if (tab.instance.cloud) return readCloudPage(tab, signal)
  const page = await fetchPublishedPage(tab, undefined, pageBody, 'body.view', signal)
  return { ...pageLink(tab.instance, page), text: readableText(page.body.view.value) }
}

export const SearchArgs = z.strictObject({
  query: z.string().trim().min(1).max(200).describe('Text to find in published pages.'),
  field: z.enum(['text', 'title']).default('text').describe('Search the full page or only the title.'),
  spaceKey: spaceKey.optional().describe('Restrict the search to a space key.'),
  nextPage: z.uuid().optional().describe('Use the nextPage from the same search, or omit this for the first page.'),
})

const searchHit = z.object({ content: publishedPage, excerpt: z.string().max(16_000).optional() })

/** Compare what the user wrote with the same whitespace the CQL query will use. */
export const normalizeSearchText = (text: string) => text.trim().replace(/\s+/g, ' ')

const cqlString = (value: string) => JSON.stringify(value)

export type SearchContinuation = { offset: number } | { cursor: string }

export async function searchPages(
  tab: ConfluenceTab,
  input: z.output<typeof SearchArgs>,
  continuation?: SearchContinuation,
  signal?: AbortSignal,
) {
  const filter = input.spaceKey ? ' AND space = ' + cqlString(input.spaceKey) : ''
  const cql = 'type = page AND ' + input.field + ' ~ ' + cqlString(normalizeSearchText(input.query)) + filter
  if (tab.instance.cloud) {
    const { results, cursor, paginationNotice } = await searchCloudPages(
      tab,
      cql,
      continuation && 'cursor' in continuation ? continuation.cursor : undefined,
      signal,
    )
    return { results: excerpts(results), continuation: cursor === undefined ? undefined : { cursor }, paginationNotice }
  }
  const offset = continuation && 'offset' in continuation ? continuation.offset : 0
  const { items, nextStart, paginationNotice } = await collection(tab, 'search', { cql }, offset, searchHit, { signal })
  const results = items.map(({ content, excerpt }) => ({ ...pageLink(tab.instance, content), excerpt }))
  return {
    results: excerpts(results),
    continuation: nextStart === undefined ? undefined : { offset: nextStart },
    paginationNotice,
  }
}

function excerpts<T extends { excerpt?: string }>(results: T[]) {
  return results.map(({ excerpt, ...hit }) => ({
    ...hit,
    ...(excerpt && { excerpt: readableText(excerpt.replace(/@@@(?:end)?hl@@@/gi, '')).slice(0, 320) }),
  }))
}
