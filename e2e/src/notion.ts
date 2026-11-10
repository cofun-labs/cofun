// Throwaway pages and databases for ai-e2e runs, made through Notion's internal API from the tool's
// own Notion tab, as its signed-in user. Requests run in an isolated world of that tab with the
// extension's own request function, so they look exactly like the extension's.
import { type NotionRecord, type Operation, checkResponse, normalizeRecordMap } from '../../extension/src/notion/api'
import { type NewBlock, parseMarkdown } from '../../extension/src/notion/blocks'
import { planNewPage } from '../../extension/src/notion/edit'
import { NOTION_HOSTS, pageIdFromUrl } from '../../extension/src/notion/hosts'
import { notionRequest } from '../../extension/src/notion/tab'
import type { Target } from './cdp'
import { E2eError } from './errors'

/** Where a private page goes: the workspace, and the user's own view of it (their Private section). */
export interface PrivateSpace {
  spaceId: string
  spaceViewId: string
  userId: string
}

type Post = (endpoint: string, body: unknown, spaceId?: string) => Promise<Record<string, unknown>>

/** Sends Notion requests from `tab` as its signed-in user. */
export async function tabPost(tab: Target): Promise<Post> {
  const world = await tab.isolatedWorld('notion-copilot-e2e')
  return async (endpoint, body, spaceId) => {
    const res = await tab.evaluate(notionRequest, [endpoint, body, spaceId ?? null, NOTION_HOSTS, 30_000], {
      contextId: world,
    })
    if ('notOnNotion' in res) throw new E2eError('The Notion tab is not on Notion any more.')
    return checkResponse(res)
  }
}

/**
 * The workspace of the page the tab shows, or the user's only workspace when it shows none, with the
 * view of it of the tab's own Notion user (`userId`, from the tab), when known.
 */
export async function privateSpace(post: Post, tabUrl: string, userId?: string): Promise<PrivateSpace> {
  const pageId = pageIdFromUrl(tabUrl)
  const spaceId = pageId ? (await getBlock(post, pageId))?.space_id : undefined
  return findSpaceView(await post('getSpaces', {}), spaceId, userId)
}

async function getBlock(post: Post, id: string): Promise<NotionRecord | undefined> {
  const res = await post('syncRecordValuesMain', { requests: [{ pointer: { table: 'block', id }, version: -1 }] })
  return normalizeRecordMap(res.recordMap).block?.[id]
}

/**
 * Picks the workspace and the user's view of it from getSpaces' answer: one record map per signed-in
 * user, each with a `user_root` listing that user's workspace views.
 */
export function findSpaceView(spaces: Record<string, unknown>, spaceId?: string, tabUser?: string): PrivateSpace {
  const found: PrivateSpace[] = []
  for (const [userId, raw] of Object.entries(spaces)) {
    // Several signed-in accounts may share a workspace; the page belongs to the tab's account.
    if (tabUser && userId !== tabUser) continue
    const map = normalizeRecordMap(raw) as Record<string, Record<string, Record<string, unknown>> | undefined>
    const pointers = map.user_root?.[userId]?.space_view_pointers
    if (!Array.isArray(pointers)) continue
    for (const p of pointers as { id?: unknown; spaceId?: unknown }[]) {
      if (typeof p.id !== 'string' || typeof p.spaceId !== 'string') continue
      if (!spaceId || p.spaceId === spaceId) found.push({ spaceId: p.spaceId, spaceViewId: p.id, userId })
    }
  }
  if (found.length === 1) return found[0]
  if (!found.length) throw new E2eError("Couldn't find the workspace of the Notion tab.")
  throw new E2eError('This Notion account has several workspaces: open a page of the one to use, with pnpm e2e panel.')
}

/** Moves a new top-level page into the user's Private section, as Notion's own client does. */
function moveToPrivate(space: PrivateSpace, pageId: string): Operation {
  return {
    pointer: { table: 'block', id: pageId, spaceId: space.spaceId },
    path: [],
    command: 'moveToPrivate',
    args: {
      spaceViewPointer: { id: space.spaceViewId, table: 'space_view', spaceId: space.spaceId },
      userId: space.userId,
    },
  } as unknown as Operation
}

/** The operations creating a private page titled `title` that holds `blocks`. */
export function privatePageOps(
  space: PrivateSpace,
  title: string,
  blocks: NewBlock[],
  options: Parameters<typeof planNewPage>[4] = {},
): { operations: Operation[]; pageId: string } {
  // The extension's own planner, with no parent: moveToPrivate puts the page in the workspace and
  // in the user's Private section.
  const { operations, pageId } = planNewPage(undefined, space.spaceId, title, blocks, options)
  return { operations: [...operations, moveToPrivate(space, pageId)], pageId }
}

export const STATUSES = ['Not started', 'In progress', 'Done']
const STATUS = 'st:x'
const DUE = 'du:x'

export interface TaskRow {
  name: string
  status?: string
  due?: string
}

/** A row argument: "name|status|YYYY-MM-DD", status and date optional. */
export function parseRow(text: string): TaskRow {
  const [name, status, due, ...extra] = text.split('|').map((s) => s.trim())
  if (!name || extra.length) throw new E2eError(`Not a row: "${text}". Write "name|status|YYYY-MM-DD".`)
  if (status && !STATUSES.includes(status)) {
    throw new E2eError(`Not a status: "${status}". Use one of: ${STATUSES.join(', ')}.`)
  }
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new E2eError(`Not a date: "${due}". Write YYYY-MM-DD.`)
  return { name, ...(status ? { status } : {}), ...(due ? { due } : {}) }
}

/** The operations creating a private task database (Name, Status, Due) with `rows`. */
export function taskDatabaseOps(
  space: PrivateSpace,
  title: string,
  rows: TaskRow[],
  { now = Date.now(), newId = () => crypto.randomUUID() } = {},
): { operations: Operation[]; pageId: string } {
  const { spaceId } = space
  const pageId = newId()
  const collectionId = newId()
  const viewId = newId()
  const base = { version: 1, alive: true, space_id: spaceId }
  const times = { created_time: now, last_edited_time: now }
  const set = (table: 'block' | 'collection' | 'collection_view', id: string, args: object): Operation => ({
    pointer: { table, id, spaceId },
    path: [],
    command: 'set',
    args: { id, ...base, ...args },
  })
  const schema = {
    title: { name: 'Name', type: 'title' },
    [STATUS]: {
      name: 'Status',
      type: 'select',
      options: STATUSES.map((value, i) => ({ id: `s${i}`, value, color: ['gray', 'blue', 'green'][i] })),
    },
    [DUE]: { name: 'Due', type: 'date' },
  }
  const operations: Operation[] = [
    set('block', pageId, { ...times, type: 'collection_view_page', collection_id: collectionId, view_ids: [viewId] }),
    set('collection', collectionId, { parent_id: pageId, parent_table: 'block', name: [[title]], schema }),
    set('collection_view', viewId, {
      type: 'table',
      name: 'Table',
      parent_id: pageId,
      parent_table: 'block',
      format: { collection_pointer: { id: collectionId, table: 'collection', spaceId } },
    }),
  ]
  for (const row of rows) {
    const properties: Record<string, unknown> = { title: [[row.name]] }
    if (row.status) properties[STATUS] = [[row.status]]
    if (row.due) properties[DUE] = [['‣', [['d', { type: 'date', start_date: row.due }]]]]
    // A row's parent is the collection, which lists its rows itself.
    operations.push(
      set('block', newId(), {
        ...times,
        type: 'page',
        parent_id: collectionId,
        parent_table: 'collection',
        properties,
      }),
    )
  }
  operations.push(moveToPrivate(space, pageId))
  return { operations, pageId }
}

export async function transact(post: Post, spaceId: string, operations: Operation[]): Promise<void> {
  await post(
    'saveTransactionsFanout',
    {
      requestId: crypto.randomUUID(),
      transactions: [{ id: crypto.randomUUID(), spaceId, debug: { userAction: 'notion-copilot e2e' }, operations }],
    },
    spaceId,
  )
}

/**
 * Creates a private page and returns its id. `beforeWrite` hears the id before anything is sent, so
 * the caller can remember it even if the command is interrupted or Notion doesn't answer.
 */
export async function createPage(
  post: Post,
  space: PrivateSpace,
  title: string,
  markdown: string,
  beforeWrite: (id: string) => Promise<void>,
): Promise<string> {
  const { operations, pageId } = privatePageOps(space, title, parseMarkdown(markdown))
  await beforeWrite(pageId)
  await transact(post, space.spaceId, operations)
  return pageId
}

/** Creates a private task database and returns its id; `beforeWrite` as for createPage. */
export async function createDatabase(
  post: Post,
  space: PrivateSpace,
  title: string,
  rows: TaskRow[],
  beforeWrite: (id: string) => Promise<void>,
): Promise<string> {
  const { operations, pageId } = taskDatabaseOps(space, title, rows)
  await beforeWrite(pageId)
  await transact(post, space.spaceId, operations)
  return pageId
}

/**
 * Moves a top-level page to the trash, as Notion's "Move to Trash" does. `missing`: there is no such
 * page, for example because the command creating it was interrupted before Notion saved it.
 */
export async function trash(post: Post, pageId: string): Promise<'trashed' | 'missing'> {
  const page = await getBlock(post, pageId)
  if (!page?.space_id) return 'missing'
  if (page.alive === false) return 'trashed'
  const spaceId = page.space_id
  if (page.parent_table !== 'space' || !page.parent_id) {
    throw new E2eError(`The page is no longer at the top of the workspace (its parent is a ${page.parent_table}).`)
  }
  await transact(post, spaceId, [
    {
      pointer: { table: 'space', id: page.parent_id, spaceId },
      path: ['pages'],
      command: 'removeChild',
      args: { id: pageId },
    } as unknown as Operation,
  ])
  await post(
    'deleteContentRecords',
    { records: [{ table: 'block', id: pageId, spaceId }], permanentlyDelete: false },
    spaceId,
  )
  return 'trashed'
}

/** The link to a page, on the tab's host. */
export function pageUrl(tabUrl: string, pageId: string): string {
  return `${new URL(tabUrl).origin}/p/${pageId.replace(/-/g, '')}`
}
