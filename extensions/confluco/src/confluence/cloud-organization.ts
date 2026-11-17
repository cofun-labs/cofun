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
import { hasRestriction, restrictions } from './history'
import type { OrganizationRequest } from './page-organization'
import { requestedReference, unverifiedWrite } from './page-writes'
import { pageReference } from './references'
import {
  createCloudChildPage,
  getConfluence,
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

async function requireRetainedAccess(tab: ConfluenceTab, source: string, omitted: string[], signal?: AbortSignal) {
  for (const id of omitted) {
    const reply = await getConfluence(tab, `content/${id}/restriction/byOperation`, {}, signal)
    const parsed = restrictions.safeParse(reply.data)
    if (!parsed.success)
      refuse('Confluence did not report the page restrictions. Check access in Confluence before asking again.')
    if (hasRestriction(parsed.data.read) || (id === source && hasRestriction(parsed.data.update)))
      refuse('This change could drop an existing access restriction. Review the destination or access in Confluence.')
  }
}

async function requireBodyOnlyCopy(tab: ConfluenceTab, page: Revision, signal?: AbortSignal) {
  if (/<(?:ri:attachment|ac:inline-comment-marker)(?:\s|\/?>)/i.test(page.body.storage.value))
    refuse('This page uses attachment or inline comment references. Use Confluence to copy those with the page.')
  const attachments = await cloudCollection(tab, `pages/${page.id}/attachments`, {}, undefined, z.unknown(), {
    limit: 1,
    signal,
  })
  if (attachments.items.length || attachments.cursor || attachments.paginationNotice)
    refuse('The page has attachments or could not be checked. Review it in Confluence before copying.')
}

async function checkOrganization(
  tab: ConfluenceTab,
  action: OrganizationRequest['action'],
  source: Revision,
  destination: Location,
  signal?: AbortSignal,
) {
  if (source.spaceId !== destination.spaceId) refuse('Choose a destination in the same Confluence space.')
  if (action === 'move' && !source.parentId)
    refuse('Move a page with an existing parent. Use Confluence for top-level pages.')
  const from = await lineage(tab, source, signal)
  const to = await lineage(tab, destination, signal)
  if (action === 'move' && to.includes(source.id)) refuse('A page cannot be moved under itself or its descendants.')
  if (action === 'copy') await requireBodyOnlyCopy(tab, source, signal)
  const omitted = from.filter((id) => id !== source.id && !to.includes(id))
  // A copy has its own permissions, including when it is created beneath the original.
  if (action === 'copy') omitted.push(source.id)
  await requireRetainedAccess(tab, source.id, omitted, signal)
  return { from: from.join('/'), to: to.join('/') }
}

export async function prepareCloudOrganization(request: OrganizationRequest, tab: ConfluenceTab, signal?: AbortSignal) {
  const ref = requestedReference(tab, request.sourceUrl)
  const parentRef = requestedReference(tab, request.destinationUrl)
  const source = await readCloudRevision(tab, ref, signal)
  const parent = await readCloudLocation(tab, parentRef, signal)
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
          refuse('A page with that title already exists in the destination space. Choose a different title.')
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
  if (!page.parentId) refuse('Use Confluence to manage top-level pages in the trash.')
  const ancestors = await lineage(tab, page, signal)
  const children = await cloudCollection(tab, `pages/${page.id}/direct-children`, {}, undefined, z.unknown(), {
    limit: 1,
    signal,
  })
  if (children.items.length || children.cursor || children.paginationNotice)
    refuse('Confluco could not confirm that this page has no children. Review its hierarchy before trashing it.')
  await requireRetainedAccess(tab, page.id, ancestors, signal)
  return ancestors.join('/')
}

export async function prepareCloudTrash(tab: ConfluenceTab, targetUrl: string | undefined, signal?: AbortSignal) {
  const page = await readCloudRevision(tab, requestedReference(tab, targetUrl), signal)
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
