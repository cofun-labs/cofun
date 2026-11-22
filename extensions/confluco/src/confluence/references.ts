import { z } from '../zod'
import type { Instance } from './instance'
import { getConfluence, refuse, type ConfluenceTab } from './tab'

const pageId = z.string().regex(/^\d{1,20}$/)

export const pageReference = z.strictObject({
  instance: z.string().min(1).max(2048).describe('The instance base URL from the page reference.'),
  id: pageId.describe('The page ID from the same reference.'),
})
export type PageReference = z.output<typeof pageReference>

/** The page a link on the tab's Confluence site names, if it names one there. */
export function linkedPage(tab: ConfluenceTab, link: string): PageReference | undefined {
  const url = URL.parse(link)
  if (!url) return undefined
  const { origin, path } = tab.instance
  const at = url.pathname.slice(path.length)
  const ids = url.searchParams.getAll('pageId')
  const id =
    at === '/pages/viewpage.action' && ids.length === 1
      ? ids[0]
      : /^\/spaces\/[^/]+\/pages\/(\d{1,20})(?:\/[^/]+)?\/?$/.exec(at)?.[1]
  const ref = pageReference.safeParse({ instance: origin + path, id })
  if (!ref.success || url.origin !== origin || url.username || url.password || !url.pathname.startsWith(path + '/'))
    return undefined
  return ref.data
}

/** A Cloud folder in the page tree, with the same site binding as a page reference. */
export const folderReference = z.strictObject({
  instance: z.string().min(1).max(2048).describe('The instance base URL from the folder reference.'),
  id: pageId.describe('The folder ID from the same reference.'),
})

export const publishedPage = z.object({
  id: pageId,
  type: z.literal('page'),
  status: z.literal('current'),
  title: z.string().trim().min(1).max(1000),
})
export type PublishedPage = z.output<typeof publishedPage>

export function pageLink(instance: Instance, page: Pick<PublishedPage, 'id' | 'title'>) {
  const base = instance.origin + instance.path
  return {
    title: page.title,
    url: `${base}/pages/viewpage.action?pageId=${page.id}`,
    ref: { instance: base, id: page.id },
  }
}

export function pageResource(tab: ConfluenceTab, reference: PageReference | undefined): string | null {
  if (!reference) return null
  if (reference.instance !== tab.instance.origin + tab.instance.path)
    refuse('This page reference belongs to a different Confluence instance.')
  return `content/${reference.id}`
}

export async function fetchPublishedPage<S extends z.ZodType<PublishedPage>>(
  tab: ConfluenceTab,
  reference: PageReference | undefined,
  schema: S,
  expand: string,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  const response = await getConfluence(tab, pageResource(tab, reference), { expand }, signal)
  const parsed = schema.safeParse(response.data)
  if (!parsed.success || parsed.data.id !== (reference?.id ?? response.pageId))
    refuse('Confluence did not return the expected published page.')
  return parsed.data
}
