// What the tools remember of one conversation between calls: the pages it read, the rows and
// databases it saw, the workspaces of the pages open while it ran, and what its question carries.
// Each agent has its own (CopilotAgent.memory), which it gives every call in its ToolContext, so each
// chat has its own: a late call of a chat the user left changes only that chat's memory, and a
// chat opened again starts with nothing read. The maps are the class's own: tools read and change
// them only through its methods.
import type { PageRead } from '../notion/edit'
import type { Schema } from '../notion/markdown'
import type { ToolMemory } from '@cofun/app/tools/memory'
export { ToolMemory } from '@cofun/app/tools/memory'

/** How many rows and databases the agent saw are remembered, for previews; the oldest go first. */
const SEEN_KEPT = 500
/** How many pages' reads are kept; the oldest go first. */
const READS_KEPT = 20
/** Open pages whose workspace is remembered at most; the one used longest ago is forgotten first. */
const WORKSPACE_PAGES = 20

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

function keep<T>(map: Map<string, T>, key: string, value: T, kept: number) {
  map.delete(key)
  map.set(key, value)
  if (map.size > kept) map.delete(map.keys().next().value!)
}

class NotionMemory {
  /** The last read of each page, by page id: what edit_page checks edits against. */
  private readonly pageReads = new Map<string, PageRead>()
  /** The rows query_database showed, by row id. */
  private readonly seenRows = new Map<string, SeenRow>()
  /** The databases query_database read, by block id: their names. */
  private readonly seenDatabases = new Map<string, string>()
  /**
   * Workspace ids of open pages, by tab, Notion user, and page (in that order, so a key ends with the
   * page id), so searching or listing from the same page doesn't look it up again.
   */
  private readonly pageWorkspaces = new Map<string, string>()
  /** Keeps a read, as the most recent one. */
  remember(read: PageRead): void {
    keep(this.pageReads, read.pageId, read, READS_KEPT)
  }

  /** The page as the agent last read it, if it did. */
  lastRead(id: string): PageRead | undefined {
    return this.pageReads.get(id)
  }

  /** Forgets the agent's read of a page, so the page must be read again before it is edited. */
  forgetRead(id: string): void {
    this.pageReads.delete(id)
  }

  /** Gives a page's read the title the page has now, since later previews show it. */
  renameRead(id: string, title: string): void {
    const read = this.pageReads.get(id)
    if (read) read.title = title
  }

  /** A row as query_database last showed it, if it did. */
  seenRow(id: string): SeenRow | undefined {
    return this.seenRows.get(id)
  }

  /** Keeps a row as query_database showed it. */
  keepSeenRow(id: string, row: SeenRow): void {
    keep(this.seenRows, id, row, SEEN_KEPT)
  }

  /** Forgets a row the agent saw: it changed. */
  forgetSeenRow(id: string): void {
    this.seenRows.delete(id)
  }

  /** A database's name, as the agent last saw it, if it saw one. */
  seenDatabase(id: string): string | undefined {
    return this.seenDatabases.get(id)
  }

  /** Keeps a database's name, as the agent saw it. */
  keepSeenDatabase(id: string, name: string): void {
    keep(this.seenDatabases, id, name, SEEN_KEPT)
  }

  /** The workspace of an open page, remembered by tab, Notion user, and page; using it keeps it longer. */
  knownWorkspace(key: string): string | undefined {
    const known = this.pageWorkspaces.get(key)
    if (known) keep(this.pageWorkspaces, key, known, WORKSPACE_PAGES)
    return known
  }

  /** Remembers the workspace of an open page. */
  keepWorkspace(key: string, spaceId: string): void {
    this.pageWorkspaces.set(key, spaceId)
    if (this.pageWorkspaces.size > WORKSPACE_PAGES) this.pageWorkspaces.delete(this.pageWorkspaces.keys().next().value!)
  }

  /** A page's title as the agent last saw it, if it saw one. */
  knownTitle(id: string): string | undefined {
    return this.pageReads.get(id)?.title ?? this.seenRows.get(id)?.title ?? this.seenDatabases.get(id)
  }

  /** Forgets what the agent cached of these pages, which a move, copy, or trash changed. */
  forgetPages(ids: Iterable<string>): void {
    for (const id of ids) {
      this.pageReads.delete(id)
      this.seenRows.delete(id)
      for (const key of this.pageWorkspaces.keys()) if (key.endsWith(`:${id}`)) this.pageWorkspaces.delete(key)
    }
  }
}

const caches = new WeakMap<ToolMemory, NotionMemory>()

export function notionMemory(memory: ToolMemory): NotionMemory {
  let cache = caches.get(memory)
  if (!cache) {
    cache = new NotionMemory()
    caches.set(memory, cache)
  }
  return cache
}
