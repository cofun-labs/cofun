// Cloud restores use the site's native confirmation form, followed by a REST state check.
import { z } from '../zod'
import { cloudPageLink } from './cloud'
import { cloudRevision } from './cloud-writes'
import { spaceKey } from './navigation'
import type { PageTrashUndo } from './page-status'
import { requestedReference } from './page-writes'
import { pageReference, type PageReference } from './references'
import { getConfluence, refuse, restoreCloudPage, verificationFailed, type ConfluenceTab } from './tab'

const stateSchema = cloudRevision.extend({ status: z.enum(['current', 'trashed']) })
const spaceSchema = z.object({ id: pageReference.shape.id, key: spaceKey })

async function readState(tab: ConfluenceTab, ref: PageReference, signal?: AbortSignal) {
  if (ref.instance !== tab.instance.origin + tab.instance.path)
    refuse('This page belongs to a different Confluence site.')
  const response = await getConfluence(
    tab,
    'pages/' + ref.id,
    {
      status: ['current', 'trashed'],
      'body-format': 'storage',
    },
    signal,
    'cloud-v2',
  )
  const parsed = stateSchema.safeParse(response.data)
  if (!parsed.success || parsed.data.id !== ref.id)
    refuse('Confluence did not return the expected published or trashed page.')
  return parsed.data
}

export async function prepareCloudRestore(
  tab: ConfluenceTab,
  targetUrl: string | undefined,
  signal?: AbortSignal,
  undo?: PageTrashUndo,
) {
  const ref = undo?.page ?? requestedReference(tab, targetUrl)
  if (!ref) refuse('Use the canonical link of the trashed page to restore it.')
  const page = await readState(tab, ref, signal)
  if (undo && (page.status !== 'trashed' || page.version.number !== undo.version))
    refuse('The page state changed after the last trash action. Review the page before restoring it.')
  const response = await getConfluence(tab, 'spaces/' + page.spaceId, {}, signal, 'cloud-v2')
  const space = spaceSchema.safeParse(response.data)
  if (!space.success || space.data.id !== page.spaceId)
    refuse('Confluence did not return the expected space for this page.')
  const link = cloudPageLink(tab, page)
  return {
    preview:
      `Restore "${link.title}" (${link.url}) from the trash. Review access before allowing this change. ` +
      'Confluence may restore the page at the space root and remove inherited restrictions.',
    confirm: page.status === 'trashed',
    async apply(signal?: AbortSignal) {
      const current = await readState(tab, ref, signal)
      if (
        current.status !== page.status ||
        current.title !== page.title ||
        current.spaceId !== page.spaceId ||
        current.version.number !== page.version.number ||
        current.body.storage.value !== page.body.storage.value
      )
        refuse('The page changed after the preview. Review its current state and ask again.')
      if (current.status === 'current')
        return { page: link, status: current.status, version: current.version.number, changed: false }
      const unverified = (cause?: unknown) =>
        verificationFailed('The page state may have changed. Check the page or space trash before asking again.', cause)
      try {
        await restoreCloudPage(tab, page.id, space.data.key, signal)
      } catch (error) {
        if (
          signal?.aborted ||
          !(error instanceof Error) ||
          !('mayHaveChanged' in error) ||
          error.mayHaveChanged !== true
        )
          throw error
      }
      const saved = await readState(tab, ref, signal).catch(unverified)
      if (
        saved.status !== 'current' ||
        saved.title !== page.title ||
        saved.spaceId !== page.spaceId ||
        saved.version.number !== page.version.number ||
        saved.body.storage.value !== page.body.storage.value
      )
        unverified()
      return {
        page: cloudPageLink(tab, saved),
        status: saved.status,
        version: saved.version.number,
        changed: true,
        atSpaceRoot: !saved.parentId,
      }
    },
  }
}
