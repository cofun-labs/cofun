// Confluence Cloud's responses differ from self-managed Confluence. Both are read in the
// connected tab through tab.ts, using the tab's own site session.
import { z } from '../zod'
import { readableText } from './readable-text'
import { pageReference } from './references'
import { getConfluence, refuse, restUrl, type ConfluenceTab } from './tab'

const page = z.object({
  id: pageReference.shape.id,
  status: z.literal('current'),
  title: z.string().trim().min(1).max(1000),
  _links: z.object({ webui: z.string().max(4096).optional() }).optional(),
})

const pageBody = page.extend({ body: z.object({ view: z.object({ value: z.string() }) }) })
const searchResponse = z.object({
  results: z
    .array(z.object({ content: page.extend({ type: z.literal('page') }), excerpt: z.string().max(16_000).optional() }))
    .max(10),
  _links: z.object({ next: z.string().max(8192).optional() }).optional(),
})

function pageLink(tab: ConfluenceTab, { id, title, _links }: z.output<typeof page>) {
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

export async function readCloudPage(tab: ConfluenceTab, signal?: AbortSignal) {
  const response = await getConfluence(tab, null, { 'body-format': 'view', status: 'current' }, signal, 'cloud-v2')
  const parsed = pageBody.safeParse(response.data)
  if (!parsed.success || parsed.data.id !== response.pageId)
    refuse('Confluence did not return the expected published page.')
  return { ...pageLink(tab, parsed.data), text: readableText(parsed.data.body.view.value) }
}

type CloudHit = ReturnType<typeof pageLink> & { excerpt?: string }

export async function searchCloudPages(
  tab: ConfluenceTab,
  cql: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<{ results: CloudHit[]; cursor?: string; paginationNotice?: string }> {
  const query = { cql, limit: '10', ...(cursor && { cursor }) }
  const response = await getConfluence(tab, 'search', query, signal)
  const parsed = searchResponse.safeParse(response.data)
  if (!parsed.success) refuse('Confluence did not return the expected search results.')
  const results = parsed.data.results.map(({ content, excerpt }) => ({ ...pageLink(tab, content), excerpt }))
  const next = parsed.data._links?.next
  if (next === undefined) return { results }
  const url = restUrl(tab.instance, 'search', query, 'api')
  const invalid = { results, paginationNotice: 'Confluence returned an invalid next page link.' }
  try {
    const link = new URL(next.startsWith('/rest/api/search?') ? '/wiki' + next : next, url)
    if (link.origin !== url.origin || link.pathname !== url.pathname || link.username || link.password || link.hash)
      return invalid
    const [value, duplicate] = link.searchParams.getAll('cursor')
    const [linkedCql, duplicateCql] = link.searchParams.getAll('cql')
    if (
      !value ||
      value.length > 2048 ||
      value === cursor ||
      duplicate !== undefined ||
      duplicateCql !== undefined ||
      (linkedCql !== undefined && linkedCql !== cql)
    )
      return invalid
    return { results, cursor: value }
  } catch {
    return invalid
  }
}
