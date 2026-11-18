// Confluence Cloud's responses differ from self-managed Confluence. Both are read in the
// captured Confluence tab through tab.ts, using the tab's own site session.
import { z } from '../zod'
import { readableText } from './readable-text'
import { pageReference, type PageReference } from './references'
import { getConfluence, refuse, restUrl, type ConfluenceTab } from './tab'

export const cloudPage = z.object({
  id: pageReference.shape.id,
  status: z.literal('current'),
  title: z.string().trim().min(1).max(1000),
  _links: z.object({ webui: z.string().max(4096).optional() }).optional(),
})

const pageBody = cloudPage.extend({ body: z.object({ view: z.object({ value: z.string() }) }) })
export function cloudPageLink(
  tab: ConfluenceTab,
  { id, title, _links }: Pick<z.output<typeof cloudPage>, 'id' | 'title' | '_links'>,
) {
  const base = tab.instance.origin + tab.instance.path
  let url = `${base}/pages/viewpage.action?pageId=${id}`
  // Atlassian returns /spaces/... relative to /wiki. Accept only the same origin and page ID.
  const web = _links?.webui
  if (web && /^\/(?:wiki\/)?spaces\/[^/]+\/pages\/\d{1,20}(?:\/[^/?#]+)?\/?$/.test(web)) {
    const candidate = new URL(web.startsWith('/wiki/') ? web : '/wiki' + web, tab.instance.origin)
    if (
      candidate.origin === tab.instance.origin &&
      /^\/wiki\/spaces\/[^/]+\/pages\/(\d+)(?:\/|$)/.exec(candidate.pathname)?.[1] === id
    )
      url = candidate.href
  }
  return { title, url, ref: { instance: base, id } }
}

export async function fetchCloudPage<S extends z.ZodType<{ id: string }>>(
  tab: ConfluenceTab,
  reference: PageReference | undefined,
  schema: S,
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  if (reference && reference.instance !== tab.instance.origin + tab.instance.path)
    refuse('This page reference belongs to a different Confluence instance.')
  const response = await getConfluence(tab, reference ? 'pages/' + reference.id : null, query, signal, 'cloud-v2')
  const parsed = schema.safeParse(response.data)
  if (!parsed.success || parsed.data.id !== (reference?.id ?? response.pageId))
    refuse('Confluence did not return the expected published page.')
  return parsed.data
}

export async function readCloudPage(tab: ConfluenceTab, signal?: AbortSignal) {
  const page = await fetchCloudPage(tab, undefined, pageBody, { 'body-format': 'view', status: 'current' }, signal)
  return { ...cloudPageLink(tab, page), text: readableText(page.body.view.value) }
}

export async function cloudCollection<S extends z.ZodType>(
  tab: ConfluenceTab,
  resource: string,
  filters: Record<string, string>,
  cursor: string | undefined,
  item: S,
  { signal, area = 'cloud-v2', limit = 10 }: { signal?: AbortSignal; area?: 'api' | 'cloud-v2'; limit?: number } = {},
): Promise<{ items: z.output<S>[]; cursor?: string; paginationNotice?: string }> {
  const query = { ...filters, limit: String(limit), ...(cursor && { cursor }) }
  const response = await getConfluence(tab, resource, query, signal, area)
  const schema = z.object({
    results: z.array(item).max(limit),
    _links: z.object({ next: z.string().max(8192).optional() }).optional(),
  })
  const parsed = schema.safeParse(response.data)
  if (!parsed.success) refuse('Confluence did not return the expected results.')
  const items = parsed.data.results
  const next = parsed.data._links?.next
  if (next === undefined) return { items }
  const url = restUrl(tab.instance, resource, query, area)
  const invalid = { items, paginationNotice: 'Confluence returned an invalid next page link.' }
  try {
    const link = new URL(/^\/(?:rest\/api|api\/v2)\//.test(next) ? '/wiki' + next : next, url)
    if (link.origin !== url.origin || link.pathname !== url.pathname || link.username || link.password || link.hash)
      return invalid
    const [value, duplicate] = link.searchParams.getAll('cursor')
    if (!value || value.length > 2048 || value === cursor || duplicate !== undefined) return invalid
    for (const [key, value] of Object.entries(filters)) {
      const [linked, duplicate] = link.searchParams.getAll(key)
      if (duplicate !== undefined || (linked !== undefined && linked !== value)) return invalid
    }
    return { items, cursor: value }
  } catch {
    return invalid
  }
}

const searchHit = z.object({
  content: cloudPage.extend({ type: z.literal('page') }),
  excerpt: z.string().max(16_000).optional(),
})

export async function searchCloudPages(tab: ConfluenceTab, cql: string, cursor?: string, signal?: AbortSignal) {
  const { items, ...next } = await cloudCollection(tab, 'search', { cql }, cursor, searchHit, { signal, area: 'api' })
  const results = items.map(({ content, excerpt }) => ({ ...cloudPageLink(tab, content), excerpt }))
  return { results, ...next }
}
