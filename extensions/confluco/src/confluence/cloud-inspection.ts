// Cloud space and page inspection. All requests use the captured site tab and the existing session.
import { z } from '../zod'
import { attachmentDownloadUrl } from './attachments'
import { cloudCollection, cloudPage, cloudPageLink, fetchCloudPage } from './cloud'
import { hasRestriction, restrictions } from './history'
import { spaceKey } from './navigation'
import { readableText } from './readable-text'
import { pageReference, type PageReference } from './references'
import { ConfluenceRequestError, getConfluence, refuse, type ConfluenceTab } from './tab'

const id = pageReference.shape.id
const siteSpace = z.object({ id, key: spaceKey, name: z.string().trim().min(1).max(1000), homepageId: id.nullish() })
const item = z.object({ id, type: z.string().min(1).max(60) })
const version = z.object({
  number: z.int().min(1),
  message: z.string().optional(),
  minorEdit: z.boolean().optional(),
  createdAt: z.string().max(80).optional(),
})
const versionedPage = cloudPage.extend({ version })
const historicalPage = versionedPage.extend({
  status: z.enum(['current', 'historical']),
  body: z.object({ view: z.object({ value: z.string() }) }),
})
const operation = z.object({ operation: z.string().min(1).max(80), targetType: z.string().max(80).optional() })
const operations = z.object({ operations: z.array(operation).max(100) })
const label = z.object({ prefix: z.string().max(40), name: z.string().min(1).max(255) })
const attachment = z.object({
  id: z.string().regex(/^(?:att)?\d{1,20}$/),
  title: z.string().min(1).max(255),
  pageId: id,
  version: z.object({ number: z.int().min(1).max(2_147_483_647) }),
  fileSize: z.int().nonnegative().optional(),
  downloadLink: z.string().max(4096).optional(),
})

function pageRef(tab: ConfluenceTab, id: string): PageReference {
  return { instance: tab.instance.origin + tab.instance.path, id }
}

function spaceLink(tab: ConfluenceTab, space: z.output<typeof siteSpace>) {
  return {
    key: space.key,
    name: space.name,
    url: `${tab.instance.origin}/wiki/spaces/${encodeURIComponent(space.key)}/overview`,
  }
}

function published(tab: ConfluenceTab, page: PageReference | undefined, signal?: AbortSignal) {
  return fetchCloudPage(tab, page, cloudPage, { status: 'current' }, signal)
}

export async function listCloudSpaces(tab: ConfluenceTab, cursor?: string, signal?: AbortSignal) {
  const { items, ...next } = await cloudCollection(tab, 'spaces', { status: 'current' }, cursor, siteSpace, { signal })
  return { spaces: items.map((space) => spaceLink(tab, space)), ...next }
}

export async function getCloudSpace(tab: ConfluenceTab, key: string, signal?: AbortSignal) {
  const { items } = await cloudCollection(tab, 'spaces', { keys: key, status: 'current' }, undefined, siteSpace, {
    signal,
    limit: 2,
  })
  const [space, duplicate] = items
  if (!space || duplicate || space.key !== key) refuse('Confluence did not return the requested space.')
  const homepage = space.homepageId ? await published(tab, pageRef(tab, space.homepageId), signal) : undefined
  return { ...spaceLink(tab, space), homepage: homepage ? cloudPageLink(tab, homepage) : null }
}

async function describePages(tab: ConfluenceTab, items: z.output<typeof item>[], signal?: AbortSignal) {
  const ids = [...new Set(items.filter((item) => item.type === 'page').map((item) => item.id))]
  if (!ids.length) return []
  const reply = await getConfluence(
    tab,
    'pages',
    { id: ids, status: 'current', limit: String(ids.length) },
    signal,
    'cloud-v2',
  )
  const parsed = z.object({ results: z.array(cloudPage).max(ids.length) }).safeParse(reply.data)
  if (
    !parsed.success ||
    parsed.data.results.some((page) => !ids.includes(page.id)) ||
    new Set(parsed.data.results.map((page) => page.id)).size !== parsed.data.results.length
  ) {
    refuse('Confluence did not return the expected pages.')
  }
  const pages = new Map(parsed.data.results.map((page) => [page.id, cloudPageLink(tab, page)]))
  return ids.flatMap((id) => {
    const page = pages.get(id)
    return page ? [page] : []
  })
}

export async function browseCloudTree(
  tab: ConfluenceTab,
  ref: PageReference | undefined,
  cursor?: string,
  signal?: AbortSignal,
) {
  const page = await published(tab, ref, signal)
  const resource = 'pages/' + page.id
  const parents = await cloudCollection(tab, resource + '/ancestors', {}, undefined, item, { limit: 30, signal })
  const { items, ...next } = await cloudCollection(tab, resource + '/direct-children', {}, cursor, item, { signal })
  const ancestors = await describePages(tab, parents.items, signal)
  const children = await describePages(tab, items, signal)
  return {
    page: cloudPageLink(tab, page),
    ancestors,
    children,
    ancestorsTruncated: !!(parents.cursor || parents.paginationNotice),
    ...next,
  }
}

function versionDetails(value: z.output<typeof version>) {
  return {
    number: value.number,
    when: value.createdAt,
    message: value.message?.slice(0, 300),
    minorEdit: value.minorEdit,
  }
}

function historyUrl(tab: ConfluenceTab, id: string) {
  return `${tab.instance.origin}/wiki/pages/viewpreviousversions.action?pageId=${id}`
}

export async function listCloudVersions(
  tab: ConfluenceTab,
  ref: PageReference | undefined,
  cursor?: string,
  signal?: AbortSignal,
) {
  const page = await fetchCloudPage(tab, ref, versionedPage, { status: 'current' }, signal)
  const { items, ...next } = await cloudCollection(tab, `pages/${page.id}/versions`, {}, cursor, version, { signal })
  return {
    ...cloudPageLink(tab, page),
    historyUrl: historyUrl(tab, page.id),
    currentVersion: versionDetails(page.version),
    versions: items.map(versionDetails),
    ...next,
  }
}

export async function readCloudVersion(
  tab: ConfluenceTab,
  ref: PageReference | undefined,
  requested: number,
  signal?: AbortSignal,
) {
  const page = await fetchCloudPage(
    tab,
    ref,
    historicalPage,
    { version: String(requested), 'body-format': 'view' },
    signal,
  )
  if (page.version.number !== requested) refuse('Confluence did not return the requested page version.')
  const text = readableText(page.body.view.value)
  const limit = 12_000
  return {
    ...cloudPageLink(tab, page),
    historyUrl: historyUrl(tab, page.id),
    version: versionDetails(page.version),
    text: text.slice(0, limit),
    truncated: text.length > limit,
  }
}

export async function cloudPageAccess(tab: ConfluenceTab, ref: PageReference | undefined, signal?: AbortSignal) {
  const page = await published(tab, ref, signal)
  const ops = await getConfluence(tab, `pages/${page.id}/operations`, {}, signal, 'cloud-v2')
  const parsedOps = operations.safeParse(ops.data)
  if (!parsedOps.success) refuse('Confluence did not report the expected page operations.')
  const summary = { ...cloudPageLink(tab, page), operations: parsedOps.data.operations }
  try {
    const result = await getConfluence(tab, `content/${page.id}/restriction/byOperation`, {}, signal)
    const parsed = restrictions.safeParse(result.data)
    if (!parsed.success) refuse('Confluence did not return the expected page restrictions.')
    return {
      ...summary,
      restrictions: { read: hasRestriction(parsed.data.read), update: hasRestriction(parsed.data.update) },
      notice:
        'These are reported page restrictions. Confluence evaluates effective access, including inherited restrictions.',
    }
  } catch (error) {
    if (!(error instanceof ConfluenceRequestError) || !['forbidden', 'missing', 'unsupported'].includes(error.kind))
      throw error
    return { ...summary, restrictions: null, notice: 'This account or instance cannot report page restrictions.' }
  }
}

export async function listCloudLabels(
  tab: ConfluenceTab,
  ref: PageReference | undefined,
  cursor?: string,
  signal?: AbortSignal,
) {
  const page = await published(tab, ref, signal)
  const { items, ...next } = await cloudCollection(tab, `pages/${page.id}/labels`, {}, cursor, label, { signal })
  return { page: cloudPageLink(tab, page), labels: items, ...next }
}

export async function listCloudAttachments(
  tab: ConfluenceTab,
  ref: PageReference | undefined,
  filename: string | undefined,
  cursor?: string,
  signal?: AbortSignal,
) {
  const page = await published(tab, ref, signal)
  const { items, ...next } = await cloudCollection(
    tab,
    `pages/${page.id}/attachments`,
    filename ? { filename } : {},
    cursor,
    attachment,
    { signal },
  )
  if (items.some((item) => item.pageId !== page.id || (filename && item.title !== filename)))
    refuse('Confluence returned attachments outside the requested page or filename.')
  return {
    page: cloudPageLink(tab, page),
    attachments: items.map((item) => ({
      id: item.id,
      filename: item.title,
      version: item.version.number,
      bytes: item.fileSize,
      downloadUrl: attachmentDownloadUrl(tab.instance, page.id, item.title, item.version.number, item.downloadLink),
    })),
    ...next,
  }
}

const comment = z.object({
  id,
  pageId: id.nullish(),
  parentCommentId: id.nullish(),
  body: z.object({ storage: z.object({ value: z.string() }) }),
})

export interface CloudCommentJob {
  location: 'footer' | 'inline'
  cursor?: string
  parentId?: string
  depth: number
}

export async function listCloudComments(
  tab: ConfluenceTab,
  ref: PageReference | undefined,
  pending: CloudCommentJob[] | undefined,
  signal?: AbortSignal,
) {
  const page = await published(tab, ref, signal)
  const link = cloudPageLink(tab, page)
  const [job, ...remaining] =
    pending ??
    ([
      { location: 'footer', depth: 0 },
      { location: 'inline', depth: 0 },
    ] satisfies CloudCommentJob[])
  if (!job) return { page: link, comments: [] }
  const type = job.location + '-comments'
  const resource = job.parentId ? `${type}/${job.parentId}/children` : `pages/${page.id}/${type}`
  const { items, cursor, paginationNotice } = await cloudCollection(
    tab,
    resource,
    { 'body-format': 'storage' },
    job.cursor,
    comment,
    { signal },
  )
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.some(
      (item) =>
        item.id === job.parentId ||
        (item.pageId && item.pageId !== page.id) ||
        (item.parentCommentId && item.parentCommentId !== job.parentId),
    )
  )
    refuse('Confluence returned comments outside the requested page or discussion.')

  // Cloud paginates each thread separately. Keep the pending endpoints internal to the question.
  const depthLimit = 8
  const queueLimit = 100
  const children: CloudCommentJob[] =
    job.depth < depthLimit
      ? items.map((item) => ({ location: job.location, parentId: item.id, depth: job.depth + 1 }))
      : []
  const queue = [...(cursor ? [{ ...job, cursor }] : []), ...children, ...remaining]
  return {
    page: link,
    comments: items.map((item) => {
      const text = readableText(item.body.storage.value)
      const url = new URL(link.url)
      url.searchParams.set('focusedCommentId', item.id)
      url.hash = 'comment-' + item.id
      return {
        id: item.id,
        url: url.href,
        parentId: job.parentId ?? null,
        location: job.location,
        text: text.slice(0, 2000),
        truncated: text.length > 2000,
      }
    }),
    commentsNext: queue.length ? queue.slice(0, queueLimit) : undefined,
    paginationNotice:
      paginationNotice ??
      (queue.length > queueLimit || (items.length && job.depth === depthLimit)
        ? 'The comment inspection limit was reached. Open the discussion in Confluence for more.'
        : undefined),
  }
}
