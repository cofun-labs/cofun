// Published Cloud edits follow the service's draft reconciliation behavior.
import { cloudPageLink, fetchCloudPage } from './cloud'
import { cloudReference, cloudRevision, readCloudRevision } from './cloud-writes'
import {
  requireEditPassages,
  requestedReference,
  unverifiedWrite,
  type PageEditRequest,
  type PageEditUndo,
} from './page-writes'
import { replaceStorageText } from './storage-edit'
import { refuse, updateCloudPage, type ConfluenceTab } from './tab'
import { z } from '../zod'

const historical = cloudRevision.extend({
  status: z.enum(['current', 'historical']),
  version: cloudRevision.shape.version.extend({ hidden: z.boolean().optional() }),
})
type Revision = z.output<typeof cloudRevision>

function sameLocation(left: Pick<Revision, 'id' | 'title' | 'spaceId' | 'parentId'>, right: Revision) {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.spaceId === right.spaceId &&
    left.parentId === right.parentId
  )
}

function preparedEdit(tab: ConfluenceTab, original: Revision, value: string, before: string, after: string) {
  const page = cloudPageLink(tab, original)
  return {
    preview:
      `Edit "${page.title}" (${page.url}), version ${original.version.number}.\n` +
      `Before: ${JSON.stringify(before)}\nAfter: ${JSON.stringify(after)}\n` +
      'Confluence may merge this published change into an unpublished draft or overwrite that draft.',
    async apply(signal?: AbortSignal) {
      const current = await readCloudRevision(tab, page.ref, signal)
      if (
        !sameLocation(current, original) ||
        current.version.number !== original.version.number ||
        current.body.storage.value !== original.body.storage.value
      )
        refuse('The Confluence page changed after the preview. Review the current page and ask for a new preview.')
      if (original.version.number === 2_147_483_647)
        refuse('This Confluence page cannot be advanced to another version.')
      const version = original.version.number + 1
      let recovered = false
      try {
        const reply = await updateCloudPage(tab, page.ref.id, { title: original.title, version, text: value }, signal)
        const receipt = cloudRevision.omit({ body: true }).safeParse(reply.data)
        if (!receipt.success || !sameLocation(receipt.data, original) || receipt.data.version.number !== version)
          unverifiedWrite()
      } catch (error) {
        if (
          signal?.aborted ||
          !(error instanceof Error) ||
          !('mayHaveChanged' in error) ||
          error.mayHaveChanged !== true
        )
          throw error
        recovered = true
      }
      const saved = await readCloudRevision(tab, page.ref, signal).catch(unverifiedWrite)
      if (!sameLocation(saved, original) || saved.version.number !== version || saved.body.storage.value !== value)
        unverifiedWrite()
      return { page: cloudPageLink(tab, saved), version, changed: true, bodyVerified: true, recovered }
    },
  }
}

export async function prepareCloudPageEdit(request: PageEditRequest, tab: ConfluenceTab, signal?: AbortSignal) {
  requireEditPassages(request.before, request.after)
  const page = await readCloudRevision(tab, requestedReference(tab, request.targetUrl), signal)
  const value = replaceStorageText(page.body.storage.value, request.before, request.after)
  return preparedEdit(tab, page, value, request.before, request.after)
}

export async function prepareCloudUndoEdit(record: PageEditUndo, tab: ConfluenceTab, signal?: AbortSignal) {
  const ref = cloudReference(tab, record.page.id)
  if (ref.instance !== record.page.instance) refuse('The last edit belongs to a different Confluence site.')
  const current = await readCloudRevision(tab, ref, signal)
  if (current.version.number !== record.version)
    refuse('The page has changed since the last edit. Review its version history to decide how to undo it.')
  const previous = await fetchCloudPage(
    tab,
    ref,
    historical,
    {
      version: String(record.version - 1),
      'body-format': 'storage',
    },
    signal,
  )
  if (
    previous.version.hidden ||
    previous.version.number !== record.version - 1 ||
    // Cloud's historical parentId does not reliably describe the page's published location.
    previous.title !== current.title ||
    previous.spaceId !== current.spaceId ||
    replaceStorageText(previous.body.storage.value, record.before, record.after) !== current.body.storage.value
  )
    refuse('The earlier version does not match the last edit. Review the page history before undoing.')
  return preparedEdit(tab, current, previous.body.storage.value, record.after, record.before)
}
