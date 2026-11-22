// Operations that change Cloud's published page hierarchy.
import { z } from '../zod'
import { cloudCollection, cloudPageLink, fetchCloudPage } from './cloud'
import {
  cloudLocatedPage,
  cloudReference,
  cloudRevision,
  findCloudTitle,
  readCloudLocation,
  readCloudRevision,
} from './cloud-writes'
import { requireRetainedAccess } from './history'
import { requireCopyableStorage, type OrganizationRequest } from './page-organization'
import { unverifiedWrite } from './page-writes'
import { pageReference, type PageReference } from './references'
import {
  createCloudChildPage,
  moveCloudPage,
  refuse,
  trashCloudPage,
  verificationFailed,
  type ConfluenceTab,
} from './tab'

const id = pageReference.shape.id
const ancestor = z.object({ id, type: z.string().min(1).max(60) })
const moveReceipt = z.object({ pageId: id })
const trashState = cloudLocatedPage.extend({ status: z.literal('trashed'), version: cloudRevision.shape.version })
type Location = z.output<typeof cloudLocatedPage>
type Revision = z.output<typeof cloudRevision>

function samePage(left: Location, right: Location) {
  return left.id === right.id && left.spaceId === right.spaceId && left.title === right.title
}

function sameRevision(left: Revision, right: Revision) {
  return left.version.number === right.version.number && left.body.storage.value === right.body.storage.value
}

async function lineage(tab: ConfluenceTab, page: Location, signal?: AbortSignal) {
  // Atlassian continues a full batch through its first ancestor. Require a complete chain before a write.
  const limit = 30
  const result = await cloudCollection(tab, `pages/${page.id}/ancestors`, {}, undefined, ancestor, { limit, signal })
  const ids = result.items.map(({ id }) => id)
  if (
    ids.length === limit ||
    result.cursor ||
    result.paginationNotice ||
    result.items.some((item) => item.type !== 'page') ||
    (ids.at(-1) ?? null) !== (page.parentId ?? null) ||
    new Set(ids).size !== ids.length ||
    ids.includes(page.id)
  )
    refuse('Confluence did not report a complete page-only hierarchy. Review the hierarchy in Confluence.')
  return [...ids, page.id]
}

async function requireBodyOnlyCopy(tab: ConfluenceTab, page: Revision, signal?: AbortSignal) {
  requireCopyableStorage(page.body.storage.value)
  const attachments = await cloudCollection(tab, `pages/${page.id}/attachments`, {}, undefined, z.unknown(), {
    limit: 1,
    signal,
  })
  if (attachments.items.length || attachments.cursor || attachments.paginationNotice)
    throw new Error('This page has attachments, or they could not be checked. The user can copy it in Confluence.')
}

async function checkOrganization(
  tab: ConfluenceTab,
  action: OrganizationRequest['action'],
  source: Revision,
  destination: Location,
  signal?: AbortSignal,
) {
  if (source.spaceId !== destination.spaceId) throw new Error('Choose a parent in the same Confluence space.')
  if (action === 'move' && !source.parentId)
    throw new Error('Confluco does not move top-level pages. The user can move it in Confluence.')
  const from = await lineage(tab, source, signal)
  const to = await lineage(tab, destination, signal)
  if (action === 'move' && to.includes(source.id))
    throw new Error('A page cannot be moved under itself or its descendants.')
  if (action === 'copy') await requireBodyOnlyCopy(tab, source, signal)
  await requireRetainedAccess(tab, { id: source.id, ancestors: from.slice(0, -1) }, to, action, signal)
  return { from: from.join('/'), to: to.join('/') }
}

export async function prepareCloudOrganization(request: OrganizationRequest, tab: ConfluenceTab, signal?: AbortSignal) {
  const source = await readCloudRevision(tab, request.page, signal)
  const parent = await readCloudLocation(tab, request.parent, signal)
  const original = await checkOrganization(tab, request.action, source, parent, signal)
  const from = cloudPageLink(tab, source)
  const to = cloudPageLink(tab, parent)
  return {
    preview:
      request.action === 'move'
        ? `Move "${from.title}" (${from.url}) and its children under "${to.title}" (${to.url}).`
        : `Copy the body of "${from.title}" (${from.url}) under "${to.title}" (${to.url}) as "${request.title}". The copy is one page with its own history, comments and properties.`,
    async apply(signal?: AbortSignal) {
      const current = await readCloudRevision(tab, from.ref, signal)
      const destination = await readCloudLocation(tab, to.ref, signal)
      if (!samePage(source, current) || !sameRevision(source, current) || !samePage(parent, destination))
        refuse('The source or destination changed after the preview. Review both pages and ask again.')
      const latest = await checkOrganization(tab, request.action, current, destination, signal)
      if (latest.from !== original.from || latest.to !== original.to)
        refuse('The page hierarchy changed after the preview. Review both pages and ask again.')

      if (request.action === 'copy') {
        if (await findCloudTitle(tab, request.title, destination.spaceId, signal))
          throw new Error('A page with that title already exists in the space. Choose a different title.')
        const receipt = await createCloudChildPage(
          tab,
          {
            spaceId: destination.spaceId,
            parentId: destination.id,
            title: request.title,
            text: current.body.storage.value,
          },
          signal,
        )
        const created = cloudLocatedPage.safeParse(receipt.data)
        if (
          !created.success ||
          created.data.id === source.id ||
          created.data.id === parent.id ||
          created.data.title !== request.title ||
          created.data.parentId !== parent.id ||
          created.data.spaceId !== parent.spaceId
        )
          unverifiedWrite()
        const saved = await readCloudRevision(tab, cloudReference(tab, created.data.id), signal).catch(unverifiedWrite)
        if (
          !samePage(saved, created.data) ||
          saved.parentId !== parent.id ||
          saved.version.number !== 1 ||
          saved.body.storage.value !== current.body.storage.value
        )
          unverifiedWrite()
        return { page: cloudPageLink(tab, saved), parent: to, version: 1, changed: true }
      }

      if (current.parentId === destination.id) return { page: from, parent: to, changed: false }
      const receipt = await moveCloudPage(tab, source.id, destination.id, signal)
      const moved = moveReceipt.safeParse(receipt.data)
      if (receipt.status !== 200 || !moved.success || moved.data.pageId !== source.id) unverifiedWrite()
      const saved = await readCloudRevision(tab, from.ref, signal).catch(unverifiedWrite)
      if (!samePage(saved, source) || !sameRevision(saved, source) || saved.parentId !== destination.id)
        unverifiedWrite()
      return { page: cloudPageLink(tab, saved), parent: to, version: saved.version.number, changed: true }
    },
  }
}

async function requireEligibleTrash(tab: ConfluenceTab, page: Revision, signal?: AbortSignal) {
  if (!page.parentId) throw new Error('Confluco does not trash top-level pages. The user can do it in Confluence.')
  const ancestors = await lineage(tab, page, signal)
  const children = await cloudCollection(tab, `pages/${page.id}/direct-children`, {}, undefined, z.unknown(), {
    limit: 1,
    signal,
  })
  if (children.items.length || children.cursor || children.paginationNotice)
    throw new Error(
      'This page has child items, or they could not be checked, which Confluence would move to the space root. The user can trash it in Confluence.',
    )
  await requireRetainedAccess(tab, { id: page.id, ancestors: ancestors.slice(0, -1) }, [], 'trash', signal)
  return ancestors.join('/')
}

export async function prepareCloudTrash(tab: ConfluenceTab, ref: PageReference | undefined, signal?: AbortSignal) {
  const page = await readCloudRevision(tab, ref, signal)
  const hierarchy = await requireEligibleTrash(tab, page, signal)
  const link = cloudPageLink(tab, page)
  return {
    preview: `Move "${link.title}" (${link.url}) to the recoverable trash. A space admin can restore it from Confluence Space settings. Confluence restores pages at the space root and may move child items that your account cannot see.`,
    async apply(signal?: AbortSignal) {
      const current = await readCloudRevision(tab, link.ref, signal)
      if (
        !samePage(current, page) ||
        !sameRevision(current, page) ||
        (await requireEligibleTrash(tab, current, signal)) !== hierarchy
      )
        refuse('The page or its hierarchy changed after the preview. Review the current state and ask again.')
      const result = await trashCloudPage(tab, page.id, signal)
      const unverified = (cause?: unknown) =>
        verificationFailed('The page may have moved to the trash. Check the space trash before asking again.', cause)
      if (result.status !== 204) unverified()
      const saved = await fetchCloudPage(tab, link.ref, trashState, { status: 'trashed' }, signal).catch(unverified)
      if (saved.title !== page.title || saved.spaceId !== page.spaceId || saved.version.number !== page.version.number)
        unverified()
      return { page: link, status: saved.status, version: saved.version.number, changed: true }
    },
  }
}
