import { z } from '../zod'
import { requireRetainedAccess } from './history'
import {
  findTitleInSpace,
  readWrittenPage,
  samePageLocation,
  storedFields,
  storedPage,
  unverifiedWrite,
} from './page-writes'
import { fetchPublishedPage, pageLink, publishedPage, type PageReference } from './references'
import {
  createConfluenceContent,
  getConfluence,
  refuse,
  requireTab,
  updateConfluencePage,
  type ConfluenceTab,
} from './tab'

type Source = z.output<typeof storedPage>
const parentPage = storedPage.pick({ id: true, type: true, status: true, title: true, space: true, ancestors: true })
type Parent = z.output<typeof parentPage>
type OrganizationTarget = { page?: PageReference; parent: PageReference }
export type OrganizationRequest = OrganizationTarget & ({ action: 'move' } | { action: 'copy'; title: string })

function lineage(parent: Parent) {
  return [...parent.ancestors, { id: parent.id }]
}

function requireCompatibleAccess(
  tab: ConfluenceTab,
  source: Source,
  parent: Parent,
  request: OrganizationRequest,
  signal?: AbortSignal,
) {
  return requireRetainedAccess(
    tab,
    { id: source.id, ancestors: source.ancestors.map(({ id }) => id) },
    lineage(parent).map(({ id }) => id),
    request.action,
    signal,
  )
}

export function requireCopyableStorage(body: string) {
  if (/<(?:ri:attachment|ac:inline-comment-marker)(?:\s|\/?>)/i.test(body))
    throw new Error('This page uses attachment or inline comment references. The user can copy it in Confluence.')
}

async function requireBodyOnlyCopy(tab: ConfluenceTab, source: Source, signal?: AbortSignal) {
  requireCopyableStorage(source.body.storage.value)
  const response = await getConfluence(tab, `content/${source.id}/child/attachment`, { limit: '1' }, signal)
  const parsed = z.object({ results: z.array(z.unknown()) }).safeParse(response.data)
  if (!parsed.success) refuse('Confluence did not report whether the page has attachments.')
  if (parsed.data.results.length)
    throw new Error('This page has attachments. The user can copy it with its attachments in Confluence.')
}

export async function prepareOrganization(
  request: OrganizationRequest,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const sourceRef = request.page
  const parentRef = request.parent
  const source = await fetchPublishedPage(tab, sourceRef, storedPage, storedFields, signal)
  const parent = await fetchPublishedPage(tab, parentRef, parentPage, 'space,ancestors', signal)
  if (source.space.key !== parent.space.key) throw new Error('Choose a parent in the same Confluence space.')
  if (request.action === 'move') {
    if (!source.ancestors.length)
      throw new Error('Confluco does not move top-level pages. The user can move it in Confluence.')
    if (lineage(parent).some(({ id }) => id === source.id))
      throw new Error('A page cannot be moved under itself or its descendants.')
  } else await requireBodyOnlyCopy(tab, source, signal)
  await requireCompatibleAccess(tab, source, parent, request, signal)
  const from = pageLink(tab.instance, source)
  const to = pageLink(tab.instance, parent)
  const preview =
    request.action === 'move'
      ? `Move "${from.title}" (${from.url}) and its children under "${to.title}" (${to.url}) in space ${source.space.key}.`
      : `Copy the body of "${from.title}" (${from.url}) under "${to.title}" (${to.url}) as "${request.title}". The copy is one page with its own history, comments and properties.`
  return { tab, request, sourceRef, parentRef, source, parent, preview }
}

export async function applyOrganization(plan: Awaited<ReturnType<typeof prepareOrganization>>, signal?: AbortSignal) {
  const { tab, request, sourceRef, parentRef, source, parent } = plan
  const current = await fetchPublishedPage(tab, sourceRef, storedPage, storedFields, signal)
  const destination = await fetchPublishedPage(tab, parentRef, parentPage, 'space,ancestors', signal)
  if (
    !samePageLocation(current, source) ||
    !samePageLocation(destination, parent) ||
    current.version.number !== source.version.number ||
    current.body.storage.value !== source.body.storage.value
  )
    refuse('The source or destination changed after the preview. Review both pages and ask again.')
  const parentLink = pageLink(tab.instance, destination)
  const expected = { ...source, ancestors: lineage(destination) }
  const ancestors = [{ id: destination.id }]
  await requireCompatibleAccess(tab, current, destination, request, signal)

  if (request.action === 'copy') {
    await requireBodyOnlyCopy(tab, current, signal)
    const existing = await findTitleInSpace(tab, request.title, destination.space.key, signal)
    if (existing) throw new Error('A page with that title already exists in the space. Choose a different title.')
    const response = await createConfluenceContent(
      tab,
      { type: 'page', title: request.title, space: destination.space, ancestors, body: source.body },
      signal,
    )
    const created = publishedPage.safeParse(response.data)
    if (!created.success || created.data.id === source.id) unverifiedWrite()
    const verified = await readWrittenPage(tab, created.data.id, signal)
    if (
      !samePageLocation(verified, { ...expected, id: created.data.id, title: request.title }) ||
      verified.version.number !== 1 ||
      verified.body.storage.value !== source.body.storage.value
    )
      unverifiedWrite()
    return { page: pageLink(tab.instance, verified), parent: parentLink, version: 1, changed: true }
  }

  if (source.ancestors.at(-1)?.id === parent.id)
    return { page: pageLink(tab.instance, source), parent: parentLink, changed: false }
  if (source.version.number === 2_147_483_647) refuse('This Confluence page cannot be advanced to another version.')
  const version = source.version.number + 1
  await updateConfluencePage(
    tab,
    source.id,
    {
      type: 'page',
      title: source.title,
      space: source.space,
      version: { number: version },
      ancestors,
      body: source.body,
    },
    signal,
  )
  const verified = await readWrittenPage(tab, source.id, signal)
  if (
    !samePageLocation(verified, expected) ||
    verified.version.number !== version ||
    verified.body.storage.value !== source.body.storage.value
  )
    unverifiedWrite()
  return { page: pageLink(tab.instance, verified), parent: parentLink, version, changed: true }
}
