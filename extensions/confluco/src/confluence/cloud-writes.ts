// Cloud's published child pages, title-only updates, ordinary labels and footer comments.
import { z } from '../zod'
import { cloudCollection, cloudPage, cloudPageLink, fetchCloudPage } from './cloud'
import { commentStorage, matchesCommentText, type CommentRequest } from './comments'
import { confluenceLabel, type LabelRequest } from './labels'
import { spaceKey } from './navigation'
import { plainTextStorage, requestedReference, unverifiedWrite, type PageWriteRequest } from './page-writes'
import { readableText } from './readable-text'
import { pageReference, type PageReference } from './references'
import {
  createCloudChildPage,
  createCloudFooterComment,
  getConfluence,
  refuse,
  renameCloudPage,
  verificationFailed,
  writeConfluenceLabel,
  type ConfluenceTab,
} from './tab'

const id = pageReference.shape.id
export const cloudLocatedPage = cloudPage.extend({
  spaceId: id,
  parentId: id.nullish().transform((value) => (value === '0' ? null : value)),
})
export const cloudRevision = cloudLocatedPage.extend({
  version: z.object({ number: z.int().min(1).max(2_147_483_647) }),
  body: z.object({ storage: z.object({ value: z.string() }) }),
})
const cloudSpace = z.object({ id, key: spaceKey })
const addedLabels = z.object({ results: z.array(confluenceLabel) })
const commentIdentity = z.object({ id, status: z.literal('current') })
const footerComment = commentIdentity.extend({
  pageId: id,
  parentCommentId: id.nullish(),
  body: z.object({ storage: z.object({ value: z.string() }) }),
})

export function cloudReference(tab: ConfluenceTab, id: string): PageReference {
  return { instance: tab.instance.origin + tab.instance.path, id }
}

export function readCloudLocation(tab: ConfluenceTab, ref: PageReference | undefined, signal?: AbortSignal) {
  return fetchCloudPage(tab, ref, cloudLocatedPage, { status: 'current' }, signal)
}

export function readCloudRevision(tab: ConfluenceTab, ref: PageReference | undefined, signal?: AbortSignal) {
  return fetchCloudPage(tab, ref, cloudRevision, { status: 'current', 'body-format': 'storage' }, signal)
}

export async function findCloudTitle(tab: ConfluenceTab, title: string, spaceId: string, signal?: AbortSignal) {
  const { items, cursor, paginationNotice } = await cloudCollection(
    tab,
    'pages',
    { title, 'space-id': spaceId, status: 'current' },
    undefined,
    cloudLocatedPage,
    { signal, limit: 2 },
  )
  if (
    items.some((item) => item.spaceId !== spaceId || item.title.toLowerCase() !== title.toLowerCase()) ||
    (!items.length && (cursor || paginationNotice))
  )
    refuse('Confluence did not return the expected duplicate-title check.')
  return items[0]
}

export async function prepareCloudPageWrite(request: PageWriteRequest, tab: ConfluenceTab, signal?: AbortSignal) {
  const ref = requestedReference(tab, request.targetUrl)
  if (request.action === 'rename') {
    const original = await readCloudRevision(tab, ref, signal)
    const page = cloudPageLink(tab, original)
    const next = original.version.number + 1
    const preview = `Rename "${page.title}" (${page.url}) to "${request.title}".`
    return {
      preview,
      async apply(signal?: AbortSignal) {
        const current = await readCloudRevision(tab, ref, signal)
        if (
          current.id !== original.id ||
          current.version.number !== original.version.number ||
          current.parentId !== original.parentId ||
          current.spaceId !== original.spaceId ||
          current.title !== original.title ||
          current.body.storage.value !== original.body.storage.value
        )
          refuse('The Confluence page changed after the preview. Check its current version before trying again.')
        if (original.title === request.title) return { page, changed: false }
        if (next > 2_147_483_647) refuse('This Confluence page cannot be advanced to another version.')
        // The title-only endpoint accepts no version precondition. Compare the revision before and after it.
        const reply = await renameCloudPage(tab, original.id, request.title, signal)
        const result = cloudPage.safeParse(reply.data)
        if (!result.success || result.data.id !== original.id || result.data.title !== request.title) unverifiedWrite()
        const saved = await readCloudRevision(tab, page.ref, signal).catch(unverifiedWrite)
        if (
          saved.title !== request.title ||
          saved.spaceId !== original.spaceId ||
          saved.parentId !== original.parentId ||
          saved.version.number !== next ||
          saved.body.storage.value !== original.body.storage.value
        )
          unverifiedWrite()
        return {
          page: cloudPageLink(tab, saved),
          previousTitle: original.title,
          version: next,
          changed: true,
          contentPreserved: true,
        }
      },
    }
  }

  if (request.text.length > 40_000) refuse('Shorten the requested page body to 40,000 characters or fewer.')
  const parent = await readCloudLocation(tab, ref, signal)
  if (request.spaceKey) {
    const found = await getConfluence(tab, 'spaces/' + parent.spaceId, {}, signal, 'cloud-v2')
    const space = cloudSpace.safeParse(found.data)
    if (!space.success || space.data.id !== parent.spaceId || space.data.key !== request.spaceKey)
      refuse('The chosen parent is not in the requested Confluence space.')
  }
  const target = cloudPageLink(tab, parent)
  const preview = `Create "${request.title}" under "${target.title}" (${target.url}).`
  return {
    preview,
    async apply(signal?: AbortSignal) {
      const duplicate = await findCloudTitle(tab, request.title, parent.spaceId, signal)
      if (duplicate) return { page: cloudPageLink(tab, duplicate), changed: false, alreadyExists: true }
      const current = await readCloudLocation(tab, ref, signal)
      if (current.id !== parent.id || current.spaceId !== parent.spaceId || current.title !== parent.title)
        refuse('The chosen parent changed. Ask again on the intended page.')
      const text = plainTextStorage(request.text)
      const reply = await createCloudChildPage(
        tab,
        { spaceId: parent.spaceId, parentId: parent.id, title: request.title, text },
        signal,
      )
      const created = cloudLocatedPage.safeParse(reply.data)
      if (
        !created.success ||
        created.data.id === parent.id ||
        created.data.title !== request.title ||
        created.data.parentId !== parent.id ||
        created.data.spaceId !== parent.spaceId
      )
        unverifiedWrite()
      const saved = await readCloudRevision(tab, cloudReference(tab, created.data.id), signal).catch(unverifiedWrite)
      if (
        saved.title !== request.title ||
        saved.parentId !== parent.id ||
        saved.spaceId !== parent.spaceId ||
        saved.version.number !== 1 ||
        readableText(saved.body.storage.value) !== readableText(text)
      )
        unverifiedWrite()
      return {
        page: cloudPageLink(tab, saved),
        parent: target,
        version: saved.version.number,
        changed: true,
        bodyVerified: true,
      }
    },
  }
}

async function cloudHasLabel(tab: ConfluenceTab, page: string, name: string, signal?: AbortSignal) {
  let cursor: string | undefined
  for (let count = 0; count < 4; count++) {
    const result = await cloudCollection(tab, `pages/${page}/labels`, { prefix: 'global' }, cursor, confluenceLabel, {
      signal,
      limit: 100,
    })
    if (result.items.some((item) => item.prefix === 'global' && item.name === name)) return true
    if (result.paginationNotice) break
    if (!result.cursor) return false
    cursor = result.cursor
  }
  refuse('Confluco could not check the requested label within its read limit.')
}

export async function applyCloudLabel(request: LabelRequest, tab: ConfluenceTab, signal?: AbortSignal) {
  const page = await readCloudLocation(tab, undefined, signal)
  const name = request.label.toLowerCase()
  const present = request.action === 'add'
  const result = { page: cloudPageLink(tab, page), label: name, present }
  if ((await cloudHasLabel(tab, page.id, name, signal)) === present) return { ...result, changed: false }
  const current = await readCloudLocation(tab, undefined, signal)
  if (current.id !== page.id)
    refuse('The page changed before the label could be updated. Ask again on the intended page.')
  const receipt = await writeConfluenceLabel(
    tab,
    page.id,
    present ? { method: 'POST', body: [{ prefix: 'global', name }] } : { method: 'DELETE', query: { name } },
    signal,
  )
  if (present) {
    const parsed = addedLabels.safeParse(receipt.data)
    if (
      receipt.status !== 200 ||
      !parsed.success ||
      !parsed.data.results.some((item) => item.prefix === 'global' && item.name === name)
    )
      verificationFailed('Confluence did not confirm the label addition. Check the page before trying again.')
  } else if (receipt.status !== 204) {
    verificationFailed('Confluence did not confirm the label removal. Check the page before trying again.')
  }
  try {
    if ((await cloudHasLabel(tab, page.id, name, signal)) === present) return { ...result, changed: true }
  } catch (error) {
    verificationFailed(
      'The label change may have been applied, but its result could not be verified. Check the page before trying again.',
      error,
    )
  }
  refuse('Confluence did not confirm the expected label state. Check the page before trying again.', true)
}

async function readCloudComment(tab: ConfluenceTab, id: string, pageId: string, signal?: AbortSignal) {
  const reply = await getConfluence(tab, 'footer-comments/' + id, { 'body-format': 'storage' }, signal, 'cloud-v2')
  const parsed = footerComment.safeParse(reply.data)
  if (!parsed.success || parsed.data.id !== id || parsed.data.pageId !== pageId)
    refuse('Confluence did not return that footer comment on the intended page.')
  return parsed.data
}

function unverifiedComment(cause?: unknown): never {
  verificationFailed('The comment may have been posted. Check the page discussion before asking again.', cause)
}

export async function prepareCloudComment(request: CommentRequest, tab: ConfluenceTab, signal?: AbortSignal) {
  if (!request.text.trim() || request.text.length > 4000)
    refuse('Write a non-empty comment of at most 4,000 characters.')
  const ref = requestedReference(tab, request.targetUrl)
  const page = await readCloudLocation(tab, ref, signal)
  const link = cloudPageLink(tab, page)
  const parent = request.parentId ? await readCloudComment(tab, request.parentId, page.id, signal) : undefined
  const destination = `"${link.title}" (${link.url})`
  const heading = parent
    ? `Reply to comment ${parent.id} on ${destination}.\nParent: ${readableText(parent.body.storage.value).slice(0, 2000)}\n`
    : `Add a footer comment to ${destination}.\n`
  return {
    preview: heading + `Comment: ${JSON.stringify(request.text)}`,
    async apply(signal?: AbortSignal) {
      const current = await readCloudLocation(tab, ref, signal)
      if (current.id !== page.id || current.title !== page.title) refuse('The target page changed after the preview.')
      if (parent) {
        const latest = await readCloudComment(tab, parent.id, page.id, signal)
        if (latest.body.storage.value !== parent.body.storage.value)
          refuse('The parent comment changed after the preview. Review it and ask again.')
      }
      const created = await createCloudFooterComment(
        tab,
        parent ? { parentCommentId: parent.id } : { pageId: page.id },
        commentStorage(request.text),
        signal,
      )
      const identity = commentIdentity.safeParse(created.data)
      if (!identity.success || identity.data.id === parent?.id) unverifiedComment()
      const saved = await readCloudComment(tab, identity.data.id, page.id, signal).catch(unverifiedComment)
      if (
        (saved.parentCommentId ?? undefined) !== parent?.id ||
        !matchesCommentText(saved.body.storage.value, request.text)
      )
        unverifiedComment()
      const url = new URL(link.url)
      url.searchParams.set('focusedCommentId', saved.id)
      url.hash = 'comment-' + saved.id
      return {
        page: link,
        comment: { id: saved.id, url: url.href, parentId: parent?.id ?? null, location: 'footer' },
        changed: true,
      }
    },
  }
}
