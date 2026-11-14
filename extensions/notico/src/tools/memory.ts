// What the agent remembers between calls: the pages it read, the rows and databases it saw, and
// cached loads. A new or another conversation forgets it all (see forgetReads). The maps are this
// module's own: tools read and change them only through the functions below.
import type { LoadedPage } from '../notion/api'
import type { PageRead } from '../notion/edit'
import type { Schema } from '../notion/markdown'

export interface Loaded {
  loaded: LoadedPage
  databaseMissing: boolean
  /** A later part was read from a fresh load, not from the read of part 1. */
  reloaded?: boolean
}

/** How long the parts after the first come from the page as it was when part 1 was read. */
const PARTS_REUSE_MS = 5 * 60_000
/** Pages whose part 1 was read last, so reading two long pages in turn keeps both. */
const PARTS_PAGES = 5
/** Loads of part 1 of a page, by tab and page id (`<tab>:<page>`, so a key ends with the page id). */
const recentReads = new Map<string, { at: number; result: Loaded }>()

/** How many rows and databases the agent saw are remembered, for previews; the oldest go first. */
const SEEN_KEPT = 500
/**
 * A row query_database showed: its title and values as shown, its database's schema, and the date
 * properties (by name, lowercase) whose date has a reminder, which query_database doesn't show.
 */
export interface SeenRow {
  title: string
  values: { name: string; value: string }[]
  schema: Schema
  reminders: Set<string>
}

/** The rows query_database showed, by row id. */
const seenRows = new Map<string, SeenRow>()
/** The databases query_database read, by block id: their names. */
const seenDatabases = new Map<string, string>()

function keep<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key)
  map.set(key, value)
  if (map.size > SEEN_KEPT) map.delete(map.keys().next().value!)
}

/** The last read of each page, by page id: what edit_page checks edits against. */
const pageReads = new Map<string, PageRead>()
/** The parts of each page read since its part 1 was. */
const partsRead = new Map<string, Set<number>>()
/** Counts the times reads were forgotten, so a read that ends after that isn't kept. */
let forgotten = 0

/**
 * Workspace ids of open pages, by tab, Notion user, and page (in that order, so a key ends with the
 * page id), so searching or listing from the same page doesn't look it up again.
 */
const pageWorkspaces = new Map<string, string>()
/** Open pages whose workspace is remembered at most; the one used longest ago is forgotten first. */
const WORKSPACE_PAGES = 20

/** Forgets what the agent read, for a new or another conversation, which must read pages itself. */
export function forgetReads(): void {
  forgotten++
  pageReads.clear()
  partsRead.clear()
  recentReads.clear()
  seenRows.clear()
  seenDatabases.clear()
  pageWorkspaces.clear()
}

/**
 * How many times reads were forgotten so far. A call takes it as it starts, and gives it to
 * `remember` and `keepPartsRead`, so a read made while the conversation changed is not kept.
 */
export function generation(): number {
  return forgotten
}

/** How many pages' reads are kept; the oldest go first. */
const READS_KEPT = 20

/**
 * Keeps a read, as the most recent one, unless reads were forgotten since `since` (the conversation
 * changed while it was being made).
 */
export function remember(read: PageRead, since = forgotten) {
  if (since !== forgotten) return
  pageReads.delete(read.pageId)
  pageReads.set(read.pageId, read)
  if (pageReads.size > READS_KEPT) {
    const oldest = pageReads.keys().next().value!
    pageReads.delete(oldest)
    partsRead.delete(oldest)
  }
}

/** The page as the agent last read it, if it did. */
export function lastRead(id: string): PageRead | undefined {
  return pageReads.get(id)
}

/** Forgets the agent's read of a page, so the page must be read again before it is edited. */
export function forgetRead(id: string): void {
  pageReads.delete(id)
}

/** Gives a page's read the title the page has now, since later previews show it. */
export function renameRead(id: string, title: string): void {
  const read = pageReads.get(id)
  if (read) read.title = title
}

/** The parts of a page read since its part 1 was. */
export function partsReadOf(id: string): Set<number> | undefined {
  return partsRead.get(id)
}

/** Keeps which parts of a page were read, unless reads were forgotten since `since`. */
export function keepPartsRead(id: string, parts: Set<number>, since: number): void {
  if (since === forgotten) partsRead.set(id, parts)
}

/** The load of part 1 of a page in a tab, while later parts may still come from it. */
export function freshLoad(key: string): Loaded | undefined {
  const recent = recentReads.get(key)
  return recent && Date.now() - recent.at < PARTS_REUSE_MS ? recent.result : undefined
}

/** Keeps a load of part 1 of a page in a tab, as the most recent one. */
export function keepLoad(key: string, result: Loaded): void {
  recentReads.delete(key)
  recentReads.set(key, { at: Date.now(), result })
  if (recentReads.size > PARTS_PAGES) recentReads.delete(recentReads.keys().next().value!)
}

/** Forgets the cached loads of a page, in every tab: the page changed. */
export function forgetLoads(id: string): void {
  for (const key of recentReads.keys()) if (key.endsWith(`:${id}`)) recentReads.delete(key)
}

/** A row as query_database last showed it, if it did. */
export function seenRow(id: string): SeenRow | undefined {
  return seenRows.get(id)
}

/** Keeps a row as query_database showed it. */
export function keepSeenRow(id: string, row: SeenRow): void {
  keep(seenRows, id, row)
}

/** Forgets a row the agent saw: it changed. */
export function forgetSeenRow(id: string): void {
  seenRows.delete(id)
}

/** A database's name, as the agent last saw it, if it saw one. */
export function seenDatabase(id: string): string | undefined {
  return seenDatabases.get(id)
}

/** Keeps a database's name, as the agent saw it. */
export function keepSeenDatabase(id: string, name: string): void {
  keep(seenDatabases, id, name)
}

/** The workspace of an open page, remembered by tab, Notion user, and page; using it keeps it longer. */
export function knownWorkspace(key: string): string | undefined {
  const known = pageWorkspaces.get(key)
  if (known) {
    pageWorkspaces.delete(key)
    pageWorkspaces.set(key, known)
  }
  return known
}

/** Remembers the workspace of an open page. */
export function keepWorkspace(key: string, spaceId: string): void {
  pageWorkspaces.set(key, spaceId)
  if (pageWorkspaces.size > WORKSPACE_PAGES) pageWorkspaces.delete(pageWorkspaces.keys().next().value!)
}

/** A page's title as the agent last saw it, if it saw one. */
export function knownTitle(id: string): string | undefined {
  return pageReads.get(id)?.title ?? seenRows.get(id)?.title ?? seenDatabases.get(id)
}

/** Forgets what the agent cached of these pages, which a move, copy, or trash changed. */
export function forgetPages(ids: Iterable<string>) {
  for (const id of ids) {
    pageReads.delete(id)
    seenRows.delete(id)
    forgetLoads(id)
    for (const key of pageWorkspaces.keys()) if (key.endsWith(`:${id}`)) pageWorkspaces.delete(key)
  }
}
