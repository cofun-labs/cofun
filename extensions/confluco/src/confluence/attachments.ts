import { z } from '../zod'
import { cloudCollection, cloudPage, cloudPageLink, fetchCloudPage } from './cloud'
import { collection, collectionStart } from './collection'
import { parseInstance, type Instance } from './instance'
import { fetchPublishedPage, pageLink, pageReference, publishedPage, type PageReference } from './references'
import { refuse, requireTab, type ConfluenceTab } from './tab'

const filename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => value !== '.' && value !== '..' && !/[/\\\p{Cc}]/u.test(value),
    'Use a filename without path separators or control characters.',
  )
const versionNumber = z.int().min(1).max(2_147_483_647)
const attachmentId = z.string().regex(/^(?:att)?\d{1,20}$/)
const attachment = z.object({
  id: attachmentId,
  type: z.literal('attachment'),
  status: z.literal('current'),
  title: filename,
  container: z.object({ id: pageReference.shape.id, type: z.literal('page') }),
  version: z.object({ number: versionNumber }),
  extensions: z.object({ fileSize: z.int().nonnegative().optional() }).optional(),
  _links: z.object({ download: z.string().min(1).max(4096).optional() }).optional(),
})
type Attachment = z.output<typeof attachment>
const cloudAttachment = z.object({
  id: attachmentId,
  title: z.string().min(1).max(255),
  pageId: pageReference.shape.id,
  version: z.object({ number: versionNumber }),
  fileSize: z.int().nonnegative().optional(),
  downloadLink: z.string().max(4096).optional(),
  _links: z.object({ download: z.string().max(4096).optional() }).optional(),
})
const fields = 'version,container'
const attachmentResource = (pageId: string) => `content/${pageId}/child/attachment`

export const attachmentsArgs = z.strictObject({
  page: pageReference.optional().describe('Omit to use the current published page.'),
  filename: filename.optional().describe('An exact filename to find. Omit to list all attachments.'),
  start: collectionStart,
})

function attachmentDownloadUrl(
  instance: Instance,
  pageId: string,
  name: string,
  version: number,
  link?: string,
  id?: string,
) {
  if (!link) return
  try {
    const base = instance.origin + instance.path
    const url = new URL(link, base + '/')
    if (url.origin !== instance.origin || url.username || url.password || url.hash) return
    if (instance.cloud && id) {
      // Cloud's v2 metadata can point to its v1 download action. Bind the link to the attachment and version.
      const endpoint = `/rest/api/content/${pageId}/child/attachment/${id}/download`
      if (url.pathname === endpoint || url.pathname === instance.path + endpoint)
        return `${base}${endpoint}?version=${version}`
    }
    const suffix = `/download/attachments/${pageId}/`
    const prefix = url.pathname.startsWith(instance.path + suffix) ? instance.path + suffix : suffix
    if (!url.pathname.startsWith(prefix)) return
    const segment = url.pathname.slice(prefix.length)
    if (decodeURIComponent(segment) !== name && decodeURIComponent(segment.replace(/\+/g, ' ')) !== name) return
    return `${base}${suffix}${encodeURIComponent(name)}?version=${version}&download=true`
  } catch {
    return undefined
  }
}

function summary(instance: Instance, pageId: string, value: Attachment) {
  return {
    id: value.id,
    filename: value.title,
    version: value.version.number,
    bytes: value.extensions?.fileSize,
    downloadUrl: attachmentDownloadUrl(instance, pageId, value.title, value.version.number, value._links?.download),
  }
}

const listedDownloads = z.object({
  page: z.object({ ref: pageReference }),
  attachments: z
    .array(
      z.object({
        id: attachmentId.optional(),
        filename,
        version: versionNumber,
        downloadUrl: z.string().max(4096).optional(),
      }),
    )
    .max(50),
})

export function attachmentDownloads(result: string) {
  try {
    const data: unknown = JSON.parse(result)
    const parsed = listedDownloads.safeParse(data)
    if (!parsed.success) return []
    const { instance: base, id } = parsed.data.page.ref
    const instance = parseInstance(base)
    if (!instance) return []
    return parsed.data.attachments.flatMap(({ id: attachment, filename, version, downloadUrl: link }) => {
      const url = attachmentDownloadUrl(instance, id, filename, version, link, attachment)
      return url ? [{ name: filename, url }] : []
    })
  } catch {
    return []
  }
}

export async function listPageAttachments(
  args: z.output<typeof attachmentsArgs>,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const page = await fetchPublishedPage(tab, args.page, publishedPage, 'version', signal)
  const { items, ...next } = await collection(
    tab,
    attachmentResource(page.id),
    { expand: fields, ...(args.filename && { filename: args.filename }) },
    args.start,
    attachment,
    { signal },
  )
  if (items.some((item) => item.container.id !== page.id || (args.filename && item.title !== args.filename)))
    refuse('Confluence returned attachments outside the requested page or filename.')
  return {
    page: pageLink(tab.instance, page),
    attachments: items.map((item) => summary(tab.instance, page.id, item)),
    ...next,
  }
}

function cloudPublishedPage(tab: ConfluenceTab, reference: PageReference | undefined, signal?: AbortSignal) {
  return fetchCloudPage(tab, reference, cloudPage, { status: 'current' }, signal)
}

async function cloudAttachments(
  tab: ConfluenceTab,
  pageId: string,
  name: string | undefined,
  cursor: string | undefined,
  { signal, limit }: { signal?: AbortSignal; limit?: number },
) {
  const { items, ...next } = await cloudCollection(
    tab,
    `pages/${pageId}/attachments`,
    name === undefined ? {} : { filename: name },
    cursor,
    cloudAttachment,
    { signal, limit },
  )
  if (items.some((item) => item.pageId !== pageId || (name !== undefined && item.title !== name)))
    refuse('Confluence returned attachments outside the requested page or filename.')
  return {
    attachments: items.map((item) => ({
      id: item.id,
      filename: item.title,
      version: item.version.number,
      bytes: item.fileSize,
      downloadUrl: attachmentDownloadUrl(
        tab.instance,
        pageId,
        item.title,
        item.version.number,
        item._links?.download ?? item.downloadLink,
        item.id,
      ),
    })),
    ...next,
  }
}

export async function listCloudAttachments(
  tab: ConfluenceTab,
  ref: PageReference | undefined,
  name: string | undefined,
  cursor?: string,
  signal?: AbortSignal,
) {
  const page = await cloudPublishedPage(tab, ref, signal)
  return { page: cloudPageLink(tab, page), ...(await cloudAttachments(tab, page.id, name, cursor, { signal })) }
}
