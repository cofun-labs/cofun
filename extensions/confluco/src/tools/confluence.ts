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
import { getInstance } from '../confluence/instance'
import { labelsArgs, listLabels } from '../confluence/labels'
import { browseTree, getSpace, listSpaces, listSpacesArgs, spaceArgs, treeArgs } from '../confluence/navigation'
import { pageReference, type PageReference } from '../confluence/references'
import { currentConfluenceTab, type ConfluenceTab } from '../confluence/tab'
import { defineTool } from '../tool'
import { z } from '../zod'
import type { ConfluenceContinuation, ToolMemory } from './memory'
import { asData, clip, quote, withText } from '@cofun/tools'
import { on, READ, SEARCH } from './shared'

function remember(memory: ToolMemory, pages: readonly { ref: PageReference }[]) {
  for (const { ref } of pages) memory.confluenceResources.add(JSON.stringify([ref.instance, ref.id]))
}

const folderKey = (ref: PageReference) => JSON.stringify([ref.instance, ref.id, 'folder'])

function requirePage(memory: ToolMemory, page?: PageReference) {
  if (!page || memory.confluenceResources.has(JSON.stringify([page.instance, page.id]))) return
  if (memory.confluenceResources.has(folderKey(page)))
    throw new Error('This reference is a folder. Pass it to browse_page_tree as folder.')
  throw new Error('Use a page reference returned by a Confluence tool during this question, or omit page.')
}

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

async function target(memory: ToolMemory) {
  const instance = await getInstance(memory.accountId)
  if (!memory.confluenceQuestion) return currentConfluenceTab(instance)
  if (!instance) throw new Error('Connect a Confluence site in Settings first.')
  const tab = await memory.confluenceQuestion.tab
  if (!tab || tab.instance.origin !== instance.origin || tab.instance.path !== instance.path)
    throw new Error('Open the connected Confluence site in the current tab.')
  return tab
}

export const readConfluencePage = defineTool({
  name: 'read_page',
  args: z.strictObject({}),
  description:
    'Reads the published Confluence page open in the current tab on the connected site. Returns its text, title and source link.',
  describe: (_args, details) => on(READ, details?.name, 'the current Confluence page'),
  run: async (_args, signal, context) => {
    const page = await readPage(await target(context.memory), signal)
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
    'Finds published Confluence pages by title or text on the connected site, using the current tab. ' +
    'Use search terms and any space key from the current user message. Ask for search terms when the user did not provide them. ' +
    'Use nextPage only for the next page returned by this same search during this question. Returns excerpts and source links.',
  describe: (args) => on(SEARCH, args && clip(args.query, 120), 'Confluence pages'),
  run: async (args, signal, { memory, userText }) => {
    const query = normalizeSearchText(args.query)
    if (!normalizeSearchText(userText).includes(query)) {
      throw new Error('Use search terms from the current user message. Ask the user what to search for.')
    }
    if (args.spaceKey && !userText.includes(args.spaceKey)) {
      throw new Error('Use a space key from the current user message or leave it out.')
    }
    const tab = await target(memory)
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
  description: 'List spaces visible to the user on the connected Confluence site.',
  describe: () => on(READ, undefined, 'Confluence spaces'),
  run: async ({ nextPage }, signal, { memory }) => {
    const tab = await target(memory)
    const listed = await paginate(memory, requestKey(tab, 'list_spaces'), nextPage, (position) =>
      tab.instance.cloud ? listCloudSpaces(tab, cursor(position), signal) : listSpaces(offset(position), tab, signal),
    )
    for (const { key } of listed.spaces) memory.confluenceResources.add(requestKey(tab, 'space', { key }))
    return result(listed)
  },
})

export const getConfluenceSpace = defineTool({
  name: 'get_space',
  args: spaceArgs,
  description: 'Read a space and its homepage. Use a space key supplied by the user or returned by list_spaces.',
  describe: (args) => on(READ, args?.key, 'a Confluence space'),
  run: async ({ key }, signal, { memory, userText }) => {
    const tab = await target(memory)
    if (!userText.includes(key) && !memory.confluenceResources.has(requestKey(tab, 'space', { key })))
      throw new Error('Use a space key from the user message or list_spaces.')
    const space = tab.instance.cloud ? await getCloudSpace(tab, key, signal) : await getSpace(key, tab, signal)
    if (space.homepage) remember(memory, [space.homepage])
    return result(space)
  },
})

export const browseConfluenceTree = defineTool({
  name: 'browse_page_tree',
  args: treeArgs.omit({ start: true }).extend({
    folder: pageReference
      .optional()
      .describe('A folder reference from browse_page_tree on Confluence Cloud. Use instead of page to browse it.'),
    nextPage: collectionNext,
  }),
  description:
    'Read ancestors and direct children of the current page, a page reference returned by a Confluence tool, ' +
    'or a Confluence Cloud folder from this tool. Entries with kind "folder" are folders: pass their ref as folder.',
  describe: () => on(READ, undefined, 'the Confluence page tree'),
  run: async (args, signal, { memory }) => {
    if (args.page && args.folder) throw new Error('Pass page or folder, not both.')
    requirePage(memory, args.page)
    if (args.folder && !memory.confluenceResources.has(folderKey(args.folder)))
      throw new Error('Use a folder reference returned by browse_page_tree during this question.')
    const tab = await target(memory)
    if (args.folder && !tab.instance.cloud) throw new Error('Folders are only on Confluence Cloud.')
    const key = requestKey(tab, 'browse_page_tree', { page: args.page, folder: args.folder })
    const tree = await paginate(memory, key, args.nextPage, async (position) => {
      if (!tab.instance.cloud) {
        const tree = await browseTree({ page: args.page, start: offset(position) }, tab, signal)
        remember(memory, [tree.page, ...tree.ancestors, ...tree.children])
        return tree
      }
      const where = args.folder ? { folder: args.folder } : { page: args.page }
      const tree = await browseCloudTree(tab, where, cursor(position), signal)
      rememberTree(memory, ['folder' in tree ? tree.folder : tree.page, ...tree.ancestors, ...tree.children])
      return tree
    })
    return result(tree)
  },
})

export const listConfluenceVersions = defineTool({
  name: 'list_page_versions',
  args: versionsArgs.omit({ start: true }).extend({ nextPage: collectionNext }),
  description: 'List versions of the current published page or a page reference returned by a Confluence tool.',
  describe: () => on(READ, undefined, 'Confluence page versions'),
  run: async (args, signal, { memory }) => {
    requirePage(memory, args.page)
    const tab = await target(memory)
    const key = requestKey(tab, 'list_page_versions', args.page)
    const listed = await paginate(memory, key, args.nextPage, async (position) =>
      tab.instance.cloud
        ? listCloudVersions(tab, args.page, cursor(position), signal)
        : listVersions({ ...args, start: offset(position) }, tab, signal),
    )
    remember(memory, [listed])
    for (const { number: version } of [listed.currentVersion, ...(listed.versions ?? [])]) {
      memory.confluenceResources.add(requestKey(tab, 'version', { page: args.page, version }))
      memory.confluenceResources.add(requestKey(tab, 'version', { page: listed.ref, version }))
    }
    return result(listed)
  },
})

export const readConfluenceVersion = defineTool({
  name: 'read_page_version',
  args: versionArgs,
  description: 'Read one published version from the user request or list_page_versions for that page.',
  describe: (args) => on(READ, args && String(args.version), 'a Confluence page version'),
  run: async (args, signal, { memory, userText }) => {
    requirePage(memory, args.page)
    const tab = await target(memory)
    if (
      !userText.match(/\d+/g)?.includes(String(args.version)) &&
      !memory.confluenceResources.has(requestKey(tab, 'version', args))
    )
      throw new Error('Use a version number from the user message or list_page_versions for that page.')
    const version = tab.instance.cloud
      ? await readCloudVersion(tab, args.page, args.version, signal)
      : await readPageVersion(args, tab, signal)
    remember(memory, [version])
    return result(version)
  },
})

export const getConfluencePageAccess = defineTool({
  name: 'get_page_access',
  args: accessArgs,
  description: 'Read the reported operations and restrictions on the current page or a known page reference.',
  describe: () => on(READ, undefined, 'Confluence page access'),
  run: async ({ page }, signal, { memory }) => {
    requirePage(memory, page)
    const tab = await target(memory)
    const access = tab.instance.cloud ? await cloudPageAccess(tab, page, signal) : await pageAccess(page, tab, signal)
    remember(memory, [access])
    return result(access)
  },
})

export const listConfluenceLabels = defineTool({
  name: 'list_page_labels',
  args: labelsArgs.omit({ start: true }).extend({ nextPage: collectionNext }),
  description: 'List page labels for the current page or a page reference returned by a Confluence tool.',
  describe: () => on(READ, undefined, 'Confluence page labels'),
  run: async (args, signal, { memory }) => {
    requirePage(memory, args.page)
    const tab = await target(memory)
    const key = requestKey(tab, 'list_page_labels', args.page)
    const listed = await paginate(memory, key, args.nextPage, async (position) =>
      tab.instance.cloud
        ? listCloudLabels(tab, args.page, cursor(position), signal)
        : listLabels({ ...args, start: offset(position) }, tab, signal),
    )
    remember(memory, [listed.page])
    return result(listed)
  },
})

export const listConfluenceComments = defineTool({
  name: 'list_page_comments',
  args: commentsArgs.omit({ start: true }).extend({ nextPage: collectionNext }),
  description:
    'Read comments and replies on the current page or a page reference returned by a Confluence tool. Use nextPage to see more of the discussion.',
  describe: () => on(READ, undefined, 'Confluence page comments'),
  run: async (args, signal, { memory }) => {
    requirePage(memory, args.page)
    const tab = await target(memory)
    const key = requestKey(tab, 'list_page_comments', args.page)
    const listed = await paginate(memory, key, args.nextPage, async (position) =>
      tab.instance.cloud
        ? listCloudComments(tab, args.page, position && 'comments' in position ? position.comments : undefined, signal)
        : listPageComments({ ...args, start: offset(position) }, tab, signal),
    )
    remember(memory, [listed.page])
    return result(listed)
  },
})

export const listConfluenceAttachments = defineTool({
  name: 'list_page_attachments',
  args: attachmentsArgs.omit({ start: true }).extend({ nextPage: collectionNext }),
  description:
    'List attachments and download links for the current page or a known page reference. A filename filter must come from the user.',
  describe: () => on(READ, undefined, 'Confluence page attachments'),
  run: async (args, signal, { memory, userText }) => {
    requirePage(memory, args.page)
    if (args.filename && !userText.includes(args.filename))
      throw new Error('Use the exact attachment filename from the user message or omit filename.')
    const tab = await target(memory)
    const key = requestKey(tab, 'list_page_attachments', { page: args.page, filename: args.filename })
    const listed = await paginate(memory, key, args.nextPage, async (position) =>
      tab.instance.cloud
        ? listCloudAttachments(tab, args.page, args.filename, cursor(position), signal)
        : listPageAttachments({ ...args, start: offset(position) }, tab, signal),
    )
    remember(memory, [listed.page])
    return result(listed)
  },
})
