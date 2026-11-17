import { z } from '../zod'
import { collection, collectionStart } from './collection'
import type { Instance } from './instance'
import { fetchPublishedPage, pageLink, pageReference, publishedPage } from './references'
import { getConfluence, refuse, requireTab, type ConfluenceTab } from './tab'

export const spaceKey = z
  .string()
  .regex(/^(?:~[^\p{C}/\\%;?#]+|[a-zA-Z0-9][a-zA-Z0-9_-]*)$/u)
  .max(255)

export const listSpacesArgs = z.strictObject({ start: collectionStart })
export const spaceArgs = z.strictObject({ key: spaceKey.describe('The space key, including ~ for a personal space.') })
export const treeArgs = z.strictObject({
  page: pageReference.optional().describe('Omit to browse the published page in the active tab.'),
  start: collectionStart,
})

const space = z.object({ key: spaceKey, name: z.string().trim().min(1).max(1000) })
const spaceDetail = space.extend({ homepage: publishedPage.nullish() })
const treePage = publishedPage.extend({ ancestors: z.array(publishedPage) })

function spaceLink(instance: Instance, value: z.infer<typeof space>) {
  return {
    ...value,
    url: `${instance.origin}${instance.path}/display/${encodeURIComponent(value.key)}`,
  }
}

export async function listSpaces(offset: number, target: ConfluenceTab | undefined, signal?: AbortSignal) {
  const tab = requireTab(target)
  const { items, ...next } = await collection(tab, 'space', {}, offset, space, { signal })
  return { spaces: items.map((item) => spaceLink(tab.instance, item)), ...next }
}

export async function getSpace(key: string, target: ConfluenceTab | undefined, signal?: AbortSignal) {
  const tab = requireTab(target)
  const response = await getConfluence(tab, `space/${encodeURIComponent(key)}`, { expand: 'homepage' }, signal)
  const parsed = spaceDetail.safeParse(response.data)
  if (!parsed.success || parsed.data.key !== key) refuse('Confluence did not return the requested space.')
  const { homepage, ...item } = parsed.data
  return { ...spaceLink(tab.instance, item), homepage: homepage ? pageLink(tab.instance, homepage) : null }
}

export async function browseTree(
  input: z.output<typeof treeArgs>,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const page = await fetchPublishedPage(tab, input.page, treePage, 'ancestors', signal)

  const { items, ...next } = await collection(tab, `content/${page.id}/child/page`, {}, input.start, publishedPage, {
    signal,
  })
  const ancestors = page.ancestors.slice(-30)
  return {
    page: pageLink(tab.instance, page),
    ancestors: ancestors.map((ancestor) => pageLink(tab.instance, ancestor)),
    ancestorsTruncated: ancestors.length !== page.ancestors.length,
    children: items.map((child) => pageLink(tab.instance, child)),
    ...next,
  }
}
