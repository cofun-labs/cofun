// Loading from Notion what several tools need: a page with its database and the people and pages it
// mentions, a database's data source, and the workspace of the open page.
import {
  NotionError,
  fieldsOf,
  mergeRecordMaps,
  textList,
  type Block,
  type LoadedPage,
  type NotionRecord,
  type RecordMap,
} from '../notion/api'
import { collectionId, unnamedMentions, unnamedRowMentions, type Schema } from '../notion/markdown'
import { notionUserIn, type NotionTab } from '../notion/tab'
import { runsText } from '../notion/tree'
import { PARTS_PAGES, PARTS_REUSE_MS, pageWorkspaces, recentReads, type Loaded } from './memory'

/**
 * Part 1 always reads the page fresh. Later parts reuse that read for a while, so reading a long
 * page part by part loads it once, and the parts fit together even if the page changes meanwhile.
 */
export async function loadForPart(tab: NotionTab, id: string, part: number): Promise<Loaded> {
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

/**
 * Loads a page, and for a database row also its database, which names the row's properties. People
 * and pages it mentions that the page's load left out are loaded too, so they show by name.
 */
async function loadWithDatabase(tab: NotionTab, id: string): Promise<Loaded> {
  const loaded = await tab.client.loadPage(id)
  const { page, spaceId, recordMap } = loaded
  let databaseMissing = false
  if (page.parent_table === 'collection' && page.parent_id && !recordMap.collection?.[page.parent_id]) {
    try {
      mergeRecordMaps(recordMap, await tab.client.getRecords([{ table: 'collection', id: page.parent_id, spaceId }]))
    } catch (err) {
      // A row can be shared with someone who can't open its database; the row itself still reads.
      if (!(err instanceof NotionError && (err.code === 'no_access' || err.code === 'in_trash'))) throw err
      databaseMissing = true
    }
  }
  return { loaded, databaseMissing }
}

/** Adds the people and pages `loaded` mentions but doesn't hold to it; ones out of reach stay unnamed. */
export async function loadMentioned(tab: NotionTab, loaded: LoadedPage): Promise<void> {
  const missing = unnamedMentions(loaded)
  if (!missing.length) return
  try {
    mergeRecordMaps(loaded.recordMap, await tab.client.findRecords(missing))
  } catch (err) {
    // Only names: records the account can't open (a page in another workspace, say) stay unnamed,
    // as when Notion leaves them out. Anything else, a rate limit included, still stops the read.
    if (!(err instanceof NotionError && (err.code === 'no_access' || err.code === 'in_trash'))) throw err
  }
}

/**
 * Adds the pages and people `rows` mention but `recordMap` lacks; ones out of reach stay unnamed.
 * Returns how many weren't looked up, past the lookup's limit.
 */
export async function loadRowMentions(
  tab: NotionTab,
  recordMap: RecordMap,
  rows: Block[],
  spaceId: string,
): Promise<number> {
  const { pointers, left } = unnamedRowMentions(recordMap, rows, spaceId)
  if (!pointers.length) return left
  try {
    mergeRecordMaps(recordMap, await tab.client.findRecords(pointers))
  } catch (err) {
    // As in loadMentioned: only names, so records the account can't open stay unnamed.
    if (!(err instanceof NotionError && (err.code === 'no_access' || err.code === 'in_trash'))) throw err
  }
  return left
}

/** A database's data source: its collection, the workspace it lives in, its schema, and its views. */
export async function resolveDatabase(client: NotionTab['client'], block: Block) {
  const id = collectionId(block)
  if (!id) throw new Error('This database has no data source.')
  // A linked view's database may live in another workspace; its pointer says which. The pointer's
  // workspace is taken as it came, not read loosely: this id goes on requests and writes, and one
  // that is not a Notion id is refused there rather than replaced by the block's own workspace.
  const pointed = fieldsOf(block.format?.collection_pointer)?.spaceId
  const spaceId = String(block.collection_id ? block.space_id : (pointed ?? block.space_id))
  const collection = (await client.getRecords([{ table: 'collection', id, spaceId }])).collection![id]
  return {
    collectionId: id,
    spaceId,
    schema: (collection.schema ?? {}) as Schema,
    name: runsText(collection.name) || 'Untitled database',
    views: textList(block.view_ids),
  }
}

/** Open pages whose workspace is remembered at most; the one used longest ago is forgotten first. */
const WORKSPACE_PAGES = 20

/** The workspace of the page open in the tab, which must show one. */
export async function workspaceOf(tab: NotionTab): Promise<string> {
  const pageId = tab.pageId!
  // Remembered for the tab's Notion user only: after the tab switched accounts, the page is looked
  // up again as the new one, which may not open it. Without a user, nothing is remembered.
  const user = await notionUserIn(tab.tabId)
  const key = user ? `${tab.tabId}:${user}:${pageId}` : undefined
  const known = key ? pageWorkspaces.get(key) : undefined
  if (key && known) {
    pageWorkspaces.delete(key)
    pageWorkspaces.set(key, known)
    return known
  }
  let spaceId: string | undefined
  try {
    const opened = await tab.client.getRecords([{ table: 'block', id: pageId }])
    spaceId = opened.block?.[pageId]?.space_id
  } catch (err) {
    if (err instanceof NotionError && err.code === 'in_trash') {
      throw new Error('The open page is in the trash. Open another page of the workspace.')
    }
    throw err
  }
  if (!spaceId) throw new Error('Could not tell which workspace the open page is in.')
  if (key) {
    pageWorkspaces.set(key, spaceId)
    if (pageWorkspaces.size > WORKSPACE_PAGES) pageWorkspaces.delete(pageWorkspaces.keys().next().value!)
  }
  return spaceId
}

/** Names of the databases among `blocks`, by block id; databases that can't be looked up are left out. */
export async function databaseNames(tab: NotionTab, blocks: (Block | undefined)[]): Promise<Map<string, string>> {
  const databases = blocks.filter(
    (b): b is Block => !!b && (b.type === 'collection_view_page' || b.type === 'collection_view'),
  )
  const ids = [...new Set(databases.map(collectionId).filter((id): id is string => !!id))]
  const names = new Map<string, string>()
  if (!ids.length) return names
  // All in one request. Notion answers for each record on its own, leaving out one the account
  // can't open (say, a linked view's source in another workspace), so only that name is left out.
  // No workspace is assumed, since a linked view's source may be in another one.
  let collections: Record<string, NotionRecord>
  try {
    collections =
      (await tab.client.findRecords(ids.map((id) => ({ table: 'collection' as const, id })))).collection ?? {}
  } catch (err) {
    // Notion refusing the whole lookup leaves every name out; anything else isn't understood, so it stops the search.
    if (err instanceof NotionError && err.code === 'no_access') return names
    throw err
  }
  for (const b of databases) {
    const name = runsText(collections[collectionId(b) ?? '']?.name)
    if (name) names.set(b.id, name)
  }
  return names
}
