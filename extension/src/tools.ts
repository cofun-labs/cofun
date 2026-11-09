// Tools the agent can run in the extension.
// The worker's tests import this file too, and their tsconfig has no chrome types.
/// <reference types="chrome" />
import type { ToolSpec } from './agent'
import { IN_TRASH, NotionError, mergeRecordMaps, type LoadedPage, type NotionRecord } from './notion/api'
import { isNotion, pageIdFromUrl, toUuid } from './notion/hosts'
import {
  EditError,
  forget,
  mergeReads,
  parseEdits,
  pageRead,
  planEdit,
  previewEdits,
  type PageRead,
} from './notion/edit'
import { PAGE_TYPES, hexId, pageToMarkdown, splitSections } from './notion/markdown'
import { activeNotionTab, selectionIn, type NotionTab } from './notion/tab'

/**
 * The title and URL of the Notion page open in the side panel's window, if one is.
 * Other sites are never reported, so their URLs and titles don't reach the model.
 */
export async function currentNotionPage(): Promise<{ title: string; url: string } | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || !isNotion(tab.url)) return undefined
  // Drop a trailing " | Notion" if the tab title has one; the model does not need it.
  const title = (tab.title ?? '').replace(/\s+\|\s+Notion$/, '')
  return { title, url: tab.url! }
}

export const getCurrentPage: ToolSpec = {
  name: 'get_current_page',
  description: 'Returns the title and URL of the Notion page open in the current browser tab.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  run: async () => {
    const page = await currentNotionPage()
    if (!page) throw new Error('No Notion page is open in this window.')
    return page
  },
}

/** How much of a page one read returns, so a long page doesn't fill the conversation. */
export const PART_CHARS = 12_000

export const readPage: ToolSpec = {
  name: 'read_page',
  description:
    'Reads a Notion page as Markdown: the page open in the current tab, or another page by URL or id. ' +
    'Each block ends with a reference such as ^1a2b3c4d. Child pages, databases, and links to pages end with ' +
    'the page id, which this tool accepts. A long page comes in parts; ask for the next one with `part`.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'string', description: 'URL or id of the page to read. Leave out to read the open page.' },
      part: { type: 'integer', minimum: 1, description: 'Which part of a long page to read, starting at 1.' },
    },
    additionalProperties: false,
  },
  run: async (args) => {
    // Models often fill optional arguments with null or an empty string; those mean "not given".
    const pageText = typeof args.page === 'string' && args.page.trim() ? args.page : undefined
    const tab = await activeNotionTab()
    const id = pageText === undefined ? tab.pageId : pageArg(pageText)
    if (!id) {
      throw new Error(
        pageText === undefined
          ? 'The Notion tab does not show a page. Open a page, or give its URL or id.'
          : `Not a Notion page URL or id: ${pageText}`,
      )
    }
    const part = args.part === undefined || args.part === null || args.part === '' ? 1 : Number(args.part)
    if (!Number.isInteger(part) || part < 1) throw new Error('`part` must be a whole number from 1.')

    const { loaded, databaseMissing, reloaded } = await loadForPart(tab, id, part)
    if (!PAGE_TYPES.has(loaded.page.type)) {
      throw new Error('That id is a block inside a page, not a page. Read the page it is on instead.')
    }
    const md = pageToMarkdown(loaded)
    const { parts, members } = splitSections(md.sections, PART_CHARS)
    if (part > parts.length) {
      throw new Error(`This page has ${parts.length} part${parts.length === 1 ? '' : 's'}; there is no part ${part}.`)
    }

    const pageHex = hexId(loaded.page.id)
    const header = [
      `Page: ${md.title} ^${pageHex}`,
      `URL: ${new URL(tab.url).origin}/${pageHex}`,
      ...(parts.length > 1
        ? [`Part ${part} of ${parts.length}${part < parts.length ? `. Read part ${part + 1} for more.` : '.'}`]
        : []),
      ...(md.kind === 'database' ? ['This page is a database. Reading its rows is not supported yet.'] : []),
      ...(loaded.complete ? [] : ['The page is too long to load in full; only its beginning is shown.']),
      ...(reloaded
        ? ['This part comes from a new read of the page; parts you have from an earlier read may not match it.']
        : []),
      ...(databaseMissing
        ? ["This is a database row, but its database can't be opened, so its properties are not shown."]
        : []),
    ]
    const properties = part === 1 && md.properties.length ? ['---', ...md.properties, '---'] : []
    const body = parts[part - 1] || (md.kind === 'page' ? '(This page is empty.)' : '')
    // What edit_page checks edits against: only the blocks this read showed, as they were. Part 1
    // starts a new read; later parts add to it.
    // The blocks this part drew, as the renderer reports them: never inferred from page text.
    const drawn = new Set(members[part - 1].flatMap(({ section, from, to }) => md.owners[section].slice(from, to)))
    const seen = pageRead(loaded, md, (b) => drawn.has(b))
    remember(part === 1 ? seen : mergeReads(pageReads.get(loaded.page.id), seen))
    return [...header, '', ...properties, ...(body ? [body] : [])].join('\n')
  },
}

/**
 * A page id from what the model gave: a Notion URL (with or without `https://`), an id, a page
 * slug ending in its id (`Title-<id>`), or a reference to a page (`^<id>`).
 */
function pageArg(text: string): string | undefined {
  // `/<id>` is how read_page shows links to pages.
  let value = text
    .trim()
    .replace(/^\^/, '')
    .replace(/^\/(?=[0-9a-f]{32}\b)/i, '')
  if (/^((www\.)?notion\.so|app\.notion\.com)\//i.test(value)) value = `https://${value}`
  // notion.so redirects to www.notion.so, the host Notion's pages live on.
  value = value.replace(/^https:\/\/notion\.so\//i, 'https://www.notion.so/')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return isNotion(value) ? pageIdFromUrl(value) : undefined
  if (value.includes('/')) return undefined
  return toUuid(value) ?? toUuid(/[0-9a-f]{32}$/i.exec(value.replace(/-/g, ''))?.[0] ?? '')
}

interface Loaded {
  loaded: LoadedPage
  databaseMissing: boolean
  /** A later part was read from a fresh load, not from the read of part 1. */
  reloaded?: boolean
}

/** How long the parts after the first come from the page as it was when part 1 was read. */
const PARTS_REUSE_MS = 5 * 60_000
/** Pages whose part 1 was read last, so reading two long pages in turn keeps both. */
const PARTS_PAGES = 5
const recentReads = new Map<string, { at: number; result: Loaded }>()

/**
 * Part 1 always reads the page fresh. Later parts reuse that read for a while, so reading a long
 * page part by part loads it once, and the parts fit together even if the page changes meanwhile.
 */
async function loadForPart(tab: NotionTab, id: string, part: number): Promise<Loaded> {
  const key = `${tab.tabId}:${id}`
  const recent = recentReads.get(key)
  if (part > 1 && recent && Date.now() - recent.at < PARTS_REUSE_MS) {
    // The account in the tab may have changed since: check it can still open the page.
    await tab.client.getRecords([{ table: 'block', id, spaceId: recent.result.loaded.spaceId }])
    return recent.result
  }
  const result = await loadWithDatabase(tab, id)
  recentReads.delete(key)
  recentReads.set(key, { at: Date.now(), result })
  if (recentReads.size > PARTS_PAGES) recentReads.delete(recentReads.keys().next().value!)
  // A later part read fresh may not fit with earlier parts the model got from another read.
  return part > 1 ? { ...result, reloaded: true } : result
}

/** Loads a page, and for a database row also its database, which names the row's properties. */
async function loadWithDatabase(tab: NotionTab, id: string): Promise<Loaded> {
  const loaded = await tab.client.loadPage(id)
  const { page, spaceId, recordMap } = loaded
  if (page.parent_table !== 'collection' || !page.parent_id || recordMap.collection?.[page.parent_id]) {
    return { loaded, databaseMissing: false }
  }
  try {
    mergeRecordMaps(recordMap, await tab.client.getRecords([{ table: 'collection', id: page.parent_id, spaceId }]))
    return { loaded, databaseMissing: false }
  } catch (err) {
    // A row can be shared with someone who can't open its database; the row itself still reads.
    if (err instanceof NotionError && err.code === 'no_access') return { loaded, databaseMissing: true }
    throw err
  }
}

/** The last read of each page, by page id: what edit_page checks edits against. */
const pageReads = new Map<string, PageRead>()

/** Forgets what the agent read, for a new or another conversation, which must read pages itself. */
export function forgetReads(): void {
  pageReads.clear()
  recentReads.clear()
}

const EDIT_ITEM = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['insert', 'replace', 'delete'] },
    block: {
      type: 'string',
      description:
        'Reference of the block, as read_page shows it (e.g. ^1a2b3c4d). For insert: the block to insert after.',
    },
    position: {
      type: 'string',
      enum: ['after', 'start', 'end'],
      description: 'For insert: after `block` (the default when `block` is given), or at the start or end of the page.',
    },
    markdown: { type: 'string', description: 'For insert and replace: the new content, as Markdown.' },
  },
  required: ['action'],
  additionalProperties: false,
}

export const editPage: ToolSpec = {
  name: 'edit_page',
  description:
    'Changes a Notion page you have read with read_page: insert Markdown after a block or at the start or end of the ' +
    'page, replace a block with Markdown, or delete a block. Blocks are named by the references read_page shows. ' +
    'All edits in one call are applied together, or none are. Supported Markdown: paragraphs, # headings, - lists, ' +
    '1. lists, - [ ] to-dos, ▸ toggles, > quotes, > [!💡] callouts, ``` code, ---, $$equations$$, **bold**, *italic*, ' +
    '~~strike~~, `code`, [links](url), and [page](<page id>) mentions; a backslash keeps a character literal. ' +
    'Indent by two spaces to nest under lists, to-dos, toggles, and paragraphs; quotes and callouts hold text only. ' +
    "Child pages, databases, files, and tables can't be written. If the page changed since you read it, the edit is " +
    'refused: read it again and redo the edit.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'string', description: 'Id of the page to edit, as read_page shows it after "Page:".' },
      edits: { type: 'array', items: EDIT_ITEM, minItems: 1 },
    },
    required: ['page', 'edits'],
    additionalProperties: false,
  },
  needsConfirmation: true,
  preview: (args) => {
    const given = givenPage(args)
    if (!given) return undefined
    return previewEdits(args.edits, pageReads.get(pageArg(given) ?? ''), given)
  },
  run: async (args, signal) => {
    // The page is named in the call, so what the user approves is the page that gets changed.
    const given = givenPage(args)
    if (!given) throw new EditError('Give `page`: the id read_page shows after "Page:".')
    const id = pageArg(given)
    if (!id) throw new Error(`Not a Notion page URL or id: ${given}`)
    const tab = await activeNotionTab()
    const read = pageReads.get(id)
    if (!read) throw new EditError('Read the page with read_page first, then edit it using the references it shows.')
    const edits = parseEdits(args.edits, read)

    const loaded = await tab.client.loadPage(id)
    if (loaded.page.type !== 'page') {
      throw new EditError(
        PAGE_TYPES.has(loaded.page.type)
          ? "That is a database; edit_page can't change it."
          : 'That id is a block inside a page, not a page.',
      )
    }
    const plan = planEdit(loaded, read, edits)
    // The last point where nothing has been sent: a Stop pressed while the page loaded wins.
    // Every edit was a no-op: there is nothing to send, and the page stays as read.
    if (!plan.operations.length) return plan.summary.join('\n')
    signal?.throwIfAborted()
    try {
      await tab.client.submitTransaction(loaded.spaceId, plan.operations, 'Notion Copilot: edit_page')
    } catch (err) {
      // The edit may have been saved: a retry from the same read could apply it twice, so the
      // page must be read again first, which also shows whether it landed.
      if (err instanceof NotionError && err.code === 'outcome_unknown') {
        pageReads.delete(id)
        for (const key of recentReads.keys()) if (key.endsWith(`:${id}`)) recentReads.delete(key)
      }
      throw err
    }

    // The page changed: forget cached parts. What the agent saw stays as it was, except for what
    // this edit changed, so a block the user changed meanwhile is still refused.
    for (const key of recentReads.keys()) if (key.endsWith(`:${id}`)) recentReads.delete(key)
    // Blocks it changed or deleted need a new read before they are edited again.
    let next = forget(read, [...plan.deleted, ...plan.changed.filter((b) => b !== id)])
    let newRefs = ''
    try {
      const after = await tab.client.loadPage(id)
      // Only the blocks this edit created: anyone may have changed the others since it was saved,
      // so blocks it changed are left for the next read_page to show.
      const ours = new Set(plan.createdAll)
      next = mergeReads(
        next,
        pageRead(after, pageToMarkdown(after), (b) => ours.has(b)),
      )
      const refs = plan.created.map((c) => next.refs.get(c)).filter(Boolean)
      if (refs.length) newRefs = `New blocks: ${refs.map((r) => `^${r}`).join(', ')}.`
    } catch {
      // The edit is saved; blocks it changed will be refused until the page is read again.
    }
    remember(next)
    return [...plan.summary, newRefs, 'Read the page again to see the result.'].filter(Boolean).join('\n')
  },
}

/** The page argument, if given; null and blank mean not given. */
function givenPage(args: Record<string, unknown>): string | undefined {
  return typeof args.page === 'string' && args.page.trim() ? args.page : undefined
}

/** How many pages' reads are kept; the oldest go first. */
const READS_KEPT = 20

/** Keeps a read, as the most recent one. */
function remember(read: PageRead) {
  pageReads.delete(read.pageId)
  pageReads.set(read.pageId, read)
  if (pageReads.size > READS_KEPT) pageReads.delete(pageReads.keys().next().value!)
}

export const getSelection: ToolSpec = {
  name: 'get_selection',
  description:
    'Returns what the user has selected in the open Notion page: the selected text, and each selected block as ' +
    'Markdown with its reference, ready for edit_page (no read_page needed for those blocks). Use it when the user ' +
    'says "this", "the selection", or "the highlighted text". Nothing selected is a normal answer.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  run: async () => {
    const tab = await activeNotionTab()
    if (!tab.pageId) throw new Error('The Notion tab does not show a page.')
    const selection = await selectionIn(tab.tabId)
    if (!selection?.blockIds.length) return 'Nothing is selected in the Notion page.'
    const loaded = await tab.client.loadPage(tab.pageId)
    const md = pageToMarkdown(loaded)
    // Blocks drawn without a line of their own (table rows, columns) stand for the nearest block
    // that has one, so only blocks whose content is shown count as read.
    const shown = (raw: string): string | undefined => {
      for (let b = toUuid(raw); b && md.refs.has(b); b = loaded.recordMap.block?.[b]?.parent_id)
        if (md.lines.has(b)) return b
      return undefined
    }
    const ids = [...new Set(selection.blockIds.map(shown).filter((b): b is string => !!b))]
    const missed = selection.blockIds.some((b) => !shown(b))
    const beyond = loaded.complete
      ? "aren't on the open page"
      : "aren't on the open page, or are past the part of it that could be loaded"
    if (!ids.length) return `The selected blocks ${beyond}. Read the page instead, or ask the user to select again.`
    // The selected blocks count as read, so edit_page can change them by these references.
    const chosen = new Set(ids)
    remember(
      mergeReads(
        pageReads.get(loaded.page.id),
        pageRead(loaded, md, (b) => chosen.has(b)),
      ),
    )
    const pageHex = hexId(loaded.page.id)
    return [
      `Selection on the page “${md.title}” ^${pageHex}:`,
      '',
      ...(selection.text === undefined
        ? []
        : [
            `Selected text: “${selection.text.length > 2000 ? `${selection.text.slice(0, 1999)}…` : selection.text}”`,
            '',
          ]),
      `Selected block${ids.length === 1 ? '' : 's'}:`,
      // A block of several lines (a table, code) gets its reference on a line of its own.
      ...ids.map((b) => {
        const own = md.lines.get(b)!
        return `${own}${own.includes('\n') ? '\n' : ' '}^${md.refs.get(b)}`
      }),
      ...(missed ? ['', `Only part of the selection is shown: the other selected blocks ${beyond}.`] : []),
    ].join('\n')
  },
}

export const SEARCH_DEFAULT = 10
export const SEARCH_MAX = 20

export const searchPages: ToolSpec = {
  name: 'search_pages',
  description:
    "Searches the Notion workspace of the open page for pages by title and content, as Notion's search does. " +
    'Returns each page with its id, where it is, when it was last edited, and the matching text. Read a page it ' +
    'finds with read_page and its id.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to search for.' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: SEARCH_MAX,
        description: `How many pages to return, up to ${SEARCH_MAX}. Defaults to ${SEARCH_DEFAULT}.`,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  run: async (args) => {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) throw new Error('`query` must be some words to search for.')
    const limit =
      args.limit === undefined || args.limit === null || args.limit === '' ? SEARCH_DEFAULT : Number(args.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX) {
      throw new Error(`\`limit\` must be a whole number from 1 to ${SEARCH_MAX}.`)
    }
    const tab = await activeNotionTab()
    if (!tab.pageId) throw new Error('Open a page of the workspace to search it.')
    // The workspace to search is the open page's; it is looked up once per page.
    const spaceId = await workspaceOf(tab)

    const found = await tab.client.search(spaceId, query, limit)
    // A page in the trash can't be read, so it isn't offered.
    found.results = found.results.filter((r) => found.recordMap.block?.[r.id]?.alive !== false)
    if (!found.results.length) return `No pages found for "${query}".`
    const origin = new URL(tab.url).origin
    const tag = highlightTag(found.results)
    const plain = (text: unknown) => withoutTag(typeof text === 'string' ? text : undefined, tag)
    // A database's name is on its collection, which search doesn't return.
    const names = await databaseNames(
      tab,
      found.results.map((r) => found.recordMap.block?.[r.id]),
    )
    const lines = found.results.map((r, n) => {
      const block = found.recordMap.block?.[r.id] as
        | { type?: string; properties?: { title?: unknown }; last_edited_time?: number }
        | undefined
      const database = block?.type === 'collection_view_page' || block?.type === 'collection_view'
      const title =
        plain(r.highlight?.title) ||
        (database ? names.get(r.id) : runsText(block?.properties?.title)) ||
        (database ? 'Untitled database' : 'Untitled')
      // The path may end with the page itself (a top-level page's is only its own title).
      const path = plain(r.highlight?.pathText)
      const where = path === title ? '' : path.endsWith(` / ${title}`) ? path.slice(0, -title.length - 3) : path
      const text = plain(r.highlight?.text)
      const edited =
        typeof block?.last_edited_time === 'number' ? new Date(block.last_edited_time).toISOString().slice(0, 10) : ''
      return [
        `${n + 1}. ${database ? '🗃' : '📄'} ${title} ^${hexId(r.id)}`,
        ...(where ? [`   In: ${where}`] : []),
        ...(edited ? [`   Edited: ${edited}`] : []),
        ...(text ? [`   Match: “${clip(text, 200)}”`] : []),
        `   URL: ${origin}/${hexId(r.id)}`,
      ].join('\n')
    })
    const shown = found.results.length
    const more = found.total > shown ? ` (${found.total} in all; showing ${shown})` : ''
    return [`Pages found for "${query}"${more}:`, '', ...lines].join('\n')
  },
}

/**
 * The tag a search response marks matched words with: a random name per response, such as
 * `<gzkNfoUU>word</gzkNfoUU>`. Only that tag is removed, so other `<…>` text stays as written.
 */
function highlightTag(results: { highlight?: Record<string, unknown> }[]): string | undefined {
  // The name used most often across every highlight, preferring Notion's random 8-character
  // shape, so literal markup in page text (say `<b>bold</b>`) isn't taken for it.
  const counts = new Map<string, number>()
  for (const r of results) {
    for (const text of Object.values(r.highlight ?? {})) {
      if (typeof text !== 'string') continue
      for (const m of text.matchAll(/<([A-Za-z0-9]+)>[^<]*<\/\1>/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
    }
  }
  // Only Notion's shape counts: without one, no tag is removed at all.
  const ranked = [...counts].filter(([name]) => /^[A-Za-z0-9]{8}$/.test(name)).sort(([, n], [, m]) => m - n)
  return ranked[0]?.[0]
}

/** Workspace ids of pages, so searching from the same page doesn't look it up again. */
const pageWorkspaces = new Map<string, string>()

async function workspaceOf(tab: NotionTab): Promise<string> {
  const pageId = tab.pageId!
  const known = pageWorkspaces.get(pageId)
  if (known) return known
  let spaceId: string | undefined
  try {
    const opened = await tab.client.getRecords([{ table: 'block', id: pageId }])
    spaceId = (opened.block?.[pageId] as { space_id?: string } | undefined)?.space_id
  } catch (err) {
    if (err instanceof NotionError && err.message === IN_TRASH) {
      throw new Error('The open page is in the trash. Open another page of the workspace to search it.')
    }
    throw err
  }
  if (!spaceId) throw new Error('Could not tell which workspace the open page is in.')
  pageWorkspaces.set(pageId, spaceId)
  return spaceId
}

/** Names of the databases among `blocks`, by block id; databases that can't be looked up are left out. */
async function databaseNames(tab: NotionTab, blocks: (NotionRecord | undefined)[]): Promise<Map<string, string>> {
  const databases = blocks.filter(
    (b): b is NotionRecord => !!b && (b.type === 'collection_view_page' || b.type === 'collection_view'),
  )
  const collectionOf = (b: NotionRecord) =>
    (b.collection_id as string | undefined) ??
    (b.format as { collection_pointer?: { id?: string } } | undefined)?.collection_pointer?.id
  const ids = [...new Set(databases.map(collectionOf).filter((id): id is string => !!id))]
  const names = new Map<string, string>()
  if (!ids.length) return names
  // One lookup per database, so one that can't be opened (say, a linked view of another
  // workspace's database) leaves only its own name out.
  const found = await Promise.allSettled(
    ids.map((id) =>
      tab.client.getRecords([{ table: 'collection', id }]).then((r) => [id, r.collection?.[id]] as const),
    ),
  )
  const byCollection = new Map(found.flatMap((f) => (f.status === 'fulfilled' ? [f.value] : [])))
  for (const b of databases) {
    const name = runsText(byCollection.get(collectionOf(b) ?? '')?.name)
    if (name) names.set(b.id, name)
  }
  return names
}

function withoutTag(text: string | undefined, tag: string | undefined): string {
  const out = tag ? (text ?? '').split(`<${tag}>`).join('').split(`</${tag}>`).join('') : (text ?? '')
  return out.replace(/\s+/g, ' ').trim()
}

function runsText(value: unknown): string {
  return Array.isArray(value) ? value.map((r) => (Array.isArray(r) ? String(r[0]) : '')).join('') : ''
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export const TOOLS: ToolSpec[] = [getCurrentPage, readPage, editPage, searchPages, getSelection]
