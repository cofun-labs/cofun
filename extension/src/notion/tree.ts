// Listing pages as Notion's sidebar shows them: titles and ids, level by level, without content.
import type { NotionClient, NotionRecord, RecordMap } from './api'
import { PAGE_TYPES, hexId } from './markdown'

export interface TreeNode {
  id: string
  title: string
  database: boolean
  children: TreeNode[]
}

/** Blocks that only lay out their children: pages inside them count as the page's own. */
const LAYOUT_TYPES = new Set(['column_list', 'column'])

/**
 * Builds the tree under `roots` (page ids, in order), `depth` levels deep, with at most `limit`
 * entries. Each level costs one request (plus one per layout level, and one for database names).
 */
export async function pageTree(
  client: NotionClient,
  roots: string[],
  depth: number,
  limit: number,
  /** Records already loaded; more are added as the tree is built. */
  records: RecordMap = {},
): Promise<{ nodes: TreeNode[]; truncated: boolean }> {
  let count = 0
  let truncated = false
  const unknown = roots.filter((id) => !records.block?.[id])
  if (unknown.length) merge(records, await client.findRecords(unknown.map((id) => ({ table: 'block', id }))))
  const top = await nodesFor(client, roots, records)
  const nodes = take(top)
  let level = nodes
  for (let d = 1; d < depth && level.length && !truncated; d++) {
    // Children of pages only: a database's rows aren't sidebar pages.
    const parents = level.filter((n) => !n.database)
    const childIds = await pageChildren(
      client,
      parents.map((n) => n.id),
      records,
    )
    // Every child of this level at once, so database names cost one request per level.
    const all = await nodesFor(
      client,
      parents.flatMap((p) => childIds.get(p.id) ?? []),
      records,
    )
    const byId = new Map(all.map((n) => [n.id, n]))
    const next: TreeNode[] = []
    for (const parent of parents) {
      const kids = (childIds.get(parent.id) ?? []).map((id) => byId.get(id)).filter((n): n is TreeNode => !!n)
      parent.children = take(kids.map((n) => ({ ...n, children: [] })))
      next.push(...parent.children)
    }
    level = next
  }
  return { nodes, truncated }

  function take(list: TreeNode[]): TreeNode[] {
    const room = Math.max(0, limit - count)
    if (list.length > room) truncated = true
    const kept = list.slice(0, room)
    count += kept.length
    return kept
  }
}

/** The sidebar pages among `ids`, as nodes, using and adding to `records`. */
async function nodesFor(client: NotionClient, ids: string[], records: RecordMap): Promise<TreeNode[]> {
  const blocks = (ids: string[]) => ids.map((id) => records.block?.[id]).filter((b): b is NotionRecord => !!b)
  const pages = blocks(ids).filter((b) => PAGE_TYPES.has(String(b.type)))
  // Databases are named by their collection.
  const collections = pages.map((b) => collectionId(b)).filter((id): id is string => !!id && !records.collection?.[id])
  if (collections.length)
    merge(records, await client.findRecords(collections.map((id) => ({ table: 'collection', id }))))
  return pages.map((b) => {
    const database = b.type !== 'page'
    const collection = database ? records.collection?.[collectionId(b) ?? ''] : undefined
    const title = runsText(database ? collection?.name : (b.properties as { title?: unknown } | undefined)?.title)
    return { id: b.id, title: title || (database ? 'Untitled database' : 'Untitled'), database, children: [] }
  })
}

/** The ids of blocks directly under each parent, looking through layout blocks, in order. */
export async function pageChildren(
  client: NotionClient,
  parents: string[],
  records: RecordMap,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  // Each parent's list as it is resolved; layout blocks are replaced by what they hold.
  let pending = new Map(parents.map((p) => [p, contentOf(records, p)]))
  for (let hop = 0; hop < 3 && pending.size; hop++) {
    const missing = [...new Set([...pending.values()].flat())].filter((id) => !records.block?.[id])
    if (missing.length) merge(records, await client.findRecords(missing.map((id) => ({ table: 'block', id }))))
    const again = new Map<string, string[]>()
    for (const [parent, ids] of pending) {
      const flat: string[] = []
      let layouts = false
      for (const id of ids) {
        const block = records.block?.[id]
        if (block && LAYOUT_TYPES.has(String(block.type))) {
          flat.push(...contentOf(records, id))
          layouts = true
        } else flat.push(id)
      }
      if (layouts) again.set(parent, flat)
      else out.set(parent, flat)
    }
    pending = again
  }
  for (const [parent, ids] of pending) out.set(parent, ids)
  return out
}

function contentOf(records: RecordMap, id: string): string[] {
  const content = records.block?.[id]?.content
  return Array.isArray(content) ? content.filter((c): c is string => typeof c === 'string') : []
}

function collectionId(block: NotionRecord): string | undefined {
  const pointer = (block.format as { collection_pointer?: { id?: string } } | undefined)?.collection_pointer
  return (block.collection_id as string | undefined) ?? pointer?.id
}

function merge(into: RecordMap, from: RecordMap) {
  for (const [table, recs] of Object.entries(from))
    Object.assign(((into as Record<string, object>)[table] ??= {}), recs)
}

function runsText(value: unknown): string {
  return Array.isArray(value) ? value.map((r) => (Array.isArray(r) ? String(r[0]) : '')).join('') : ''
}

/** The tree as an indented list, one entry per line, each with its page id. */
export function treeLines(nodes: TreeNode[], indent = ''): string[] {
  return nodes.flatMap((n) => [
    `${indent}- ${n.database ? '🗃' : '📄'} ${n.title} ^${hexId(n.id)}`,
    ...treeLines(n.children, `${indent}  `),
  ])
}
