import type { ToolContext } from '../agent'
import { normalizeSearchText, readPage, searchPages, SearchArgs } from '../confluence/api'
import { attachmentsArgs, listPageAttachments } from '../confluence/attachments'
import { commentsArgs, listPageComments } from '../confluence/comments'
import { accessArgs, listVersions, pageAccess, readPageVersion, versionArgs, versionsArgs } from '../confluence/history'
import { getInstance } from '../confluence/instance'
import { labelsArgs, listLabels } from '../confluence/labels'
import { browseTree, getSpace, listSpaces, listSpacesArgs, spaceArgs, treeArgs } from '../confluence/navigation'
import type { PageReference } from '../confluence/references'
import { currentConfluenceTab, type ConfluenceTab } from '../confluence/tab'
import { defineTool } from '../tool'
import { z } from '../zod'
import type { ToolMemory } from './memory'
import { withText } from './results'
import { asData, clip, on, quote, READ, SEARCH } from './shared'

function remember(memory: ToolMemory, pages: readonly { ref: PageReference }[]) {
  for (const { ref } of pages) memory.confluenceResources.add(JSON.stringify([ref.instance, ref.id]))
}

function requirePage(memory: ToolMemory, page?: PageReference) {
  if (page && !memory.confluenceResources.has(JSON.stringify([page.instance, page.id])))
    throw new Error('Use a page reference returned by a Confluence tool during this question, or omit page.')
}

function result(data: object) {
  return asData([JSON.stringify(data)])
}

function requestKey(tab: ConfluenceTab, tool: string, filters?: object) {
  return JSON.stringify([tab.instance.origin, tab.instance.path, tab.url, tool, filters])
}

/** Continuation offsets are granted only by the same collection response in this question. */
async function paginate<T extends { nextStart?: number }>(
  memory: ToolMemory,
  key: string,
  start: number,
  run: () => Promise<T>,
): Promise<T> {
  const offsets = memory.nextConfluencePages
  if (start !== 0 && start !== offsets.get(key))
    throw new Error('Use the next offset returned by the same Confluence search in this question, or omit start.')
  const value = await run()
  if (value.nextStart === undefined) offsets.delete(key)
  else offsets.set(key, value.nextStart)
  return value
}

async function target({ accountId, memory }: Pick<ToolContext, 'accountId' | 'memory'>) {
  const instance = await getInstance(accountId)
  if (!memory.confluenceQuestion) return currentConfluenceTab(instance)
  if (!instance) throw new Error('Connect a self-managed Confluence site in Settings first.')
  const tab = await memory.confluenceQuestion.tab
  if (!tab || tab.instance.origin !== instance.origin || tab.instance.path !== instance.path)
    throw new Error('Open the connected Confluence site in the current tab.')
  return tab
}

export const readConfluencePage = defineTool({
  name: 'read_page',
  args: z.strictObject({}),
  description:
    'Reads the published Confluence page open in the current tab on the connected self-managed site. Returns its text, title and source link.',
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
    'Finds published Confluence pages by title or text on the connected self-managed site, using the current tab. ' +
    'Use search terms and any space key from the current user message. Ask for search terms when the user did not provide them. ' +
    'Use start only for the next page returned by this same search during this question. Returns excerpts and source links.',
  describe: (args) => on(SEARCH, args && clip(args.query, 120), 'Confluence pages'),
  run: async (args, signal, { accountId, memory, userText }) => {
    const query = normalizeSearchText(args.query)
    if (!normalizeSearchText(userText).includes(query)) {
      throw new Error('Use search terms from the current user message. Ask the user what to search for.')
    }
    if (args.spaceKey && !userText.includes(args.spaceKey)) {
      throw new Error('Use a space key from the current user message or leave it out.')
    }
    const tab = await target({ accountId, memory })
    const key = requestKey(tab, 'search_pages', { query, field: args.field, spaceKey: args.spaceKey })
    const hits = await paginate(memory, key, args.start, () => searchPages(tab, args, signal))
    remember(memory, hits.results)
    return { text: result(hits), details: { name: clip(args.query, 120) } }
  },
})

export const listConfluenceSpaces = defineTool({
  name: 'list_spaces',
  args: listSpacesArgs,
  description: 'List spaces visible to the user on the connected Confluence site.',
  describe: () => on(READ, undefined, 'Confluence spaces'),
  run: async ({ start }, signal, { accountId, memory }) => {
    const tab = await target({ accountId, memory })
    const listed = await paginate(memory, requestKey(tab, 'list_spaces'), start, () => listSpaces(start, tab, signal))
    for (const { key } of listed.spaces) memory.confluenceResources.add(requestKey(tab, 'space', { key }))
    return result(listed)
  },
})

export const getConfluenceSpace = defineTool({
  name: 'get_space',
  args: spaceArgs,
  description: 'Read a space and its homepage. Use a space key supplied by the user or returned by list_spaces.',
  describe: (args) => on(READ, args?.key, 'a Confluence space'),
  run: async ({ key }, signal, { accountId, memory, userText }) => {
    const tab = await target({ accountId, memory })
    if (!userText.includes(key) && !memory.confluenceResources.has(requestKey(tab, 'space', { key })))
      throw new Error('Use a space key from the user message or list_spaces.')
    const space = await getSpace(key, tab, signal)
    if (space.homepage) remember(memory, [space.homepage])
    return result(space)
  },
})

export const browseConfluenceTree = defineTool({
  name: 'browse_page_tree',
  args: treeArgs,
  description:
    'Read ancestors and direct children of the current page or a page reference returned by a Confluence tool.',
  describe: () => on(READ, undefined, 'the Confluence page tree'),
  run: async (args, signal, { accountId, memory }) => {
    requirePage(memory, args.page)
    const tab = await target({ accountId, memory })
    const key = requestKey(tab, 'browse_page_tree', args.page)
    const tree = await paginate(memory, key, args.start, () => browseTree(args, tab, signal))
    remember(memory, [tree.page, ...tree.ancestors, ...tree.children])
    return result(tree)
  },
})

export const listConfluenceVersions = defineTool({
  name: 'list_page_versions',
  args: versionsArgs,
  description: 'List versions of the current published page or a page reference returned by a Confluence tool.',
  describe: () => on(READ, undefined, 'Confluence page versions'),
  run: async (args, signal, { accountId, memory }) => {
    requirePage(memory, args.page)
    const tab = await target({ accountId, memory })
    const key = requestKey(tab, 'list_page_versions', args.page)
    const listed = await paginate(memory, key, args.start, () => listVersions(args, tab, signal))
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
  run: async (args, signal, { accountId, memory, userText }) => {
    requirePage(memory, args.page)
    const tab = await target({ accountId, memory })
    if (
      !userText.match(/\d+/g)?.includes(String(args.version)) &&
      !memory.confluenceResources.has(requestKey(tab, 'version', args))
    )
      throw new Error('Use a version number from the user message or list_page_versions for that page.')
    const version = await readPageVersion(args, tab, signal)
    remember(memory, [version])
    return result(version)
  },
})

export const getConfluencePageAccess = defineTool({
  name: 'get_page_access',
  args: accessArgs,
  description: 'Read the reported operations and restrictions on the current page or a known page reference.',
  describe: () => on(READ, undefined, 'Confluence page access'),
  run: async ({ page }, signal, { accountId, memory }) => {
    requirePage(memory, page)
    const access = await pageAccess(page, await target({ accountId, memory }), signal)
    remember(memory, [access])
    return result(access)
  },
})

export const listConfluenceLabels = defineTool({
  name: 'list_page_labels',
  args: labelsArgs,
  description: 'List page labels for the current page or a page reference returned by a Confluence tool.',
  describe: () => on(READ, undefined, 'Confluence page labels'),
  run: async (args, signal, { accountId, memory }) => {
    requirePage(memory, args.page)
    const tab = await target({ accountId, memory })
    const key = requestKey(tab, 'list_page_labels', args.page)
    const listed = await paginate(memory, key, args.start, () => listLabels(args, tab, signal))
    remember(memory, [listed.page])
    return result(listed)
  },
})

export const listConfluenceComments = defineTool({
  name: 'list_page_comments',
  args: commentsArgs,
  description: 'Read comments and replies on the current page or a page reference returned by a Confluence tool.',
  describe: () => on(READ, undefined, 'Confluence page comments'),
  run: async (args, signal, { accountId, memory }) => {
    requirePage(memory, args.page)
    const tab = await target({ accountId, memory })
    const key = requestKey(tab, 'list_page_comments', args.page)
    const listed = await paginate(memory, key, args.start, () => listPageComments(args, tab, signal))
    remember(memory, [listed.page])
    return result(listed)
  },
})

export const listConfluenceAttachments = defineTool({
  name: 'list_page_attachments',
  args: attachmentsArgs,
  description:
    'List attachments and download links for the current page or a known page reference. A filename filter must come from the user.',
  describe: () => on(READ, undefined, 'Confluence page attachments'),
  run: async (args, signal, { accountId, memory, userText }) => {
    requirePage(memory, args.page)
    if (args.filename && !userText.includes(args.filename))
      throw new Error('Use the exact attachment filename from the user message or omit filename.')
    const tab = await target({ accountId, memory })
    const key = requestKey(tab, 'list_page_attachments', { page: args.page, filename: args.filename })
    const listed = await paginate(memory, key, args.start, () => listPageAttachments(args, tab, signal))
    remember(memory, [listed.page])
    return result(listed)
  },
})
