// Moving a self-managed page to the recoverable trash. Confluco never restores one: the space's trash does.
import { z } from '../zod'
import { requireRetainedAccess } from './history'
import { pageLink, pageReference, pageResource, publishedPage, type PageReference } from './references'
import { getConfluence, refuse, verificationFailed, requireTab, trashConfluencePage, type ConfluenceTab } from './tab'

const version = z.int().min(1).max(2_147_483_647)
const trashDate = z.union([z.string().min(1).max(100), z.int().positive()])
const pageState = publishedPage.extend({
  status: z.enum(['current', 'trashed']),
  version: z.object({ number: version }),
  space: z.object({ key: z.string().min(1).max(255) }),
  ancestors: z.array(z.object({ id: pageReference.shape.id })),
  metadata: z.object({ trashdate: trashDate.optional().catch(undefined) }).optional(),
})
type PageState = z.output<typeof pageState>

async function readState(tab: ConfluenceTab, ref: PageReference | undefined, signal?: AbortSignal) {
  const response = await getConfluence(
    tab,
    pageResource(tab, ref),
    { status: 'any', expand: 'version,space,ancestors,metadata' },
    signal,
  )
  const parsed = pageState.safeParse(response.data)
  if (!parsed.success || parsed.data.id !== (ref?.id ?? response.pageId))
    refuse('Confluence did not return the expected published or trashed page.')
  return parsed.data
}

async function requireEligibleTrash(tab: ConfluenceTab, page: PageState, signal?: AbortSignal) {
  if (!page.ancestors.length)
    throw new Error('Confluco does not trash top-level pages. The user can do it in Confluence.')
  const response = await getConfluence(tab, `content/${page.id}/child/page`, { limit: '1' }, signal)
  const parsed = z
    .object({
      results: z.array(z.unknown()).max(1),
      _links: z.object({ next: z.string().optional() }).optional(),
    })
    .safeParse(response.data)
  if (!parsed.success) refuse('Confluence did not report whether this page has children.')
  if (parsed.data.results.length || parsed.data._links?.next)
    throw new Error(
      'This page has child pages, which Confluence would move to the space root. The user can trash it in Confluence.',
    )
  await requireRetainedAccess(tab, { id: page.id, ancestors: page.ancestors.map(({ id }) => id) }, [], 'trash', signal)
}

export async function preparePageTrash(
  page: PageReference | undefined,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const state = await readState(tab, page, signal)
  if (state.status === 'current') await requireEligibleTrash(tab, state, signal)
  const link = pageLink(tab.instance, state)
  return {
    tab,
    ref: link.ref,
    page: state,
    preview:
      `Move "${state.title}" (${link.url}) in space ${state.space.key} to the recoverable trash. ` +
      'Confluence restores pages at the space root and may move child pages that your account cannot see.',
  }
}

function samePage(left: PageState, right: PageState): boolean {
  return left.id === right.id && left.title === right.title && left.space.key === right.space.key
}

export async function applyPageTrash(plan: Awaited<ReturnType<typeof preparePageTrash>>, signal?: AbortSignal) {
  const { tab, ref, page } = plan
  const current = await readState(tab, ref, signal)
  if (
    !samePage(current, page) ||
    current.status !== page.status ||
    current.version.number !== page.version.number ||
    current.metadata?.trashdate !== page.metadata?.trashdate ||
    current.ancestors.map(({ id }) => id).join('/') !== page.ancestors.map(({ id }) => id).join('/')
  )
    refuse('The page changed after the preview. Review its current state and ask again.')
  if (current.status === 'trashed')
    return { page: pageLink(tab.instance, current), status: 'trashed', version: current.version.number, changed: false }
  await requireEligibleTrash(tab, current, signal)
  try {
    await trashConfluencePage(tab, current.id, signal)
  } catch (error) {
    if (signal?.aborted || !(error instanceof Error) || !('mayHaveChanged' in error) || error.mayHaveChanged !== true)
      throw error
  }
  const unverified = (cause?: unknown) =>
    verificationFailed('The page state may have changed. Check the page or space trash before asking again.', cause)
  const verified = await readState(tab, ref, signal).catch(unverified)
  if (
    !samePage(verified, current) ||
    verified.status !== 'trashed' ||
    verified.version.number !== current.version.number
  )
    unverified()
  return { page: pageLink(tab.instance, verified), status: 'trashed', version: verified.version.number, changed: true }
}
