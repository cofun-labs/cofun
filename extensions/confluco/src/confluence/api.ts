// The Data Center REST contract for the current published page and published-page search.
import { z } from '../zod'
import type { Instance } from './instance'
import { readableText } from './readable-text'
import { ConfluenceReadError, currentConfluenceTab, readInTab } from './tab'

const Page = z.object({
  id: z.string().regex(/^\d{1,20}$/),
  type: z.literal('page'),
  status: z.literal('current'),
  title: z.string().trim().min(1).max(1000),
})
const PageBody = Page.extend({ body: z.object({ view: z.object({ value: z.string() }) }) })
const pageLink = (instance: Instance, page: z.infer<typeof Page>) => ({
  title: page.title,
  url: `${instance.origin}${instance.path}/pages/viewpage.action?pageId=${page.id}`,
})

/** A page body is read as inert text and bounded before it is given to the tool. */
export async function readPage(instance: Instance | undefined, signal?: AbortSignal) {
  const tab = await currentConfluenceTab(instance)
  const response = await readInTab(
    tab,
    { kind: 'page', path: `${tab.instance.path}/rest/api/content/`, query: { expand: 'body.view' } },
    signal,
  )
  const page = PageBody.safeParse(response.data)
  if (!page.success || page.data.id !== response.pageId) {
    throw new ConfluenceReadError('Confluence did not return the expected published page.')
  }
  return { ...pageLink(tab.instance, page.data), text: readableText(page.data.body.view.value) }
}

const SEARCH_LIMIT = 10
const MAX_START = 990
const SpaceKey = z
  .string()
  .regex(/^(?:~[^\p{C}/\\%;?#]+|[a-zA-Z0-9][a-zA-Z0-9_-]*)$/u)
  .max(255)

export const SearchArgs = z.strictObject({
  query: z.string().trim().min(1).max(200).describe('Text to find in published pages.'),
  field: z.enum(['text', 'title']).default('text').describe('Search the full page or only the title.'),
  spaceKey: SpaceKey.optional().describe('Restrict the search to a space key.'),
  start: z.int().min(0).max(MAX_START).default(0).describe('Omit on the first call. Use the returned nextStart.'),
})

const SearchResponse = z.object({
  results: z.array(z.object({ content: Page, excerpt: z.string().max(16_000).optional() })).max(SEARCH_LIMIT),
  _links: z.object({ next: z.string().max(4096).optional() }).optional(),
})

/** Compare what the user wrote with the same whitespace the CQL query will use. */
export const normalizeSearchText = (text: string) => text.trim().replace(/\s+/g, ' ')

const cqlString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export async function searchPages(
  instance: Instance | undefined,
  input: z.output<typeof SearchArgs>,
  signal?: AbortSignal,
) {
  const tab = await currentConfluenceTab(instance)
  const path = `${tab.instance.path}/rest/api/search`
  const filter = input.spaceKey ? ` AND space = ${cqlString(input.spaceKey)}` : ''
  const cql = `type = page AND ${input.field} ~ ${cqlString(normalizeSearchText(input.query))}${filter}`
  const query = { cql, start: String(input.start), limit: String(SEARCH_LIMIT) }
  const response = await readInTab(tab, { kind: 'search', path, query }, signal)
  const parsed = SearchResponse.safeParse(response.data)
  if (!parsed.success) throw new ConfluenceReadError('Confluence did not return the expected search results.')
  const results = parsed.data.results.map(({ content, excerpt }) => ({
    ...pageLink(tab.instance, content),
    ...(excerpt && { excerpt: readableText(excerpt.replace(/@@@(?:end)?hl@@@/gi, '')).slice(0, 320) }),
  }))
  return { results, ...pagination(tab.instance, path, parsed.data._links?.next, input.start) }
}

/** Keep only an offset from the next link; each request reconstructs the same origin, path and CQL. */
function pagination(instance: Instance, path: string, next: string | undefined, start: number) {
  if (next === undefined) return {}
  const invalid = { paginationNotice: 'Confluence returned an invalid next page link.' }
  let url: URL
  try {
    url = next.startsWith('/rest/api/')
      ? new URL(instance.origin + instance.path + next)
      : new URL(next, instance.origin + path)
  } catch {
    return invalid
  }
  if (url.origin !== instance.origin || url.pathname !== path || url.username || url.password || url.hash)
    return invalid
  const [value, duplicate] = url.searchParams.getAll('start')
  if (!value || duplicate !== undefined || !/^\d+$/.test(value)) return invalid
  const nextStart = Number(value)
  if (nextStart <= start || nextStart > start + SEARCH_LIMIT) return invalid
  if (nextStart > MAX_START) return { paginationNotice: 'The result limit was reached. Refine the search.' }
  return { nextStart }
}
