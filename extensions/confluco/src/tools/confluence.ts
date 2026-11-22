import { normalizeSearchText, readPage, searchPages, SearchArgs } from '../confluence/api'
import { attachmentsArgs, listCloudAttachments, listPageAttachments } from '../confluence/attachments'
import {
  browseCloudTree,
  cloudPageAccess,
  getCloudSpace,
  listCloudComments,
  listCloudLabels,
  listCloudSpaces,
  listCloudVersions,
  readCloudVersion,
  type CloudDiscussionPosition,
} from '../confluence/cloud-inspection'
import { collectionNext } from '../confluence/collection'
import { commentsArgs, listPageComments } from '../confluence/comments'
import { accessArgs, listVersions, pageAccess, readPageVersion, versionArgs, versionsArgs } from '../confluence/history'
import { labelsArgs, listLabels } from '../confluence/labels'
import { browseTree, getSpace, listSpaces, listSpacesArgs, spaceArgs, treeArgs } from '../confluence/navigation'
import { folderReference, type PageReference } from '../confluence/references'
import type { ConfluenceTab } from '../confluence/tab'
import type { ToolContext } from '@cofun/agent'
import { defineTool } from '../tool'
import { target } from './target'
import { z } from '../zod'
import type { ConfluenceContinuation, ToolMemory } from './memory'
import { asData, clip, quote, withText } from '@cofun/tools'
import { on, READ, SEARCH } from './shared'
import { folderKey, page, remember, requireTarget, resolvePage } from './pages'

/** Remember a tree's pages and folders apart, so a folder's ID is never used as a page's. */
function rememberTree(memory: ToolMemory, entries: readonly { ref: PageReference; kind?: 'folder' }[]) {
  for (const entry of entries)
    if (entry.kind === 'folder') memory.confluenceResources.add(folderKey(entry.ref))
    else remember(memory, [entry])
}

function result(data: object) {
  return asData([JSON.stringify(data)])
}

function requestKey(tab: ConfluenceTab, tool: string, filters?: object) {
  return JSON.stringify([tab.instance.origin, tab.instance.path, tab.url, tool, filters])
}

type ContinuationResult = {
  nextStart?: number
  cursor?: string
  commentsNext?: CloudDiscussionPosition
  continuation?: ConfluenceContinuation
}

/** Keep the site's continuation behind a question-scoped value for the same request. */
async function paginate<T extends ContinuationResult>(
  memory: ToolMemory,
  key: string,
  nextPage: string | undefined,
  run: (position?: ConfluenceContinuation) => Promise<T>,
) {
  const pages = memory.nextConfluencePages
  const saved = pages.get(key)
  if (nextPage && nextPage !== saved?.id)
    throw new Error('Use nextPage returned by the same Confluence request in this question, or omit it.')
  const { nextStart, cursor, commentsNext, continuation, ...value } = await run(
    nextPage ? saved?.continuation : undefined,
  )
  const next =
    continuation ??
    (cursor ? { cursor } : undefined) ??
    (nextStart !== undefined ? { offset: nextStart } : undefined) ??
    (commentsNext ? { comments: commentsNext } : undefined)
  const id = next && crypto.randomUUID()
  if (id && next) pages.set(key, { id, continuation: next })
  else pages.delete(key)
  return { ...value, nextPage: id }
}

const offset = (position?: ConfluenceContinuation) => (position && 'offset' in position ? position.offset : 0)
const cursor = (position?: ConfluenceContinuation) => (position && 'cursor' in position ? position.cursor : undefined)

export const readConfluencePage = defineTool({
  name: 'read_page',
  args: z.strictObject({}),
  description: 'Reads the published Confluence page open in the current tab. Returns its text, title and source link.',
  describe: (_args, details) => on(READ, details?.name, 'the current Confluence page'),
  run: async (_args, signal, context) => {
    const page = await readPage(await target(context), signal)
    remember(context.memory, [page])
    return withText(
      [`Published Confluence page: ${quote({ title: page.title, url: page.url })}`],
      { ...page, tool: 'read_page', markdown: false, chars: page.text.length },
      clip(page.title, 120),
      context,
    )
  },
})

export const searchConfluencePages = defineTool({
  name: 'search_pages',
  args: SearchArgs,
  description:
    'Finds published Confluence pages by title or text on the Confluence site in the current tab. ' +
    'Use nextPage only for the next page returned by this same search during this question. Returns excerpts and source links.',
  describe: (args) => on(SEARCH, args && clip(args.query, 120), 'Confluence pages'),
  run: async (args, signal, { memory, ask }) => {
    const query = normalizeSearchText(args.query)
    const tab = await target({ memory, ask })
    const key = requestKey(tab, 'search_pages', { query, field: args.field, spaceKey: args.spaceKey })
    const hits = await paginate(memory, key, args.nextPage, (position) =>
      searchPages(tab, args, position && 'comments' in position ? undefined : position, signal),
    )
    remember(memory, hits.results)
    return { text: result(hits), details: { name: clip(args.query, 120) } }
  },
})

export const listConfluenceSpaces = defineTool({
  name: 'list_spaces',
  args: listSpacesArgs.omit({ start: true }).extend({ nextPage: collectionNext }),
  description: 'List spaces visible to the user on the Confluence site in the current tab.',
  describe: () => on(READ, undefined, 'Confluence spaces'),
  run: async ({ nextPage }, signal, { memory, ask }) => {
    const tab = await target({ memory, ask })
    const listed = await paginate(memory, requestKey(tab, 'list_spaces'), nextPage, (position) =>
      tab.instance.cloud ? listCloudSpaces(tab, cursor(position), signal) : listSpaces(offset(position), tab, signal),
    )
    return result(listed)
  },
})

export const getConfluenceSpace = defineTool({
  name: 'get_space',
  args: spaceArgs,
  description: 'Read a space and its homepage, by its key.',
  describe: (args) => on(READ, args?.key, 'a Confluence space'),
  run: async ({ key }, signal, { memory, ask }) => {
    const tab = await target({ memory, ask })
    const space = tab.instance.cloud ? await getCloudSpace(tab, key, signal) : await getSpace(key, tab, signal)
    if (space.homepage) remember(memory, [space.homepage])
    return result(space)
  },
})

export const browseConfluenceTree = defineTool({
  name: 'browse_page_tree',
  args: treeArgs.omit({ start: true }).extend({
    page,
    folder: folderReference
      .optional()
      .describe('A folder reference from browse_page_tree on Confluence Cloud. Use instead of page to browse it.'),
    nextPage: collectionNext,
  }),
  description:
    'Read ancestors and direct children of the current page, a page reference returned by a Confluence tool, ' +
    'a link to a page on this site, or a Confluence Cloud folder from this tool. Entries with kind "folder" are ' +
    'folders: pass their ref as folder.',
  describe: () => on(READ, undefined, 'the Confluence page tree'),
  run: async (args, signal, { memory, ask }) => {
    if (args.page && args.folder) throw new Error('Pass page or folder, not both.')
    requireTarget(memory, args.page)
    if (args.folder && !memory.confluenceResources.has(folderKey(args.folder)))
      throw new Error('Use a folder reference returned by browse_page_tree during this question.')
    const tab = await target({ memory, ask })
    if (args.folder && !tab.instance.cloud) throw new Error('Folders are only on Confluence Cloud.')
    const at = resolvePage(memory, tab, args.page)
    const key = requestKey(tab, 'browse_page_tree', { page: at, folder: args.folder })
    const tree = await paginate(memory, key, args.nextPage, async (position) => {
      if (!tab.instance.cloud) {
        const tree = await browseTree({ page: at, start: offset(position) }, tab, signal)
        remember(memory, [tree.page, ...tree.ancestors, ...tree.children])
        return tree
      }
      const where = args.folder ? { folder: args.folder } : { page: at }
      const tree = await browseCloudTree(tab, where, cursor(position), signal)
      rememberTree(memory, ['folder' in tree ? tree.folder : tree.page, ...tree.ancestors, ...tree.children])
      return tree
    })
    return result(tree)
  },
})

/** The tab and the page a read names: a reference no tool returned is refused before anything is read. */
async function pageOn(context: Pick<ToolContext<ToolMemory>, 'memory' | 'ask'>, at: z.output<typeof page>) {
  requireTarget(context.memory, at)
  const tab = await target(context)
  return { tab, page: resolvePage(context.memory, tab, at) }
}

const onPage = 'the current page, a page reference returned by a Confluence tool, or a link to a page on this site'

export const listConfluenceVersions = defineTool({
  name: 'list_page_versions',
  args: versionsArgs.omit({ start: true }).extend({ page, nextPage: collectionNext }),
  description: `List published versions of ${onPage}.`,
  describe: () => on(READ, undefined, 'Confluence page versions'),
  run: async (args, signal, context) => {
    const { tab, page } = await pageOn(context, args.page)
    const key = requestKey(tab, 'list_page_versions', page)
    const listed = await paginate(context.memory, key, args.nextPage, async (position) =>
      tab.instance.cloud
        ? listCloudVersions(tab, page, cursor(position), signal)
        : listVersions({ page, start: offset(position) }, tab, signal),
    )
    remember(context.memory, [listed])
    return result(listed)
  },
})

export const readConfluenceVersion = defineTool({
  name: 'read_page_version',
  args: versionArgs.extend({ page }),
  description: `Read one published version of ${onPage}.`,
  describe: (args) => on(READ, args && String(args.version), 'a Confluence page version'),
  run: async (args, signal, context) => {
    const { tab, page } = await pageOn(context, args.page)
    const version = tab.instance.cloud
      ? await readCloudVersion(tab, page, args.version, signal)
      : await readPageVersion({ ...args, page }, tab, signal)
    remember(context.memory, [version])
    return result(version)
  },
})

export const getConfluencePageAccess = defineTool({
  name: 'get_page_access',
  args: accessArgs.extend({ page }),
  description: `Read the reported operations and restrictions on ${onPage}.`,
  describe: () => on(READ, undefined, 'Confluence page access'),
  run: async (args, signal, context) => {
    const { tab, page } = await pageOn(context, args.page)
    const access = tab.instance.cloud ? await cloudPageAccess(tab, page, signal) : await pageAccess(page, tab, signal)
    remember(context.memory, [access])
    return result(access)
  },
})

export const listConfluenceLabels = defineTool({
  name: 'list_page_labels',
  args: labelsArgs.omit({ start: true }).extend({ page, nextPage: collectionNext }),
  description: `List page labels for ${onPage}.`,
  describe: () => on(READ, undefined, 'Confluence page labels'),
  run: async (args, signal, context) => {
    const { tab, page } = await pageOn(context, args.page)
    const key = requestKey(tab, 'list_page_labels', page)
    const listed = await paginate(context.memory, key, args.nextPage, async (position) =>
      tab.instance.cloud
        ? listCloudLabels(tab, page, cursor(position), signal)
        : listLabels({ page, start: offset(position) }, tab, signal),
    )
    remember(context.memory, [listed.page])
    return result(listed)
  },
})

export const listConfluenceComments = defineTool({
  name: 'list_page_comments',
  args: commentsArgs.omit({ start: true }).extend({ page, nextPage: collectionNext }),
  description: `Read comments and replies on ${onPage}. Use nextPage to see more of the discussion.`,
  describe: () => on(READ, undefined, 'Confluence page comments'),
  run: async (args, signal, context) => {
    const { tab, page } = await pageOn(context, args.page)
    const key = requestKey(tab, 'list_page_comments', page)
    const listed = await paginate(context.memory, key, args.nextPage, async (position) =>
      tab.instance.cloud
        ? listCloudComments(tab, page, position && 'comments' in position ? position.comments : undefined, signal)
        : listPageComments({ page, start: offset(position) }, tab, signal),
    )
    remember(context.memory, [listed.page])
    return result(listed)
  },
})

export const listConfluenceAttachments = defineTool({
  name: 'list_page_attachments',
  args: attachmentsArgs.omit({ start: true }).extend({ page, nextPage: collectionNext }),
  description: `List attachments and download links for ${onPage}.`,
  describe: () => on(READ, undefined, 'Confluence page attachments'),
  run: async (args, signal, context) => {
    const { tab, page } = await pageOn(context, args.page)
    const key = requestKey(tab, 'list_page_attachments', { page, filename: args.filename })
    const listed = await paginate(context.memory, key, args.nextPage, async (position) =>
      tab.instance.cloud
        ? listCloudAttachments(tab, page, args.filename, cursor(position), signal)
        : listPageAttachments({ page, filename: args.filename, start: offset(position) }, tab, signal),
    )
    remember(context.memory, [listed.page])
    return result(listed)
  },
})
