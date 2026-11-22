import { z } from '../zod'
import { readableText } from './readable-text'
import { fetchPublishedPage, pageLink, pageReference, publishedPage, type PageReference } from './references'
import { replaceStorageText } from './storage-edit'
import {
  createConfluenceContent,
  getConfluence,
  refuse,
  verificationFailed,
  requireTab,
  updateConfluencePage,
  type ConfluenceTab,
} from './tab'

export const title = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\p{C}]+$/u)
const pageLocation = publishedPage.extend({ space: z.object({ key: z.string().min(1).max(255) }) })
const pageVersion = pageLocation.extend({ version: z.object({ number: z.int().min(1).max(2_147_483_647) }) })
export const storedPage = pageVersion.extend({
  ancestors: z.array(z.object({ id: pageReference.shape.id })),
  body: z.object({ storage: z.object({ value: z.string(), representation: z.literal('storage') }) }),
})
export const storedFields = 'space,ancestors,version,body.storage'

export type PageWriteRequest =
  | { action: 'create'; title: string; parent?: PageReference; text: string }
  | { action: 'rename'; title: string; page?: PageReference }

export interface PageEditRequest {
  before: string
  after: string
  page?: PageReference
}

interface PreparedCreate {
  action: 'create'
  tab: ConfluenceTab
  ref?: PageReference
  request: Extract<PageWriteRequest, { action: 'create' }>
  target: z.output<typeof pageLocation>
}

interface PreparedRename {
  action: 'rename'
  tab: ConfluenceTab
  ref?: PageReference
  request: Extract<PageWriteRequest, { action: 'rename' }>
  target: z.output<typeof storedPage>
}

export async function preparePageWrite(
  request: PageWriteRequest,
  current: ConfluenceTab | undefined,
  signal?: AbortSignal,
): Promise<PreparedCreate | PreparedRename> {
  const tab = requireTab(current)
  if (request.action === 'rename') {
    const ref = request.page
    const target = await fetchPublishedPage(tab, ref, storedPage, storedFields, signal)
    return { action: 'rename', tab, ref, request, target }
  }
  const ref = request.parent
  const target = await fetchPublishedPage(tab, ref, pageLocation, 'space', signal)
  return { action: 'create', tab, ref, request, target }
}

export function describePageWrite(plan: PreparedCreate | PreparedRename): string {
  const target = pageLink(plan.tab.instance, plan.target)
  const site = `${plan.tab.instance.origin}${plan.tab.instance.path}`
  const destination = `"${target.title}" (${target.url}) in space ${plan.target.space.key} on ${site}`
  return plan.action === 'create'
    ? `Create "${plan.request.title}" under ${destination}.`
    : `Rename ${destination} to "${plan.request.title}".`
}

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function plainTextStorage(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\n+/)
    .map((paragraph) => {
      const content = paragraph.replace(/[&<>"']/g, (character) => entities[character]).replace(/\n/g, '<br />')
      return `<p>${content}</p>`
    })
    .join('')
}

export async function findTitleInSpace(tab: ConfluenceTab, title: string, spaceKey: string, signal?: AbortSignal) {
  const response = await getConfluence(
    tab,
    'content',
    {
      spaceKey,
      title,
      type: 'page',
      status: 'current',
      expand: 'space',
      limit: '2',
    },
    signal,
  )
  const parsed = z.object({ results: z.array(pageLocation).max(2) }).safeParse(response.data)
  if (
    !parsed.success ||
    parsed.data.results.some((item) => item.space.key !== spaceKey || item.title.toLowerCase() !== title.toLowerCase())
  )
    refuse('Confluence did not return the expected duplicate-title check.')
  return parsed.data.results[0]
}

export function unverifiedWrite(cause?: unknown): never {
  verificationFailed('Confluence may have applied the change, but the resulting page could not be verified.', cause)
}

export async function readWrittenPage(tab: ConfluenceTab, id: string, signal?: AbortSignal) {
  try {
    const ref = { instance: tab.instance.origin + tab.instance.path, id }
    return await fetchPublishedPage(tab, ref, storedPage, storedFields, signal)
  } catch (error) {
    unverifiedWrite(error)
  }
}

export async function preparePageEdit(
  request: PageEditRequest,
  current: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const { before, after, page: ref } = request
  const tab = requireTab(current)
  const original = await fetchPublishedPage(tab, ref, storedPage, storedFields, signal)
  const value = replaceStorageText(original.body.storage.value, before, after)
  return { tab, ref, original, value, preview: describeEdit('Edit', tab, original, before, after) }
}

function describeEdit(
  action: string,
  tab: ConfluenceTab,
  original: z.output<typeof storedPage>,
  before: string,
  after: string,
): string {
  const page = pageLink(tab.instance, original)
  return (
    `${action} "${page.title}" (${page.url}) in space ${original.space.key}, version ${original.version.number}.\n` +
    `Before: ${JSON.stringify(before)}\nAfter: ${JSON.stringify(after)}`
  )
}

type PageLocation = Pick<z.output<typeof storedPage>, 'id' | 'title' | 'space' | 'ancestors'>

export function samePageLocation(left: PageLocation, right: PageLocation): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.space.key === right.space.key &&
    left.ancestors.length === right.ancestors.length &&
    left.ancestors.every(({ id }, index) => id === right.ancestors[index]?.id)
  )
}

export async function applyPageEdit(plan: Awaited<ReturnType<typeof preparePageEdit>>, signal?: AbortSignal) {
  const { tab, ref, original, value } = plan
  const current = await fetchPublishedPage(tab, ref, storedPage, storedFields, signal)
  if (
    !samePageLocation(current, original) ||
    current.version.number !== original.version.number ||
    current.body.storage.value !== original.body.storage.value
  )
    refuse('The Confluence page changed after the preview. Review the current page and ask for a new preview.')
  if (original.version.number === 2_147_483_647) refuse('This Confluence page cannot be advanced to another version.')

  const next = original.version.number + 1
  let recovered = false
  try {
    await updateConfluencePage(
      tab,
      original.id,
      {
        type: 'page',
        title: original.title,
        version: { number: next },
        body: { storage: { value, representation: 'storage' } },
      },
      signal,
    )
  } catch (error) {
    if (signal?.aborted || !(error instanceof Error) || !('mayHaveChanged' in error) || error.mayHaveChanged !== true)
      throw error
    recovered = true
  }
  const verified = await readWrittenPage(tab, original.id, signal)
  if (
    !samePageLocation(verified, original) ||
    verified.version.number !== next ||
    verified.body.storage.value !== value
  )
    unverifiedWrite()
  return { page: pageLink(tab.instance, verified), version: next, changed: true, bodyVerified: true, recovered }
}

export async function applyPageWrite(plan: PreparedCreate | PreparedRename, signal?: AbortSignal) {
  const { tab, ref, request, target } = plan
  if (plan.action === 'create') {
    const duplicate = await findTitleInSpace(tab, request.title, target.space.key, signal)
    if (duplicate) return { page: pageLink(tab.instance, duplicate), changed: false, alreadyExists: true }
    const parent = await fetchPublishedPage(tab, ref, pageLocation, 'space', signal)
    if (parent.id !== target.id || parent.space.key !== target.space.key)
      refuse('The chosen parent changed. Ask again on the intended page.')
    const value = plainTextStorage(plan.request.text)
    const response = await createConfluenceContent(
      tab,
      {
        type: 'page',
        title: request.title,
        space: { key: parent.space.key },
        ancestors: [{ id: parent.id }],
        body: { storage: { value, representation: 'storage' } },
      },
      signal,
    )
    const created = publishedPage.safeParse(response.data)
    if (!created.success || created.data.title !== request.title) unverifiedWrite()
    const verified = await readWrittenPage(tab, created.data.id, signal)
    if (
      verified.title !== request.title ||
      verified.space.key !== parent.space.key ||
      verified.ancestors.at(-1)?.id !== parent.id ||
      readableText(verified.body.storage.value) !== readableText(value)
    )
      unverifiedWrite()
    return {
      page: pageLink(tab.instance, verified),
      parent: pageLink(tab.instance, parent),
      space: parent.space.key,
      version: verified.version.number,
      changed: true,
      bodyVerified: true,
    }
  }

  if (target.title === request.title) return { page: pageLink(tab.instance, target), changed: false }
  const original = plan.target
  const current = await fetchPublishedPage(tab, ref, pageVersion, 'space,version', signal)
  if (
    current.id !== original.id ||
    current.title !== original.title ||
    current.space.key !== original.space.key ||
    current.version.number !== original.version.number
  )
    refuse('The Confluence page changed after the preview. Check its current version before trying again.')
  if (original.version.number === 2_147_483_647) refuse('This Confluence page cannot be advanced to another version.')
  const next = original.version.number + 1
  const response = await updateConfluencePage(
    tab,
    original.id,
    {
      type: 'page',
      title: request.title,
      version: { number: next },
      body: { storage: original.body.storage },
    },
    signal,
  )
  const updated = publishedPage.safeParse(response.data)
  if (!updated.success || updated.data.id !== original.id || updated.data.title !== request.title) unverifiedWrite()
  const verified = await readWrittenPage(tab, original.id, signal)
  if (
    verified.title !== request.title ||
    verified.version.number !== next ||
    verified.space.key !== original.space.key ||
    verified.ancestors.at(-1)?.id !== original.ancestors.at(-1)?.id ||
    verified.body.storage.value !== original.body.storage.value
  )
    unverifiedWrite()
  return {
    page: pageLink(tab.instance, verified),
    previousTitle: original.title,
    version: next,
    changed: true,
    contentPreserved: true,
  }
}
