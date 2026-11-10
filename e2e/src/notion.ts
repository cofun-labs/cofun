// Throwaway pages and databases for ai-e2e runs, made through the extension's own NotionClient from
// the tool's Notion tab, as its signed-in user. Requests run in an isolated world of that tab with
// the extension's own request function, so they look exactly like the extension's.
import {
  NO_NOTION_TAB,
  NotionClient,
  NotionError,
  type NotionRecord,
  type NotionTransport,
  type Operation,
  type SpaceView,
  blockOps,
  checkResponse,
} from '../../extension/src/notion/api'
import { type NewBlock, parseMarkdown } from '../../extension/src/notion/blocks'
import { planNewPage } from '../../extension/src/notion/edit'
import { propertyValue } from '../../extension/src/notion/props'
import { NOTION_HOSTS, pageIdFromUrl } from '../../extension/src/notion/hosts'
import { notionRequest } from '../../extension/src/notion/tab'
import type { Target } from './cdp'
import { E2eError } from './errors'

/** Where a private page goes: the workspace, and the user's own view of it (their Private section). */
export type PrivateSpace = SpaceView

/** Notion as the tab's signed-in user: the extension's client, and its transport for what it lacks. */
export interface TabNotion {
  client: NotionClient
  send: NotionTransport
}

/** Sends Notion requests from `tab`, like the extension's tabTransport does from its own tab. */
export async function tabNotion(tab: Target): Promise<TabNotion> {
  const world = await tab.isolatedWorld('notion-copilot-e2e')
  const send: NotionTransport = async (endpoint, body, { spaceId }) => {
    const res = await tab.evaluate(notionRequest, [endpoint, body, spaceId ?? null, NOTION_HOSTS, 30_000], {
      contextId: world,
    })
    if ('notOnNotion' in res) throw new NotionError('no_notion_tab', NO_NOTION_TAB)
    return res
  }
  return { client: new NotionClient(send), send }
}

/**
 * The workspace of the page the tab shows, or the user's only workspace when it shows none, with the
 * view of it of the tab's own Notion user (`userId`, from the tab), when known.
 */
export async function privateSpace(client: NotionClient, tabUrl: string, userId?: string): Promise<PrivateSpace> {
  const pageId = pageIdFromUrl(tabUrl)
  const spaceId = pageId
    ? (await client.findRecords([{ table: 'block', id: pageId }])).block?.[pageId]?.space_id
    : undefined
  return findSpaceView(await client.spaceViews(), spaceId, userId)
}

/** Picks the view of the workspace asked for (or the only one), of the tab's user when known. */
export function findSpaceView(views: SpaceView[], spaceId?: string, tabUser?: string): PrivateSpace {
  // Several signed-in accounts may share a workspace; the page belongs to the tab's account.
  const found = views.filter((v) => (!tabUser || v.userId === tabUser) && (!spaceId || v.spaceId === spaceId))
  if (found.length === 1) return found[0]
  if (!found.length) throw new E2eError("Couldn't find the workspace of the Notion tab.")
  throw new E2eError('This Notion account has several workspaces: set E2E_NOTION_URL to a page in the one to use.')
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
  return { operations: [...operations, blockOps(space.spaceId, Date.now()).moveToPrivate(pageId, space)], pageId }
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
  const op = blockOps(space.spaceId, now)
  const ids = { page: newId(), collection: newId(), view: newId() }
  const schema = {
    title: { name: 'Name', type: 'title' },
    [STATUS]: {
      name: 'Status',
      type: 'select',
      options: STATUSES.map((value, i) => ({ id: `s${i}`, value, color: ['gray', 'blue', 'green'][i] })),
    },
    [DUE]: { name: 'Due', type: 'date' },
  }
  const operations = op.createDatabase(ids, title, schema)
  for (const row of rows) {
    // Values the way the extension writes them, checked against the schema.
    const properties: Record<string, unknown> = { title: propertyValue(schema.title, row.name) }
    if (row.status) properties[STATUS] = propertyValue(schema[STATUS], row.status)
    if (row.due) properties[DUE] = propertyValue(schema[DUE], row.due)
    operations.push(op.create(newId(), 'page', ids.collection, { properties, parent_table: 'collection' }))
  }
  operations.push(op.moveToPrivate(ids.page, space))
  return { operations, pageId: ids.page }
}

const USER_ACTION = 'notion-copilot e2e'

/**
 * Creates a private page and returns its id. `beforeWrite` hears the id before anything is sent, so
 * the caller can remember it even if the command is interrupted or Notion doesn't answer.
 */
export async function createPage(
  { client }: TabNotion,
  space: PrivateSpace,
  title: string,
  markdown: string,
  beforeWrite: (id: string) => Promise<void>,
): Promise<string> {
  const { operations, pageId } = privatePageOps(space, title, parseMarkdown(markdown))
  await beforeWrite(pageId)
  await client.submitTransaction(space.spaceId, operations, USER_ACTION)
  return pageId
}

/** Creates a private task database and returns its id; `beforeWrite` as for createPage. */
export async function createDatabase(
  { client }: TabNotion,
  space: PrivateSpace,
  title: string,
  rows: TaskRow[],
  beforeWrite: (id: string) => Promise<void>,
): Promise<string> {
  const { operations, pageId } = taskDatabaseOps(space, title, rows)
  await beforeWrite(pageId)
  await client.submitTransaction(space.spaceId, operations, USER_ACTION)
  return pageId
}

/**
 * Moves a top-level page to the trash, as Notion's "Move to Trash" does. `missing`: there is no such
 * page, for example because the command creating it was interrupted before Notion saved it.
 */
export async function trash({ client, send }: TabNotion, pageId: string): Promise<'trashed' | 'missing'> {
  let page: NotionRecord | undefined
  try {
    page = (await client.getRecords([{ table: 'block', id: pageId }])).block?.[pageId]
  } catch (err) {
    // Already in the trash, or never saved: nothing to do either way.
    if (err instanceof NotionError && err.code === 'in_trash') return 'trashed'
    if (err instanceof NotionError && err.code === 'no_access') return 'missing'
    throw err
  }
  if (!page?.space_id) return 'missing'
  const spaceId = page.space_id
  if (page.parent_table !== 'space' || !page.parent_id) {
    throw new E2eError(`The page is no longer at the top of the workspace (its parent is a ${page.parent_table}).`)
  }
  const remove: Operation = {
    pointer: { table: 'space', id: page.parent_id, spaceId },
    path: ['pages'],
    command: 'removeChild',
    args: { id: pageId },
  }
  await client.submitTransaction(spaceId, [remove], USER_ACTION)
  // NotionClient has no call for this yet (the agent's own trash tool brings one); same shape as
  // Notion's own "Move to Trash".
  checkResponse(
    await send(
      'deleteContentRecords',
      { records: [{ table: 'block', id: pageId, spaceId }], permanentlyDelete: false },
      { spaceId },
    ),
  )
  return 'trashed'
}

/** The link to a page, on the tab's host. */
export function pageUrl(tabUrl: string, pageId: string): string {
  return `${new URL(tabUrl).origin}/p/${pageId.replace(/-/g, '')}`
}
