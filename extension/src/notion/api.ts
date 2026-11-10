// Notion's internal API, as the signed-in Notion user: the only module that knows Notion's
// endpoints and request shapes. Tools call the typed methods of NotionClient, never fetch.
// The shapes come from the #64 spike (verified against Notion's web client, 2026-11).
// The worker's tests import this file too, so it uses no chrome APIs (see tab.ts for those).
import { toUuid } from './hosts'

/** Why a Notion call failed, for the model and the user. */
export type NotionErrorCode =
  | 'no_notion_tab'
  | 'signed_out'
  | 'no_access'
  | 'notion_error'
  | 'outcome_unknown'
  | 'rate_limited'
  | 'over_budget'

export class NotionError extends Error {
  /** The request may have reached Notion, but no answer came back (timeout, tab closed mid-request). */
  readonly unanswered: boolean
  /** Set when the question must stop here: what the user is told. The agent runs nothing more. */
  readonly stopsQuestion?: string
  /** The failed call may have changed the user's data anyway: always so when the outcome is unknown. */
  readonly mayHaveChanged: boolean

  constructor(
    readonly code: NotionErrorCode,
    message: string,
    options?: { cause?: unknown; unanswered?: boolean; stopsQuestion?: string; mayHaveChanged?: boolean },
  ) {
    super(message, options)
    this.name = 'NotionError'
    this.unanswered = options?.unanswered ?? false
    this.stopsQuestion = options?.stopsQuestion
    this.mayHaveChanged = options?.mayHaveChanged ?? code === 'outcome_unknown'
  }
}

export const NO_NOTION_TAB = 'No Notion page is open in this window.'
export const SIGNED_OUT = 'Not signed in to Notion in this tab. Sign in to Notion and try again.'
export const NO_ACCESS = "The Notion page doesn't exist, or the signed-in Notion account has no access to it."
export const IN_TRASH = 'The Notion page or block is in the trash.'
export const DUPLICATE_UNKNOWN =
  'Notion did not say whether the copy was made: it may still appear. Look for it before trying again.'
export const NO_USER_MAP =
  "Notion's list of workspaces has nothing for the account signed in to this tab. Reload the Notion tab and try again."
export const OUTCOME_UNKNOWN =
  'Notion did not answer, so the change may or may not have been saved. Read the page again before retrying.'
export const RATE_LIMITED = 'Notion turned this request away (too many requests, or too busy), so it was not done.'
export const BUSY_UNKNOWN =
  'Notion said it was too busy, without saying whether the change was saved, so it may or may not have been. Read the page again before retrying.'
export const NOT_SENT = 'Not sent: Notion turned an earlier request away (too many requests, or too busy).'
/**
 * For the user, when Notion turns requests away: the question stops, and nothing more is sent.
 * The agent adds a line when changes may already have been made.
 */
export const LIMITED_STOP =
  'Notion is turning requests away right now (too many requests, or too busy), so Notion Copilot stopped. Wait a minute, then ask again.'

/** Notion requests a question may make before the user is asked whether to go on, and how many more each yes allows. */
export const REQUEST_BUDGET = 100
/** For the model: the request was held at the budget, and the user chose to stop. */
export const OVER_BUDGET =
  'Not sent: this question reached its budget of Notion requests, and the user chose to stop. Do not work around the budget, ' +
  'for example with fewer or smaller requests; tell the user what was done so far instead.'
/** For the user, when they stop a question at its budget. */
export const BUDGET_STOP = 'Stopped: this question reached its budget of Notion requests.'

/** What the user is asked when a question reaches its budget. */
export function budgetQuestion(requests: number): string {
  return `This question has made ${requests} Notion requests. Continue?`
}

/**
 * The Notion requests of one question, across all its tool calls: how many were sent, and whether
 * one could have changed the user's data. Once the question has made `REQUEST_BUDGET` requests, the
 * next one waits until the user is asked whether to go on (`ask`); a yes allows as many again, and a
 * no (or nobody to ask) stops the question, with nothing more sent.
 */
export class NotionUsage {
  /** Requests that went out, or may have: failed ones included, not those known never to have left. */
  requests = 0
  /** A write was sent, and Notion did not say it turned it away: it may have changed data. */
  wrote = false
  /** The people of each workspace (see workspacePeople), loaded once per question, by workspace id. */
  readonly people = new Map<string, Promise<{ id: string; name: string }[] | null>>()
  private budget = REQUEST_BUDGET
  private stopped = false
  /** The question to the user while one is open; requests sent meanwhile wait for the same answer. */
  private asking?: Promise<void>

  constructor(private readonly ask?: (question: string) => Promise<boolean>) {}

  /** Waits until another request may be sent, and counts it; throws when the user stopped at the budget. */
  async admit(): Promise<void> {
    while (!this.stopped && this.requests >= this.budget) await (this.asking ??= this.askToContinue())
    if (this.stopped) throw new NotionError('over_budget', OVER_BUDGET, { stopsQuestion: BUDGET_STOP })
    this.requests++
  }

  /** Takes back a request admitted but known never to have left (say, Chrome refused to run it). */
  unsent(): void {
    this.requests--
  }

  private async askToContinue(): Promise<void> {
    let yes = false
    try {
      yes = (await this.ask?.(budgetQuestion(this.requests))) === true
    } catch (err) {
      console.error('Could not ask whether to continue', err)
    }
    if (yes) this.budget = this.requests + REQUEST_BUDGET
    else this.stopped = true
    this.asking = undefined
  }
}

/** The endpoints under /api/v3/ the client uses. */
export type NotionEndpoint =
  | 'loadPageChunk'
  | 'syncRecordValuesMain'
  | 'saveTransactionsFanout'
  | 'search'
  | 'queryCollection'
  | 'getSpaces'
  | 'enqueueTask'
  | 'getTasks'
  | 'deleteContentRecords'
  | 'getTeamsV2'
  | 'getVisibleUsers'

/** What one request to Notion returned. `error` is set when no HTTP response came back. */
export interface NotionResponse {
  status: number
  json: unknown
  /** The tab's signed-in Notion user (the `notion_user_id` cookie), if it has one. */
  userId?: string
  error?: string
  /** Notion answered with a redirect (likely to a sign-in page), which was not followed. */
  redirected?: boolean
}

/** Sends one request to Notion as the user of a Notion tab (see tab.ts). */
export type NotionTransport = (
  endpoint: NotionEndpoint,
  body: unknown,
  options: { spaceId?: string },
) => Promise<NotionResponse>

export type Table =
  | 'block'
  | 'collection'
  | 'collection_view'
  | 'discussion'
  | 'comment'
  | 'notion_user'
  | 'space'
  | 'space_view'
  | 'team'

/** One record, unwrapped from Notion's `{ spaceId, value: { role, value } }`. */
export interface NotionRecord {
  id: string
  version: number
  alive?: boolean
  space_id?: string
  parent_id?: string
  parent_table?: string
  [field: string]: unknown
}

export interface Block extends NotionRecord {
  type: string
  properties?: Record<string, unknown>
  content?: string[]
  format?: Record<string, unknown>
}

/** Records by table, then by id. */
export type RecordMap = Partial<Record<Table, Record<string, NotionRecord>>>

export interface Pointer {
  table: Table
  id: string
  spaceId?: string
}

/**
 * One write. Only these commands are used: `set` creates a record, `update` changes non-property
 * fields, the list commands edit child lists, and `updateBlockPropertyValue` changes property
 * values, text included. Notion rejects `set` on an existing block's properties. `moveToPrivate`
 * puts a new page at the top of the user's Private section. `insertChildrenAfter` moves existing
 * blocks into a parent: Notion takes them out of their old parent itself. `removeChild` on a
 * page's parent moves the page to the trash.
 */
export interface Operation {
  pointer: Pointer
  path: string[]
  command:
    | 'set'
    | 'update'
    | 'listAfter'
    | 'listBefore'
    | 'listRemove'
    | 'removeChild'
    | 'insertChildrenAfter'
    | 'updateBlockPropertyValue'
    | 'moveToPrivate'
  args: unknown
}

/** A signed-in user's own view of a workspace, which holds their Private section. */
export interface SpaceView {
  userId: string
  spaceId: string
  spaceViewId: string
}

/** A workspace's sidebar: page ids by section. */
export interface WorkspaceTree {
  name: string
  privatePages: string[]
  sharedPages: string[]
  workspacePages: string[]
  teams: { name: string; pages: string[] }[]
  /** Why the teamspaces could not be loaded, when they couldn't; the other sections still are. */
  teamsError?: string
}

/** One search hit as Notion returns it. Highlights mark matched words with a random tag per response. */
export interface RawSearchResult {
  id: string
  score?: number
  highlight?: { title?: string; text?: string; pathText?: string }
  highlightBlockId?: string
}

export interface SearchResults {
  results: RawSearchResult[]
  total: number
  /** The pages found, and their workspace. */
  recordMap: RecordMap
}

/** A page and everything loadPageChunk returns with it (descendants, databases, comments). */
export interface LoadedPage {
  page: Block
  spaceId: string
  recordMap: RecordMap
  /** False if the page had more chunks than `maxChunks`. */
  complete: boolean
  /** The Notion user it was loaded as: the tab's signed-in user. */
  userId?: string
}

/**
 * How a duplicate's progress is checked: first after `firstMs`, then twice as long each time up to
 * `maxMs`, `polls` times at most, so a slow copy costs Notion few requests.
 */
export const DUPLICATE_POLLING = { firstMs: 1_000, maxMs: 5_000, polls: 15 }
/** How many checks in a row may report an error on a running copy before giving up on it. */
const TASK_ERROR_POLLS = 3

const CHUNK_LIMIT = 100
/** Records asked for in one syncRecordValuesMain request at most. */
const RECORDS_BATCH = 100
/** Record lookups sent at once at most. */
const RECORDS_PARALLEL = 4

/**
 * The most people whose names a mention lookup loads: five requests' worth. A larger workspace would
 * cost a request per 100 people for every question that mentions someone.
 */
export const PEOPLE_MAX = 5 * RECORDS_BATCH

/** Statuses with which Notion says it gets too many requests (429) or is too busy (529). */
const LIMITED = new Set([429, 529])

export class NotionClient {
  /**
   * Notion turned a request away: this client sends nothing more after it (requests already in
   * flight, such as parallel batches, still get their answers). A client serves one tool call; the
   * agent ending the question keeps later tools from sending.
   */
  private limited = false

  /** `usage`: the question this client's requests count toward, if any. */
  constructor(
    private readonly send: NotionTransport,
    private readonly usage?: NotionUsage,
  ) {}

  /** Loads a page with its content, following loadPageChunk's cursor until the page is complete. */
  async loadPage(id: string, { maxChunks = 50 } = {}): Promise<LoadedPage> {
    const pageId = notionId(id)
    const recordMap: RecordMap = {}
    let cursor: unknown = { stack: [] }
    let spaceId: string | undefined
    let user: string | undefined
    // Chunks overlap (the page and some parents repeat); merging de-duplicates them by id.
    for (let chunkNumber = 0; chunkNumber < Math.max(1, maxChunks); chunkNumber++) {
      const { json, userId } = await this.request<{ cursor?: { stack?: unknown[] }; recordMap?: unknown }>(
        'loadPageChunk',
        { page: { id: pageId }, limit: CHUNK_LIMIT, cursor, chunkNumber, verticalColumns: false },
        spaceId,
      )
      mergeRecordMaps(recordMap, normalizeRecordMap(json.recordMap))
      const page = recordMap.block?.[pageId] as Block | undefined
      user = userId
      if (!page) throw missingRecord(userId)
      if (page.alive === false) throw new NotionError('no_access', IN_TRASH)
      if (!page.space_id) throw new NotionError('notion_error', 'Notion returned the page without its workspace.')
      spaceId = page.space_id
      if (!json.cursor?.stack?.length) return { page, spaceId, recordMap, complete: true, userId: user }
      cursor = json.cursor
    }
    return { page: recordMap.block![pageId] as Block, spaceId: spaceId!, recordMap, complete: false, userId: user }
  }

  /** Loads specific records of any table. Every requested record must come back. */
  async getRecords(pointers: Pointer[]): Promise<RecordMap> {
    if (pointers.length === 0) return {}
    const requested = pointers.map((p) => ({
      ...p,
      id: notionId(p.id),
      spaceId: p.spaceId ? notionId(p.spaceId) : undefined,
    }))
    const spaces = new Set(requested.flatMap((p) => (p.spaceId ? [p.spaceId] : [])))
    const { json, userId } = await this.request<{ recordMap?: unknown }>(
      'syncRecordValuesMain',
      { requests: requested.map((pointer) => ({ pointer, version: -1 })) },
      spaces.size === 1 ? [...spaces][0] : undefined,
    )
    const recordMap = normalizeRecordMap(json.recordMap)
    if (requested.some((p) => !recordMap[p.table]?.[p.id])) throw missingRecord(userId)
    if (requested.some((p) => recordMap[p.table]![p.id].alive === false)) throw new NotionError('no_access', IN_TRASH)
    return recordMap
  }

  /**
   * The rows of a database, at most `limit` of them, through one of its views. The view's own
   * filters and sorts are not applied: every row comes back, in Notion's default order. Notion only
   * returns rows the signed-in account can open.
   */
  async queryCollection(
    collectionId: string,
    viewId: string,
    spaceId: string,
    limit: number,
  ): Promise<{ rowIds: string[]; hasMore: boolean; recordMap: RecordMap }> {
    const space = notionId(spaceId)
    const { json } = await this.request<{
      result?: { reducerResults?: { collection_group_results?: { blockIds?: unknown; hasMore?: unknown } } }
      recordMap?: unknown
    }>(
      'queryCollection',
      {
        source: { type: 'collection', id: notionId(collectionId), spaceId: space },
        collectionView: { id: notionId(viewId), spaceId: space },
        loader: {
          type: 'reducer',
          reducers: { collection_group_results: { type: 'results', limit } },
          sort: [],
          searchQuery: '',
          // The user's own zone, as the tool's `Today:` uses.
          userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      },
      space,
    )
    const group = json.result?.reducerResults?.collection_group_results
    const rowIds = Array.isArray(group?.blockIds)
      ? group.blockIds.filter((id): id is string => typeof id === 'string')
      : []
    return { rowIds, hasMore: group?.hasMore === true, recordMap: normalizeRecordMap(json.recordMap) }
  }

  /** Like getRecords, but records that are missing, out of reach, or in the trash are just left out. */
  async findRecords(pointers: Pointer[]): Promise<RecordMap> {
    if (!pointers.length) return {}
    // Large lists go in batches, so no single request grows without bound.
    if (pointers.length > RECORDS_BATCH) {
      const batches: Pointer[][] = []
      for (let at = 0; at < pointers.length; at += RECORDS_BATCH) batches.push(pointers.slice(at, at + RECORDS_BATCH))
      // A few batches at a time, so a long list doesn't flood the user's tab with requests.
      const out: RecordMap = {}
      for (let at = 0; at < batches.length; at += RECORDS_PARALLEL) {
        const maps = await settleAll(batches.slice(at, at + RECORDS_PARALLEL).map((b) => this.findRecords(b)))
        for (const map of maps) mergeRecordMaps(out, map)
      }
      return out
    }
    const requested = pointers.map((p) => ({
      ...p,
      id: notionId(p.id),
      spaceId: p.spaceId ? notionId(p.spaceId) : undefined,
    }))
    const spaces = new Set(requested.flatMap((p) => (p.spaceId ? [p.spaceId] : [])))
    const { json } = await this.request<{ recordMap?: unknown }>(
      'syncRecordValuesMain',
      { requests: requested.map((pointer) => ({ pointer, version: -1 })) },
      spaces.size === 1 ? [...spaces][0] : undefined,
    )
    const recordMap = normalizeRecordMap(json.recordMap)
    for (const records of Object.values(recordMap)) {
      for (const [id, record] of Object.entries(records ?? {})) if (record.alive === false) delete records![id]
    }
    return recordMap
  }

  /** Every signed-in user's views of their workspaces, from each user's root record. */
  async spaceViews(): Promise<SpaceView[]> {
    const { json } = await this.request<Record<string, unknown>>('getSpaces', {})
    const views: SpaceView[] = []
    for (const [userId, raw] of Object.entries(json)) {
      const root = (normalizeRecordMap(raw) as Record<string, Record<string, NotionRecord> | undefined>).user_root?.[
        userId
      ]
      const pointers = Array.isArray(root?.space_view_pointers) ? root.space_view_pointers : []
      for (const p of pointers as { id?: unknown; spaceId?: unknown }[]) {
        if (typeof p.id === 'string' && typeof p.spaceId === 'string')
          views.push({ userId, spaceId: p.spaceId, spaceViewId: p.id })
      }
    }
    return views
  }

  /**
   * How a workspace is organized in the sidebar for the signed-in user: its name, their private
   * pages, pages shared with them, the workspace's own top-level pages, and the teamspaces they
   * joined, in the sidebar's order.
   */
  async getSpace(spaceId: string): Promise<WorkspaceTree> {
    const space = notionId(spaceId)
    const { json, userId } = await this.request<Record<string, unknown>>('getSpaces', {}, space)
    // One record map per signed-in user, keyed by user id; only the tab's active user's counts. No
    // fallback to the others: another account's map would list that account's private pages, and
    // every later request runs as the active user anyway.
    if (!userId) throw new NotionError('signed_out', SIGNED_OUT)
    // The cookie's id, with or without hyphens, as getSpaces may key it.
    const key = [userId, toUuid(userId), toUuid(userId)?.replace(/-/g, '')].find((k) => k && json[k])
    if (!key) throw new NotionError('notion_error', NO_USER_MAP)
    const map = normalizeRecordMap(json[key])
    if (!map.space?.[space]) throw new NotionError('no_access', NO_ACCESS)
    const record = map.space[space]
    const view = Object.values(map.space_view ?? {}).find((v) => v.space_id === space)
    const settings = record.settings as { is_teams_enabled?: unknown } | undefined
    let teams: WorkspaceTree['teams'] = []
    let teamsError: string | undefined
    // Teamspaces come from a request of their own, unless the workspace has them turned off; if it
    // fails, the rest of the sidebar still lists.
    if (settings?.is_teams_enabled !== false) {
      try {
        teams = await this.joinedTeams(space)
      } catch (err) {
        // A failure that stops the question is passed on, not shown as missing teamspaces.
        if (!(err instanceof NotionError) || err.stopsQuestion) throw err
        teamsError = err.message
      }
    }
    return {
      name: typeof record.name === 'string' ? record.name : 'Workspace',
      privatePages: ids(view?.private_pages),
      sharedPages: ids(view?.shared_pages_manual_sort),
      workspacePages: ids(record.pages),
      teams,
      ...(teamsError ? { teamsError } : {}),
    }
  }

  /**
   * The teamspaces of a workspace the signed-in user joined, in the sidebar's order, with their
   * top-level pages. getSpaces doesn't hold them; Notion's sidebar loads them like this.
   */
  private async joinedTeams(space: string): Promise<WorkspaceTree['teams']> {
    const { json } = await this.request<{ teams?: unknown; recordMap?: unknown }>(
      'getTeamsV2',
      { spaceId: space, teamTypes: ['Joined'] },
      space,
    )
    const records = normalizeRecordMap(json.recordMap).team ?? {}
    const teams = Array.isArray(json.teams) ? (json.teams as { id?: unknown; type?: unknown }[]) : []
    return teams.flatMap((t) => {
      const team = typeof t.id === 'string' && t.type === 'Joined' ? records[t.id] : undefined
      // Archived teamspaces leave the sidebar.
      if (!team || team.alive === false || team.archived_by || team.space_id !== space) return []
      return [
        { name: typeof team.name === 'string' && team.name ? team.name : 'Teamspace', pages: ids(team.team_pages) },
      ]
    })
  }

  /**
   * The people of a workspace the signed-in user can see (members and guests) who have a name: the
   * people Notion's own @ menu offers. One request lists them, then one per 100 people loads their
   * names; once per question, so later tools in it send none. Null for a workspace with more than
   * `PEOPLE_MAX` people, whose names are not loaded: that would take too many requests.
   */
  async workspacePeople(spaceId: string): Promise<{ id: string; name: string }[] | null> {
    const space = notionId(spaceId)
    const known = this.usage?.people.get(space)
    if (known) return known
    const loading = this.loadPeople(space)
    // A lookup that failed is not kept: the question stops, or a later tool may try again.
    this.usage?.people.set(space, loading)
    loading.catch(() => this.usage?.people.delete(space))
    return loading
  }

  private async loadPeople(space: string): Promise<{ id: string; name: string }[] | null> {
    const { json } = await this.request<{ users?: unknown }>('getVisibleUsers', { spaceId: space }, space)
    if (!Array.isArray(json.users))
      throw new NotionError('notion_error', 'Notion returned no list of workspace members.')
    const userIds = [
      ...new Set(
        (json.users as { userId?: unknown }[]).flatMap((u) =>
          typeof u?.userId === 'string' ? [notionId(u.userId)] : [],
        ),
      ),
    ]
    if (userIds.length > PEOPLE_MAX) return null
    const users =
      (await this.findRecords(userIds.map((id) => ({ table: 'notion_user' as const, id })))).notion_user ?? {}
    return userIds.flatMap((id) => {
      const name = users[id]?.name
      return typeof name === 'string' && name.trim() ? [{ id, name: name.trim() }] : []
    })
  }

  /** Applies operations in one transaction: Notion applies all of them or none. */
  async submitTransaction(space: string, operations: Operation[], userAction: string): Promise<void> {
    const spaceId = notionId(space)
    // Text lives in CRDT form too; the server keeps it in sync with `properties`. Writing it
    // directly would corrupt the block.
    if (operations.some((op) => op.path.includes('crdt_data') || hasCrdtData(op.args))) {
      throw new NotionError('notion_error', 'Operations must not write crdt_data.')
    }
    // Records are keyed by dashed, lowercase ids; Notion's own client also names the space on each pointer.
    const ops = operations.map((op) => ({
      ...op,
      pointer: {
        ...op.pointer,
        id: notionId(op.pointer.id),
        spaceId: op.pointer.spaceId ? notionId(op.pointer.spaceId) : spaceId,
      },
    }))
    try {
      await this.request(
        'saveTransactionsFanout',
        {
          requestId: crypto.randomUUID(),
          transactions: [{ id: crypto.randomUUID(), spaceId, debug: { userAction }, operations: ops }],
        },
        spaceId,
      )
    } catch (err) {
      // Notion may have applied it; a blind retry could apply it twice (say, a duplicated block).
      if (err instanceof NotionError && err.unanswered) {
        throw new NotionError('outcome_unknown', OUTCOME_UNKNOWN, { cause: err })
      }
      throw err
    }
  }

  /**
   * Copies a page with everything in it (content, child pages, databases), as Notion's Duplicate
   * does: Notion copies it on its side, puts the copy right after the page in `parentId`, and adds
   * a number to its title. Resolves with the copy's id once Notion has finished.
   */
  async duplicatePage(
    space: string,
    pageId: string,
    parentId: string,
    { signal }: DuplicateOptions = {},
  ): Promise<string> {
    const spaceId = notionId(space)
    const page = notionId(pageId)
    const parent = notionId(parentId)
    let taskId: unknown
    try {
      // Without the workspace on the request, Notion routes the task where the page isn't, and it fails.
      // Stopped while it is sent, the task may have reached Notion: the outcome is unknown.
      const { json } = await cutShort(
        this.request<{ taskId?: unknown }>(
          'enqueueTask',
          {
            task: {
              eventName: 'duplicateSubtree',
              request: {
                source: { ids: [page], spaceId },
                destination: { type: 'block', parent: { table: 'block', id: parent, spaceId }, siblingId: page },
                options: { appendNumericTitleSuffix: true },
                userAction: 'Notion Copilot: duplicate_page',
              },
              cellRouting: { spaceIds: [spaceId] },
            },
          },
          spaceId,
        ),
        undefined,
        signal,
      )
      taskId = json.taskId
    } catch (err) {
      if (err instanceof NotionError && (err.unanswered || err.code === 'outcome_unknown'))
        throw new NotionError('outcome_unknown', DUPLICATE_UNKNOWN, { cause: err, stopsQuestion: err.stopsQuestion })
      throw err
    }
    if (typeof taskId !== 'string') throw new NotionError('notion_error', 'Notion did not start copying the page.')
    const { firstMs, maxMs, polls } = DUPLICATE_POLLING
    // Only a check that stalls meets this: all of them, at their longest wait, with room to answer.
    const deadline = Date.now() + 2 * polls * maxMs
    let delay = firstMs
    // Polls in a row on which Notion said the task hit an error while still running.
    let erroring = 0
    // Once Notion has the task, it copies the page whatever happens here: stopping or failing to
    // hear back leaves the outcome unknown, never undone.
    for (let poll = 0; poll < polls; poll++) {
      // A small page is copied at once; a big one takes a while.
      await wait(delay, signal).catch(() => {
        throw new NotionError('outcome_unknown', DUPLICATE_UNKNOWN)
      })
      delay = Math.min(delay * 2, maxMs)
      let task: { state?: unknown; error?: unknown; status?: { targetIds?: unknown } } | undefined
      try {
        // A stalled check gives way to Stop and to the deadline.
        const { json } = await cutShort(
          this.request<{ results?: (typeof task)[] }>('getTasks', { taskIds: [taskId] }, spaceId),
          Math.max(0, deadline - Date.now()),
          signal,
        )
        task = json.results?.[0]
      } catch (err) {
        if (err instanceof NotionError && err.code === 'outcome_unknown') throw err
        // A failed check says nothing about the copy, which goes on regardless. Only a check that may
        // clear up (no answer, or a server error) is worth repeating, as one of the checks allowed.
        const transient = err instanceof NotionError && err.unanswered
        // Turned away for coming too fast, nothing more is asked: the question stops.
        if (!transient || Date.now() >= deadline)
          throw new NotionError('outcome_unknown', DUPLICATE_UNKNOWN, {
            cause: err,
            stopsQuestion: err instanceof NotionError ? err.stopsQuestion : undefined,
          })
        continue
      }
      if (task?.state === 'success') {
        const [copy] = Array.isArray(task.status?.targetIds) ? task.status.targetIds : []
        if (typeof copy !== 'string') throw new NotionError('outcome_unknown', DUPLICATE_UNKNOWN)
        return copy
      }
      if (task?.state === 'failure') {
        const why = typeof task.error === 'string' ? task.error : JSON.stringify(task.error ?? 'no details')
        throw new NotionError('notion_error', `Notion could not copy the page: ${why}`)
      }
      // A task still running with an error may be retried by Notion, so it's not a failure for sure;
      // but one that keeps reporting it is unlikely to finish soon: say so instead of waiting it out.
      erroring = task?.state === 'in_progress' && typeof task.error === 'string' && task.error ? erroring + 1 : 0
      if (erroring >= TASK_ERROR_POLLS)
        throw new NotionError(
          'outcome_unknown',
          `Notion reports an error while copying the page: ${String(task!.error)} ${DUPLICATE_UNKNOWN}`,
        )
      if (Date.now() >= deadline) throw new NotionError('outcome_unknown', DUPLICATE_UNKNOWN)
    }
    // Still not done after every check allowed: what became of the copy is unknown.
    throw new NotionError('outcome_unknown', DUPLICATE_UNKNOWN)
  }

  /**
   * Moves pages to Notion's trash, as its "Move to Trash" does: each is taken out of its parent's
   * list in one transaction, then Notion is told they are trashed. Never deletes for good: they
   * stay in the trash, where they can be restored.
   */
  async trashPages(space: string, pages: { id: string; parentId: string; parentTable: 'block' | 'space' }[]) {
    const spaceId = notionId(space)
    const op = blockOps(spaceId, Date.now())
    const operations: Operation[] = []
    for (const p of pages) {
      // A page in a page is listed in its `content`; a top-level page in its workspace's `pages`.
      operations.push({
        pointer: { table: p.parentTable, id: p.parentId, spaceId },
        path: [p.parentTable === 'block' ? 'content' : 'pages'],
        command: 'removeChild',
        args: { id: notionId(p.id) },
      })
      operations.push(op.touch(p.id))
    }
    await this.submitTransaction(spaceId, operations, 'Notion Copilot: trash_page')
    try {
      // What Notion's own client sends after trashing; `permanentlyDelete` stays false, always.
      await this.request(
        'deleteContentRecords',
        { records: pages.map((p) => ({ id: notionId(p.id), table: 'block', spaceId })), permanentlyDelete: false },
        spaceId,
      )
    } catch (err) {
      // The pages are in the trash already: the transaction did that. This call only matches
      // what Notion's own client sends after it. A refusal that stops the question still does.
      if (err instanceof NotionError && err.stopsQuestion)
        throw new NotionError('notion_error', "The pages were moved to Notion's trash.", {
          cause: err,
          stopsQuestion: err.stopsQuestion,
          mayHaveChanged: true,
        })
      console.warn('Notion did not take the trashed pages’ deleteContentRecords', err)
    }
  }

  /**
   * Searches a workspace's pages by title and content, as Notion's quick find does. Notion only
   * returns what the signed-in account can open.
   */
  async search(spaceId: string, query: string, limit: number): Promise<SearchResults> {
    const space = notionId(spaceId)
    const { json } = await this.request<{ results?: RawSearchResult[]; total?: number; recordMap?: unknown }>(
      'search',
      {
        type: 'BlocksInSpace',
        query,
        spaceId: space,
        limit,
        source: 'quick_find',
        sort: { field: 'relevance' },
        filters: {
          isDeletedOnly: false,
          excludeTemplates: false,
          navigableBlockContentOnly: false,
          requireEditPermissions: false,
          includePublicPagesWithoutExplicitAccess: false,
          ancestors: [],
          createdBy: [],
          editedBy: [],
          lastEditedTime: {},
          createdTime: {},
          inTeams: [],
        },
      },
      space,
    )
    const results = (json.results ?? []).filter((r) => typeof r?.id === 'string')
    const total = typeof json.total === 'number' && Number.isFinite(json.total) ? json.total : results.length
    return { results, total: Math.max(total, results.length), recordMap: normalizeRecordMap(json.recordMap) }
  }

  /**
   * Every request to Notion goes through here. `spaceId`, when known, goes along as
   * `x-notion-space-id`. When Notion turns a request away for coming too fast, nothing is retried:
   * the client sends nothing more, and the question stops (see CLAUDE.md, calling Notion). Each
   * request sent counts toward the question's usage, and may first wait for the user at its budget.
   */
  private async request<T>(
    endpoint: NotionEndpoint,
    body: unknown,
    spaceId?: string,
  ): Promise<{ json: T; userId?: string }> {
    if (this.limited) throw new NotionError('rate_limited', NOT_SENT, { stopsQuestion: LIMITED_STOP })
    await this.usage?.admit()
    // Notion may have turned another request away while this one waited for the user: not sent, so not counted.
    if (this.limited) {
      this.usage?.unsent()
      throw new NotionError('rate_limited', NOT_SENT, { stopsQuestion: LIMITED_STOP })
    }
    const write = endpoint === 'saveTransactionsFanout'
    let res: NotionResponse
    try {
      res = await this.send(endpoint, body, { spaceId })
    } catch (err) {
      // The transport says when nothing went out; otherwise the request, and a write, may have reached Notion.
      if (err instanceof NotionError && !err.unanswered) this.usage?.unsent()
      else if (write && this.usage) this.usage.wrote = true
      throw err
    }
    const turnedAway = res.error === undefined && !res.redirected && LIMITED.has(res.status)
    // Only a 429 says the write was not applied; anything else may have changed data, so err on that side.
    if (write && this.usage && !(turnedAway && res.status === 429)) this.usage.wrote = true
    if (turnedAway) {
      this.limited = true
      // A 529 to a write may come after Notion applied it, so its outcome stays unknown. A 429
      // means Notion turned it away before doing anything with it.
      // Starting a copy is a write too.
      if ((endpoint === 'saveTransactionsFanout' || endpoint === 'enqueueTask') && res.status === 529) {
        throw new NotionError('outcome_unknown', BUSY_UNKNOWN, { stopsQuestion: LIMITED_STOP })
      }
      throw new NotionError('rate_limited', RATE_LIMITED, { stopsQuestion: LIMITED_STOP })
    }
    return { json: checkResponse(res) as T, userId: res.userId }
  }
}

/**
 * Like Promise.all, but waits for every request, so a failure that stops the question is never
 * hidden behind another one that came first.
 */
async function settleAll<T>(promises: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises)
  const failures = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason as unknown] : []))
  if (failures.length) throw failures.find((e) => e instanceof NotionError && e.stopsQuestion) ?? failures[0]
  return settled.map((s) => (s as PromiseFulfilledResult<T>).value)
}

/** The ids in a record's list field. */
function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** The JSON of a successful response, or a NotionError explaining the failure. */
export function checkResponse(res: NotionResponse): Record<string, unknown> {
  if (res.error !== undefined) {
    throw new NotionError('notion_error', `Could not reach Notion: ${res.error}`, { unanswered: true })
  }
  if (res.redirected) {
    if (!res.userId) throw new NotionError('signed_out', SIGNED_OUT)
    throw new NotionError('notion_error', 'Notion redirected the request instead of answering it.')
  }
  const isObject = !!res.json && typeof res.json === 'object' && !Array.isArray(res.json)
  const json = (isObject ? res.json : {}) as Record<string, unknown>
  if (res.status >= 200 && res.status < 300) {
    // Every endpoint answers with a JSON object; anything else (say, an HTML page) is not a success.
    if (!isObject) throw new NotionError('notion_error', `Notion returned an unexpected response (${res.status}).`)
    return json
  }
  if (res.status === 401 || json.name === 'UnauthorizedError') throw new NotionError('signed_out', SIGNED_OUT)
  if (res.status === 403) throw new NotionError('no_access', NO_ACCESS)
  const name = typeof json.name === 'string' ? ` ${json.name}` : ''
  const detail = json.debugMessage ?? json.message ?? 'no details'
  // A 5xx (often a gateway timeout) can come after Notion already applied the request.
  throw new NotionError('notion_error', `Notion returned an error (${res.status}${name}): ${String(detail)}`, {
    unanswered: res.status >= 500,
  })
}

/**
 * Notion answers 200 with an empty recordMap, not an error, for a record the user can't see,
 * including when no one is signed in.
 */
function missingRecord(userId: string | undefined): NotionError {
  return userId ? new NotionError('no_access', NO_ACCESS) : new NotionError('signed_out', SIGNED_OUT)
}

/**
 * Unwraps Notion's recordMap. Each entry is `{ spaceId, value: { role, value: <record> } }`; older
 * responses had `{ role, value: <record> }`. Entries without a record are left out.
 */
export function normalizeRecordMap(raw: unknown): RecordMap {
  const out: Record<string, Record<string, NotionRecord>> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [table, entries] of Object.entries(raw)) {
    if (table === '__version__' || !entries || typeof entries !== 'object') continue
    for (const [id, entry] of Object.entries(entries as Record<string, unknown>)) {
      const record = unwrap(entry)
      if (record) (out[table] ??= {})[id] = record
    }
  }
  return out as RecordMap
}

function unwrap(entry: unknown): NotionRecord | undefined {
  const outer = (entry as { value?: unknown } | null)?.value
  const inner = (outer as { value?: unknown } | null | undefined)?.value
  for (const candidate of [inner, outer]) {
    if (candidate && typeof candidate === 'object' && typeof (candidate as NotionRecord).id === 'string') {
      return candidate as NotionRecord
    }
  }
  return undefined
}

/** Adds `source` to `target`, keeping the newer version of a record both have. */
export function mergeRecordMaps(target: RecordMap, source: RecordMap): RecordMap {
  for (const [table, records] of Object.entries(source) as [Table, Record<string, NotionRecord>][]) {
    const into = (target[table] ??= {})
    for (const [id, record] of Object.entries(records)) {
      if (!into[id] || (record.version ?? 0) >= (into[id].version ?? 0)) into[id] = record
    }
  }
  return target
}

export interface DuplicateOptions {
  signal?: AbortSignal
}

/**
 * `promise`, unless `signal` aborts or `ms` pass first: then an `outcome_unknown` error, since
 * the request may still reach Notion. The request itself is left to finish or time out.
 */
function cutShort<T>(promise: Promise<T>, ms: number | undefined, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const unknown = () => reject(new NotionError('outcome_unknown', DUPLICATE_UNKNOWN))
    if (signal?.aborted) return unknown()
    const timer = ms === undefined ? undefined : setTimeout(unknown, ms)
    signal?.addEventListener('abort', unknown, { once: true })
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', unknown)
    })
  })
}

/** Resolves after `ms`, or rejects when `signal` aborts. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Whether `value` has a `crdt_data` key at any depth. */
function hasCrdtData(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, v]) => key === 'crdt_data' || hasCrdtData(v))
}

/** A record id as Notion keys records by; ids from URLs or the model may be undashed or uppercase. */
function notionId(id: string): string {
  const uuid = toUuid(id)
  if (!uuid) throw new NotionError('notion_error', `Not a Notion id: ${id}`)
  return uuid
}

/**
 * Builders for the operations a transaction is made of, so Notion's wire format for writes lives
 * here with the rest of the API. All act on blocks in one workspace.
 */
export function blockOps(spaceId: string, now: number) {
  const pointer = (id: string): Pointer => ({ table: 'block', id, spaceId })
  return {
    /**
     * A new block under `parentId`; it still has to be listed in its parent's content. Without a
     * parent, a later operation must give it one.
     */
    create(
      id: string,
      type: string,
      parentId: string | undefined,
      fields: { properties?: object; format?: object; parent_table?: 'block' | 'collection' } = {},
    ): Operation {
      return {
        pointer: pointer(id),
        path: [],
        command: 'set',
        args: {
          id,
          type,
          version: 1,
          alive: true,
          ...(parentId === undefined ? {} : { parent_id: parentId, parent_table: 'block' }),
          space_id: spaceId,
          created_time: now,
          last_edited_time: now,
          ...fields,
        },
      }
    },
    /** Lists `id` in `parentId`'s content after `after`, or at the end without it. */
    listAfter(parentId: string, id: string, after?: string): Operation {
      return {
        pointer: pointer(parentId),
        path: ['content'],
        command: 'listAfter',
        args: after ? { after, id } : { id },
      }
    },
    listBefore(parentId: string, id: string, before: string): Operation {
      return { pointer: pointer(parentId), path: ['content'], command: 'listBefore', args: { before, id } }
    },
    /** Deletes a block the way Notion does: marked not alive, and taken out of its parent's list. */
    remove(parentId: string, id: string): Operation[] {
      return [
        { pointer: pointer(id), path: [], command: 'update', args: { alive: false, last_edited_time: now } },
        { pointer: pointer(parentId), path: ['content'], command: 'listRemove', args: { id } },
      ]
    },
    /** Changes property values, text included; the only way Notion accepts for existing blocks. */
    setProperties(id: string, values: object): Operation {
      return {
        pointer: pointer(id),
        path: ['properties'],
        command: 'updateBlockPropertyValue',
        args: { primitiveOp: { command: 'update', args: values } },
      }
    },
    setFormat(id: string, format: object): Operation {
      return { pointer: pointer(id), path: ['format'], command: 'update', args: format }
    },
    /**
     * Moves pages to the end of `parentId`, as Notion's "Move to" does. Notion takes each out of
     * its old parent itself, and refuses to move a page into one of its own pages.
     */
    moveInto(parentId: string, ids: string[]): Operation {
      return { pointer: pointer(parentId), path: ['content'], command: 'insertChildrenAfter', args: { ids } }
    },
    /**
     * A new full-page database, without a parent yet: the page, its collection with `schema`, and
     * one table view. Its rows are pages created under the collection (`create` with
     * `parent_table: 'collection'`).
     */
    createDatabase(ids: { page: string; collection: string; view: string }, name: string, schema: object): Operation[] {
      const base = { version: 1, alive: true, space_id: spaceId }
      const set = (table: 'block' | 'collection' | 'collection_view', id: string, args: object): Operation => ({
        pointer: { table, id, spaceId },
        path: [],
        command: 'set',
        args: { id, ...base, ...args },
      })
      return [
        set('block', ids.page, {
          type: 'collection_view_page',
          collection_id: ids.collection,
          view_ids: [ids.view],
          created_time: now,
          last_edited_time: now,
        }),
        set('collection', ids.collection, { parent_id: ids.page, parent_table: 'block', name: [[name]], schema }),
        set('collection_view', ids.view, {
          type: 'table',
          name: 'Table',
          parent_id: ids.page,
          parent_table: 'block',
          format: { collection_pointer: { id: ids.collection, table: 'collection', spaceId } },
        }),
      ]
    },
    /** Puts a new page, created without a parent, at the top of `view`'s Private section. */
    moveToPrivate(id: string, view: SpaceView): Operation {
      return {
        pointer: pointer(id),
        path: [],
        command: 'moveToPrivate',
        args: { spaceViewPointer: { id: view.spaceViewId, table: 'space_view', spaceId }, userId: view.userId },
      }
    },
    /** Marks a block as edited now; Notion doesn't do it itself. */
    touch(id: string): Operation {
      return { pointer: pointer(id), path: [], command: 'update', args: { last_edited_time: now } }
    },
  }
}

/**
 * Builders for comments: a comment lives in a discussion (a thread), which hangs off a block or a
 * page. The records are the ones Notion's web client writes for a comment on a page (checked
 * against it, 2026-11); on a block the same records show as a comment on the whole block. Notion's
 * own comments on a block's text also mark that text, a CRDT edit this never makes.
 */
export function commentOps(spaceId: string, now: number) {
  return {
    /** A new thread on `blockId` (a page is a block too) holding one comment by `userId`. */
    newThread(blockId: string, discussionId: string, commentId: string, userId: string, text: unknown[]): Operation[] {
      return [
        {
          pointer: { table: 'discussion', id: discussionId, spaceId },
          path: [],
          command: 'set',
          args: {
            id: discussionId,
            version: 1,
            type: 'default',
            parent_id: blockId,
            parent_table: 'block',
            resolved: false,
            space_id: spaceId,
            comments: [commentId],
          },
        },
        {
          pointer: { table: 'comment', id: commentId, spaceId },
          path: [],
          command: 'set',
          args: {
            id: commentId,
            version: 1,
            parent_id: discussionId,
            parent_table: 'discussion',
            alive: true,
            space_id: spaceId,
            text,
            created_time: now,
            last_edited_time: now,
            created_by_id: userId,
            created_by_table: 'notion_user',
          },
        },
        {
          pointer: { table: 'block', id: blockId, spaceId },
          path: ['discussions'],
          command: 'listAfter',
          args: { id: discussionId },
        },
      ]
    },
  }
}
