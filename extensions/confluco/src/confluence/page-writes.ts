import { z } from '../zod'
import { fetchPublishedPage, pageLink, pageReference, publishedPage, type PageReference } from './references'
import { replaceStorageText } from './storage-edit'
import { refuse, requireTab, updateConfluencePage, type ConfluenceTab } from './tab'

const pageLocation = publishedPage.extend({ space: z.object({ key: z.string().min(1).max(255) }) })
const pageVersion = pageLocation.extend({ version: z.object({ number: z.int().min(1).max(2_147_483_647) }) })
const storedPage = pageVersion.extend({
  ancestors: z.array(z.object({ id: pageReference.shape.id })),
  body: z.object({ storage: z.object({ value: z.string(), representation: z.literal('storage') }) }),
})
const storedFields = 'space,ancestors,version,body.storage'
const editEnglish =
  /^(?:please\s+)?replace\s+(?<before>"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`)\s+with\s+(?<after>"[^"\r\n]*"|“[^”\r\n]*”|`[^`\r\n]*`)\s+on\s+(?:this\s+page|(?<target>https?:\/\/[^\s]+?))[.!]?$/iu
const editChinese =
  /^(?:请\s*)?在(?:当前(?:的)?页面?|本页|这(?:个)?页面?)(?:上)?\s*(?:把|将)\s*(?<before>"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`)\s*(?:替换为|改为|改成)\s*(?<after>"[^"\r\n]*"|“[^”\r\n]*”|`[^`\r\n]*`)[。！!]?$/u

export interface PageEditRequest {
  before: string
  after: string
  targetUrl?: string
}

export function requestedPageEdit(message: string): PageEditRequest | undefined {
  const text = message.trim()
  const match = (editEnglish.exec(text) ?? editChinese.exec(text))?.groups
  if (!match) return undefined
  return { before: match.before.slice(1, -1), after: match.after.slice(1, -1), targetUrl: match.target }
}

function requestedReference(tab: ConfluenceTab, target: string | undefined): PageReference | undefined {
  if (!target) return undefined
  const url = URL.parse(target)
  if (!url) refuse('Use a published page link from the connected Confluence instance.')
  const { origin, path } = tab.instance
  const [id, ...others] = url.searchParams.getAll('pageId')
  const ref = pageReference.safeParse({ instance: origin + path, id })
  if (
    !ref.success ||
    others.length ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.pathname !== path + '/pages/viewpage.action'
  )
    refuse('Use a published page link from the connected Confluence instance.')
  return ref.data
}

function unverifiedWrite(): never {
  refuse('Confluence may have applied the change, but the resulting page could not be verified.', true)
}

async function readWrittenPage(tab: ConfluenceTab, id: string, signal?: AbortSignal) {
  try {
    const ref = { instance: tab.instance.origin + tab.instance.path, id }
    return await fetchPublishedPage(tab, ref, storedPage, storedFields, signal)
  } catch {
    unverifiedWrite()
  }
}

export async function preparePageEdit(
  request: PageEditRequest,
  current: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const { before, after, targetUrl } = request
  if (!before.trim() || before.length > 2000 || after.length > 2000 || /\p{Cc}/u.test(before + after))
    refuse('Quote a non-empty passage and a replacement of at most 2,000 characters each, on one line.')
  if (before === after) refuse('The replacement is the same as the original text.')
  const tab = requireTab(current)
  const ref = requestedReference(tab, targetUrl)
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
    `${action} ${JSON.stringify(page.title)} (${page.url}) in space ${JSON.stringify(original.space.key)}, version ${original.version.number}.\n` +
    `Before: ${JSON.stringify(before)}\nAfter: ${JSON.stringify(after)}`
  )
}

type PageLocation = Pick<z.output<typeof storedPage>, 'id' | 'title' | 'space' | 'ancestors'>

function samePageLocation(left: PageLocation, right: PageLocation): boolean {
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
  const verified = await readWrittenPage(tab, original.id, signal)
  if (
    !samePageLocation(verified, original) ||
    verified.version.number !== next ||
    verified.body.storage.value !== value
  )
    unverifiedWrite()
  return { page: pageLink(tab.instance, verified), version: next, changed: true, bodyVerified: true }
}
