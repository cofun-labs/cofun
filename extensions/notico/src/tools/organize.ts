// Organizing pages: move_page, duplicate_page, and trash_page.
import { defineTool } from '../tool'
import { z } from '../zod'
import { NotionError, blockOps, type Block, type NotionRecord } from '../notion/api'
import { pageLink } from '../notion/hosts'
import { EditError } from '../notion/edit'
import { quote } from '../notion/comments'
import { oneLine } from '../notion/props'
import { PAGE_TYPES, hexId } from '../notion/markdown'
import { activeNotionTab, type NotionTab } from '../notion/tab'
import { runsText } from '../notion/tree'
import { databaseNames } from './load'
import { forgetPages, knownTitle } from './memory'
import { DUPLICATE, MOVE, PAGES_LIST, QUOTED, count, idIn, idsOf, on, pageArg, quoted } from './shared'

/** How many pages one move_page or trash_page call takes at most, so its preview stays readable. */
const ORGANIZE_MAX = 50

/** How far up from a page move_page looks for the pages it is in. */
const ANCESTORS_MAX = 100

/** The `pages` argument of move_page and trash_page: ids or URLs, at least one. */
const pagesArg = (description: string) =>
  z
    .array(
      z.string({
        error: (issue) =>
          `Page ${Number(issue.path?.[1]) + 1} is not a Notion page URL or id: ${oneLine(String(issue.input))}`,
      }),
      { error: PAGES_LIST },
    )
    .min(1, { error: PAGES_LIST })
    .max(ORGANIZE_MAX, { error: `At most ${ORGANIZE_MAX} pages can go in one call.` })
    .describe(description)

/** A list of pages as move_page and trash_page take it: ids, each once. */
function pageList(pages: string[]): string[] {
  const ids = pages.map((page, i) => {
    const id = pageArg(page)
    if (!id) throw new EditError(`Page ${i + 1} is not a Notion page URL or id: ${oneLine(page)}`)
    return id
  })
  return [...new Set(ids)]
}

/** The ids `pages` names, for a preview: whatever can be read of it, never an error. */
function previewIds(pages: string[]): { given: string; id?: string }[] {
  const seen = new Set<string>()
  // Each page once, as `run` takes them, so the preview counts and lists what happens.
  return pages.flatMap((page) => {
    const given = page.trim()
    const id = given ? pageArg(given) : undefined
    if (id && seen.has(id)) return []
    if (id) seen.add(id)
    return [{ given, id }]
  })
}

/** A page for a preview: its title when known, and its reference. */
function shownPage(given: string, id: string | undefined, title = id ? knownTitle(id) : undefined): string {
  if (!id) return oneLine(given) || '(no page given)'
  return `${title ? `${oneLine(title)} ` : ''}^${hexId(id)}`
}

/** Why a block can't be moved, copied, or trashed as a page; undefined if it can. */
function cannotReorganize(block: NotionRecord, verb: string): string | undefined {
  const ref = `^${hexId(block.id)}`
  if (block.type === 'collection_view') return `${ref} is a database inside a page, not a page: move the page it is on.`
  if (block.type !== 'page' && block.type !== 'collection_view_page')
    return `${ref} is a block inside a page, not a page.`
  if (block.parent_table === 'collection') return `${ref} is a database row: rows can't be ${verb} with this tool.`
  return undefined
}

/**
 * The block each page sits in, for pages whose parent is a block, by page id; a parent that can't
 * be opened is left out.
 */
async function blockParents(
  tab: NotionTab,
  records: Record<string, NotionRecord>,
  pages: NotionRecord[],
): Promise<Record<string, NotionRecord | undefined>> {
  const wanted = [...new Set(pages.flatMap((p) => (p.parent_table === 'block' && p.parent_id ? [p.parent_id] : [])))]
  const missing = wanted.filter((id) => !records[id])
  const found = missing.length
    ? ((await tab.client.findRecords(missing.map((id) => ({ table: 'block' as const, id })))).block ?? {})
    : {}
  return Object.fromEntries(
    pages.map((p) => [
      p.id,
      p.parent_table === 'block' && p.parent_id ? (records[p.parent_id] ?? found[p.parent_id]) : undefined,
    ]),
  )
}

/**
 * Why a page's place can't be changed here, in a few words: it must sit right in a page, not in a
 * column, toggle, or other block, where Notion's handling is not checked.
 */
function placeRefusal(page: NotionRecord, parent: NotionRecord | undefined): string | undefined {
  if (page.parent_table !== 'block') return undefined
  if (!parent) return "in a block that can't be opened"
  if (parent.type !== 'page')
    return `inside ${typeof parent.type === 'string' ? `a ${parent.type.replace(/_/g, ' ')}` : 'a block'}, not right in a page`
  return undefined
}

const MOVE_TO = '`to` is required: the id or URL of the page to move them into.'

export const movePage = defineTool({
  name: 'move_page',
  changesData: true,
  description:
    'Moves pages, or databases that are pages of their own, to the end of another page, with everything in them, ' +
    'as Notion\'s "Move to" does. Several pages can go in one call. A page can\'t go into itself or a page ' +
    "inside it, and database rows and pages at the top of a teamspace can't be moved.",
  touched: (args) => ({ changed: idsOf(args?.pages) }),
  describe: (args) => ({ verb: MOVE, what: args ? count(args.pages.length, 'page') : 'pages' }),
  args: z.strictObject({
    pages: pagesArg('Ids or URLs of the pages to move.'),
    to: z.string({ error: MOVE_TO }).describe('Id or URL of the page to move them into.'),
  }),
  preview: (args) => {
    const pages = previewIds(args.pages)
    const to = args.to.trim()
    return [
      `Move ${pages.length} page${pages.length === 1 ? '' : 's'}`,
      `To the end of: ${shownPage(to, to ? pageArg(to) : undefined)}`,
      ...pages.map((p) => `    ${shownPage(p.given, p.id)}`),
    ].join('\n')
  },
  run: async (args, signal) => {
    const ids = pageList(args.pages)
    const to = args.to.trim()
    if (!to) throw new EditError(MOVE_TO)
    const destId = pageArg(to)
    if (!destId) throw new EditError(`Not a Notion page URL or id: ${oneLine(to)}`)
    const tab = await activeNotionTab()
    const records = await loadPages(tab, [...ids, destId])
    const dest = records[destId]
    if (dest.type !== 'page') {
      throw new EditError(
        PAGE_TYPES.has(String(dest.type))
          ? `^${hexId(destId)} is a database: pages can only be moved into a page.`
          : `^${hexId(destId)} is a block inside a page: pages can only be moved into a page.`,
      )
    }
    const moveParents = await blockParents(
      tab,
      records,
      ids.map((id) => records[id]),
    )
    for (const id of ids) {
      const why = cannotReorganize(records[id], 'moved')
      if (why) throw new EditError(why)
      const place = placeRefusal(records[id], moveParents[id])
      if (place) throw new EditError(`^${hexId(id)} is ${place}: move it in Notion.`)
      // How Notion takes a page out of a teamspace's list is not checked yet.
      if (records[id].parent_table === 'team')
        throw new EditError(`^${hexId(id)} is at the top of a teamspace: move it in Notion.`)
      if (records[id].space_id !== dest.space_id)
        throw new EditError(`^${hexId(id)} is in another workspace than ^${hexId(destId)}.`)
    }
    // The destination and every page it is in: none of them may be a page that moves.
    const above = await pagesAbove(tab, records, [destId, ...ids])
    const chain = [destId, ...above.get(destId)!]
    for (const id of ids) {
      if (chain.includes(id))
        throw new EditError(
          id === destId
            ? `^${hexId(id)} can't be moved into itself.`
            : `^${hexId(id)} can't be moved into ^${hexId(destId)}: that page is inside it.`,
        )
    }
    // A page inside another page that moves goes along inside it, where it is.
    const nested = nestedIn(above, ids)
    const moving = ids.filter((id) => !nested.has(id))
    const op = blockOps(String(dest.space_id), Date.now(), tab.client.userId)
    const parents = new Set(moving.map((id) => String(records[id].parent_id)))
    signal?.throwIfAborted()
    try {
      // Moving again puts the pages in the same place, so after a lost answer a retry does no harm.
      await tab.client.submitTransaction(
        String(dest.space_id),
        [op.moveInto(destId, moving), op.touch(destId), ...moving.map((id) => op.touch(id))],
        'Notico: move_page',
      )
    } finally {
      forgetPages([destId, ...parents, ...ids, ...[...above.values()].flat()])
    }
    return [
      `Moved ${moving.length} page${moving.length === 1 ? '' : 's'} to the end of ^${hexId(destId)}: ${moving.map((id) => `^${hexId(id)}`).join(', ')}.`,
      ...[...nested].map(([id, outer]) => `^${hexId(id)} went along inside ^${hexId(outer)}.`),
    ].join('\n')
  },
})

/**
 * The pages by id, all of them or an error. One already in the trash, or out of reach, is named,
 * so the agent can tell which (say, after a lost answer, which pages were trashed already).
 */
async function loadPages(tab: NotionTab, ids: string[]): Promise<Record<string, Block>> {
  try {
    return (await tab.client.getRecords(ids.map((id) => ({ table: 'block' as const, id })))).block!
  } catch (err) {
    if (!(err instanceof NotionError) || (err.code !== 'no_access' && err.code !== 'in_trash')) throw err
    const found = (await tab.client.findRecords(ids.map((id) => ({ table: 'block' as const, id })))).block ?? {}
    const missing = ids.filter((id) => !found[id])
    if (!missing.length) throw err
    throw new NotionError(
      'no_access',
      `${missing.map((id) => `^${hexId(id)}`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} in the trash, ` +
        "or can't be opened with this Notion account. Nothing was changed.",
      { cause: err },
    )
  }
}

/**
 * The pages each of `ids` is in, nearest first, as far as the account can see (a record it can't
 * open ends that walk; Notion itself still refuses a move into a page's own pages). Walks up from
 * all of them a level at a time, in one request per level, through rows' databases too.
 */
async function pagesAbove(
  tab: NotionTab,
  records: Record<string, NotionRecord>,
  ids: string[],
): Promise<Map<string, string[]>> {
  const known = new Map<string, NotionRecord>(Object.entries(records))
  const above = new Map(ids.map((id) => [id, [] as string[]]))
  let walks = ids.map((id): { id: string; at: NotionRecord | undefined } => ({ id, at: records[id] }))
  for (let depth = 0; depth < ANCESTORS_MAX && walks.length; depth++) {
    const next = walks.flatMap((w) => {
      // A row's parent is its database's data source, which sits in the database block.
      const table: 'block' | 'collection' | undefined =
        w.at?.parent_table === 'block' ? 'block' : w.at?.parent_table === 'collection' ? 'collection' : undefined
      return table && w.at?.parent_id ? [{ id: w.id, table, parentId: w.at.parent_id }] : []
    })
    const wanted = [...new Map(next.filter((n) => !known.has(n.parentId)).map((n) => [n.parentId, n])).values()]
    if (wanted.length) {
      const found = await tab.client.findRecords(wanted.map((n) => ({ table: n.table, id: n.parentId })))
      for (const records of [found.block, found.collection])
        for (const r of Object.values(records ?? {})) known.set(r.id, r)
    }
    walks = next.flatMap((n) => {
      const at = known.get(n.parentId)
      // Only pages count: a column or toggle a page sits in is not one the agent or user works with.
      if (n.table === 'block' && at && PAGE_TYPES.has(String(at.type))) above.get(n.id)!.push(n.parentId)
      return at ? [{ id: n.id, at }] : []
    })
  }
  return above
}

/** Which of `ids` are inside another of them, with the outermost one each is in. */
function nestedIn(above: Map<string, string[]>, ids: string[]): Map<string, string> {
  const listed = new Set(ids)
  const nested = new Map<string, string>()
  for (const id of ids) {
    const outer = (above.get(id) ?? []).filter((a) => listed.has(a)).at(-1)
    if (outer) nested.set(id, outer)
  }
  return nested
}

const DUPLICATE_PAGE = '`page` is required: the id or URL of the page to duplicate.'

/** The first line of a duplicate_page result: the page duplicated, by name when known, and the copy. */
const DUPLICATED_PAGE = new RegExp(`^Duplicated (${QUOTED}) \\^`, 'm')
const DUPLICATED_AS = new RegExp(`^Duplicated (?:${QUOTED} )?\\^[0-9a-f]{32} as \\^([0-9a-f]{32}),`, 'm')

export const duplicatePage = defineTool({
  name: 'duplicate_page',
  changesData: true,
  description:
    'Duplicates a page, or a database that is a page of its own, with everything in it (content, pages, and ' +
    "databases inside), as Notion's Duplicate does: the copy goes right after the page, and Notion adds a number " +
    "to its title. Returns the copy's id and URL. Database rows and pages at the top of the sidebar can't be " +
    'duplicated with this tool.',
  // The copy is the page it made.
  touched: (_args, result) => ({ changed: idIn(result, DUPLICATED_AS) }),
  describe: (_args, result) => on(DUPLICATE, quoted(result, DUPLICATED_PAGE), 'a page'),
  args: z.strictObject({
    page: z.string({ error: DUPLICATE_PAGE }).describe('Id or URL of the page to duplicate.'),
  }),
  preview: ({ page }) => {
    const given = page.trim()
    return [
      'Duplicate a page, with everything in it',
      `Page: ${shownPage(given, given ? pageArg(given) : undefined)}`,
    ].join('\n')
  },
  run: async ({ page: named }, signal) => {
    const given = named.trim()
    if (!given) throw new EditError(DUPLICATE_PAGE)
    const id = pageArg(given)
    if (!id) throw new EditError(`Not a Notion page URL or id: ${oneLine(given)}`)
    const tab = await activeNotionTab()
    const page = (await tab.client.getRecords([{ table: 'block', id }])).block![id]
    const why = cannotReorganize(page, 'duplicated')
    if (why) throw new EditError(why)
    if (page.parent_table !== 'block' || !page.parent_id)
      throw new EditError(
        `^${hexId(id)} is at the top of the sidebar: duplicate it in Notion, or move it into a page first.`,
      )
    // The copy goes where the page is, so that must be right in a page too.
    const place = placeRefusal(page, (await blockParents(tab, { [id]: page }, [page]))[id])
    if (place) throw new EditError(`^${hexId(id)} is ${place}: duplicate it in Notion.`)
    // The pages the copy lands in, from the nearest up, whose cached reads it makes stale.
    const above = (await pagesAbove(tab, { [id]: page }, [id])).get(id)!
    const near = above[0] ?? page.parent_id
    signal?.throwIfAborted()
    try {
      const copy = await tab.client.duplicatePage(String(page.space_id), id, page.parent_id, { signal })
      const hex = hexId(copy)
      // A database's name is not in its block: only a name the agent has seen is given for one.
      const title = knownTitle(id) || runsText(page.properties?.title)
      return [
        `Duplicated ${title ? `${quote(title)} ` : ''}^${hexId(id)} as ^${hex}, right after it in ^${hexId(near)}.`,
        `URL: ${pageLink(tab.url, hex)}`,
      ].join('\n')
    } catch (err) {
      // A retry would make a second copy if this one was made: the agent must look first.
      if (err instanceof NotionError && err.code === 'outcome_unknown')
        throw new NotionError(
          'outcome_unknown',
          `${err.message} List the pages of ^${hexId(near)} to see whether the copy is there.`,
          { cause: err, stopsQuestion: err.stopsQuestion },
        )
      throw err
    } finally {
      forgetPages([page.parent_id, ...above])
    }
  },
})

/** How many children trash_page's preview looks at at most. */
const COUNT_CHILDREN_MAX = 500

/**
 * How many pages or databases sit right inside each page, for the trash preview: nothing when the
 * pages hold too many blocks to look at, or Notion says they can't be opened.
 */
async function childCounts(tab: NotionTab, pages: Block[]): Promise<Map<string, number>> {
  const childIds = pages.flatMap((b) => b.content ?? [])
  if (!childIds.length || childIds.length > COUNT_CHILDREN_MAX) return new Map()
  try {
    const children = (await tab.client.findRecords(childIds.map((id) => ({ table: 'block' as const, id })))).block ?? {}
    return new Map(
      pages.map((b) => [b.id, (b.content ?? []).filter((c) => PAGE_TYPES.has(children[c]?.type ?? '')).length]),
    )
  } catch (err) {
    // Only what stops the question goes on; a count Notion says can't be made is left out.
    if (err instanceof NotionError && err.stopsQuestion) throw err
    return new Map()
  }
}

/** Why trash_page refuses a page, in a few words; undefined if it doesn't. */
function trashRefusal(page: NotionRecord, parent: NotionRecord | undefined): string | undefined {
  if (cannotReorganize(page, 'trashed')) {
    if (page.parent_table === 'collection') return 'a database row'
    return 'not a page'
  }
  if (!page.parent_id) return 'without a parent Notion names'
  if (page.parent_table !== 'block' && page.parent_table !== 'space') return 'at the top of a teamspace'
  return placeRefusal(page, parent)
}

export const trashPage = defineTool({
  name: 'trash_page',
  changesData: true,
  description:
    "Moves pages, or databases that are pages of their own, to Notion's trash, with everything in them. The user " +
    "is asked first, each time. Nothing is deleted for good: the pages can be restored from Notion's trash. " +
    "Database rows and pages at the top of a teamspace can't be trashed with this tool.",
  needsConfirmation: true,
  touched: (args) => ({ changed: idsOf(args?.pages) }),
  describe: (args) => ({ verb: MOVE, what: `${args ? count(args.pages.length, 'page') : 'pages'} to the trash` }),
  args: z.strictObject({ pages: pagesArg('Ids or URLs of the pages to trash.') }),
  // The user agrees from this, so it names each page as Notion has it now, not as the agent saw it.
  preview: async (args) => {
    const pages = previewIds(args.pages)
    const ids = pages.flatMap((p) => (p.id ? [p.id] : []))
    let found: Record<string, Block> = {}
    let parents: Record<string, NotionRecord | undefined> = {}
    let names = new Map<string, string>()
    let inside = new Map<string, number>()
    let checked = false
    try {
      // Waited for in full, Stop aside, so nothing it asks of Notion goes unheard: Notion turning a
      // lookup away stops the question before the user is asked (see previewCall in agent/calls.ts).
      const tab = await activeNotionTab()
      found = (await tab.client.findRecords(ids.map((id) => ({ table: 'block' as const, id })))).block ?? {}
      parents = await blockParents(tab, found, Object.values(found))
      names = await databaseNames(tab, Object.values(found))
      checked = true
      inside = await childCounts(tab, Object.values(found))
    } catch (err) {
      if (err instanceof NotionError && err.stopsQuestion) throw err
      // When Notion says the pages can't be opened, the names the agent saw are all there is.
    }
    return [
      `Move ${pages.length} page${pages.length === 1 ? '' : 's'} to the trash, with everything in ${pages.length === 1 ? 'it' : 'them'}`,
      ...pages.map((p) => {
        const block = p.id ? found[p.id] : undefined
        const title = block ? names.get(block.id) || runsText(block.properties?.title) || 'Untitled' : undefined
        // A page's editors choose its title: it goes last and in quotes, so it can't pass for what the
        // tool says. A page Notion doesn't have (already trashed, or out of reach) makes the call fail.
        if (!p.id) return `    ${JSON.stringify(oneLine(p.given) || '(no page given)')}`
        const name = title ?? knownTitle(p.id)
        // Pages the call will refuse are marked, so the user doesn't agree to what can't happen.
        const refused = !checked ? undefined : !block ? 'not found in Notion' : trashRefusal(block, parents[block.id])
        const marker = refused ? `[${refused}: this call will fail, and nothing will be trashed] ` : ''
        const count = inside.get(p.id) ?? 0
        const holds = count
          ? ` (with ${count} page${count === 1 ? '' : 's'} or database${count === 1 ? '' : 's'} inside)`
          : ''
        return `    ${marker}^${hexId(p.id)}${holds}${name ? ` ${JSON.stringify(oneLine(name))}` : ''}`
      }),
      // The user agrees from these names: say when they are not Notion's current ones.
      ...(checked ? [] : ['Could not check the current names in Notion: these are the names last seen, if any.']),
      "They stay in Notion's trash, where they can be restored.",
    ].join('\n')
  },
  run: async (args, signal) => {
    const ids = pageList(args.pages)
    const tab = await activeNotionTab()
    const records = await loadPages(tab, ids)
    const trashParents = await blockParents(
      tab,
      records,
      ids.map((id) => records[id]),
    )
    const pages = ids.map((id) => {
      const page = records[id]
      const why = cannotReorganize(page, 'trashed')
      if (why) throw new EditError(why)
      const refused = trashRefusal(page, trashParents[id])
      if (refused) throw new EditError(`^${hexId(id)} is ${refused}: trash it in Notion.`)
      // trashRefusal let only these two through.
      return {
        id,
        parentId: page.parent_id!,
        parentTable: page.parent_table === 'space' ? ('space' as const) : ('block' as const),
      }
    })
    const spaces = new Set(ids.map((id) => String(records[id].space_id)))
    if (spaces.size > 1)
      throw new EditError('These pages are in different workspaces: trash each workspace’s pages in its own call.')
    // A page inside another page being trashed stays inside it, so restoring that page brings it back too.
    const above = await pagesAbove(tab, records, ids)
    const nested = nestedIn(above, ids)
    const trashing = pages.filter((p) => !nested.has(p.id))
    signal?.throwIfAborted()
    try {
      // After a lost answer, a retry names the pages already in the trash and trashes nothing.
      await tab.client.trashPages([...spaces][0], trashing)
    } finally {
      forgetPages([...ids, ...[...above.values()].flat()])
    }
    return [
      `Moved ${ids.length} page${ids.length === 1 ? '' : 's'} to Notion's trash: ${ids.map((id) => `^${hexId(id)}`).join(', ')}.`,
      ...[...nested].map(([id, outer]) => `^${hexId(id)} went inside ^${hexId(outer)}.`),
      "They can be restored from Notion's trash.",
    ].join('\n')
  },
})
