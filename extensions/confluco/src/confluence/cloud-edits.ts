// Published Cloud edits follow the service's draft reconciliation behavior.
import { cloudPageLink } from './cloud'
import { cloudRevision, readCloudRevision } from './cloud-writes'
import { unverifiedWrite, type PageEditRequest } from './page-writes'
import { replaceStorageText } from './storage-edit'
import { refuse, updateCloudPage, type ConfluenceTab } from './tab'
import { z } from '../zod'

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
  const page = await readCloudRevision(tab, request.page, signal)
  const value = replaceStorageText(page.body.storage.value, request.before, request.after)
  return preparedEdit(tab, page, value, request.before, request.after)
}
