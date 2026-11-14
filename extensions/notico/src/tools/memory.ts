// What the agent remembers between calls: the pages it read, the rows and databases it saw, and
// cached loads. A new or another conversation forgets it all (see forgetReads).
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
export const PARTS_REUSE_MS = 5 * 60_000
/** Pages whose part 1 was read last, so reading two long pages in turn keeps both. */
export const PARTS_PAGES = 5
export const recentReads = new Map<string, { at: number; result: Loaded }>()

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
export const seenRows = new Map<string, SeenRow>()
/** The databases query_database read, by block id: their names. */
export const seenDatabases = new Map<string, string>()

export function keep<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key)
  map.set(key, value)
  if (map.size > SEEN_KEPT) map.delete(map.keys().next().value!)
}

/** The last read of each page, by page id: what edit_page checks edits against. */
export const pageReads = new Map<string, PageRead>()
/** The parts of each page read since its part 1 was. */
export const partsRead = new Map<string, Set<number>>()
/** Counts the times reads were forgotten, so a read that ends after that isn't kept. */
export let generation = 0

/** Forgets what the agent read, for a new or another conversation, which must read pages itself. */
export function forgetReads(): void {
  generation++
  pageReads.clear()
  partsRead.clear()
  recentReads.clear()
  seenRows.clear()
  seenDatabases.clear()
  pageWorkspaces.clear()
}

/** How many pages' reads are kept; the oldest go first. */
const READS_KEPT = 20

/**
 * Keeps a read, as the most recent one, unless reads were forgotten since `since` (the conversation
 * changed while it was being made).
 */
export function remember(read: PageRead, since = generation) {
  if (since !== generation) return
  pageReads.delete(read.pageId)
  pageReads.set(read.pageId, read)
  if (pageReads.size > READS_KEPT) {
    const oldest = pageReads.keys().next().value!
    pageReads.delete(oldest)
    partsRead.delete(oldest)
  }
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
    for (const key of recentReads.keys()) if (key.endsWith(`:${id}`)) recentReads.delete(key)
    for (const key of pageWorkspaces.keys()) if (key.endsWith(`:${id}`)) pageWorkspaces.delete(key)
  }
}

/**
 * Workspace ids of open pages, by tab, Notion user, and page (in that order, so a key ends with the
 * page id), so searching or listing from the same page doesn't look it up again.
 */
export const pageWorkspaces = new Map<string, string>()
