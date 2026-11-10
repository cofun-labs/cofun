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

export class NotionError extends Error {
  /** The request may have reached Notion, but no answer came back (timeout, tab closed mid-request). */
  readonly unanswered: boolean

  constructor(
    readonly code: NotionErrorCode,
    message: string,
    options?: { cause?: unknown; unanswered?: boolean },
  ) {
    super(message, options)
    this.name = 'NotionError'
    this.unanswered = options?.unanswered ?? false
  }
}

export const NO_NOTION_TAB = 'No Notion page is open in this window.'
export const SIGNED_OUT = 'Not signed in to Notion in this tab. Sign in to Notion and try again.'
export const NO_ACCESS = "The Notion page doesn't exist, or the signed-in Notion account has no access to it."
export const IN_TRASH = 'The Notion page or block is in the trash.'
export const OUTCOME_UNKNOWN =
  'Notion did not answer, so the change may or may not have been saved. Read the page again before retrying.'
export const RATE_LIMITED =
  'Notion is turning requests away right now (too many requests, or too busy), so this was not done. Do not try again or work around it with other tools: tell the user to wait a minute before asking again.'

/** The endpoints under /api/v3/ the client uses. */
export type NotionEndpoint =
  | 'loadPageChunk'
  | 'syncRecordValuesMain'
  | 'saveTransactionsFanout'
  | 'search'
  | 'queryCollection'
  | 'getSpaces'

/** What one request to Notion returned. `error` is set when no HTTP response came back. */
export interface NotionResponse {
  status: number
  json: unknown
  /** Whether the tab has a signed-in Notion user (the `notion_user_id` cookie). */
  signedIn: boolean
  error?: string
  /** Notion answered with a redirect (likely to a sign-in page), which was not followed. */
  redirected?: boolean
  /** The response's `Retry-After` header, if it had one. */
  retryAfter?: string
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
 * values, text included. Notion rejects `set` on an existing block's properties.
 */
export interface Operation {
  pointer: Pointer
  path: string[]
  command: 'set' | 'update' | 'listAfter' | 'listBefore' | 'listRemove' | 'removeChild' | 'updateBlockPropertyValue'
  args: unknown
}

/** A workspace's sidebar: page ids by section. */
export interface WorkspaceTree {
  name: string
  privatePages: string[]
  sharedPages: string[]
  workspacePages: string[]
  teams: { name: string; pages: string[] }[]
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
}

const CHUNK_LIMIT = 100
/** Records asked for in one syncRecordValuesMain request at most. */
const RECORDS_BATCH = 100
/** Record lookups sent at once at most. */
const RECORDS_PARALLEL = 4

/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
export type Wait = (ms: number, signal?: AbortSignal) => Promise<void>

/** Statuses with which Notion says it is getting too many requests. */
const SLOW_DOWN = new Set([429, 529])
/** Tries after the first one when Notion says to slow down. */
const RETRIES = 3
/** The first wait when Notion doesn't say how long; it doubles with each try. */
const BACKOFF_MS = 1_000
/**
 * The longest one client (one tool call) waits in all, across its requests. A longer limit isn't
 * worth holding a tool call for; the user is told to wait instead.
 */
const MAX_WAIT_MS = 30_000

export interface NotionClientOptions {
  /** Stops waiting and sending (the user stopped the question). */
  signal?: AbortSignal
  wait?: Wait
}

export class NotionClient {
  private readonly signal?: AbortSignal
  private readonly wait: Wait
  /** While one request backs off, the client's other requests hold until Notion answers it. */
  private held: Promise<void> = Promise.resolve()
  private backingOff = false
  /** How long this client's backoffs took in all, in ms. */
  private waited = 0
  /** A backoff ran out: the client sends nothing more. */
  private gaveUp = false

  constructor(
    private readonly send: NotionTransport,
    { signal, wait = sleep }: NotionClientOptions = {},
  ) {
    this.signal = signal
    this.wait = wait
  }

  /** Loads a page with its content, following loadPageChunk's cursor until the page is complete. */
  async loadPage(id: string, { maxChunks = 50 } = {}): Promise<LoadedPage> {
    const pageId = notionId(id)
    const recordMap: RecordMap = {}
    let cursor: unknown = { stack: [] }
    let spaceId: string | undefined
    // Chunks overlap (the page and some parents repeat); merging de-duplicates them by id.
    for (let chunkNumber = 0; chunkNumber < Math.max(1, maxChunks); chunkNumber++) {
      const { json, signedIn } = await this.request<{ cursor?: { stack?: unknown[] }; recordMap?: unknown }>(
        'loadPageChunk',
        { page: { id: pageId }, limit: CHUNK_LIMIT, cursor, chunkNumber, verticalColumns: false },
        spaceId,
      )
      mergeRecordMaps(recordMap, normalizeRecordMap(json.recordMap))
      const page = recordMap.block?.[pageId] as Block | undefined
      if (!page) throw missingRecord(signedIn)
      if (page.alive === false) throw new NotionError('no_access', IN_TRASH)
      if (!page.space_id) throw new NotionError('notion_error', 'Notion returned the page without its workspace.')
      spaceId = page.space_id
      if (!json.cursor?.stack?.length) return { page, spaceId, recordMap, complete: true }
      cursor = json.cursor
    }
    return { page: recordMap.block![pageId] as Block, spaceId: spaceId!, recordMap, complete: false }
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
    const { json, signedIn } = await this.request<{ recordMap?: unknown }>(
      'syncRecordValuesMain',
      { requests: requested.map((pointer) => ({ pointer, version: -1 })) },
      spaces.size === 1 ? [...spaces][0] : undefined,
    )
    const recordMap = normalizeRecordMap(json.recordMap)
    if (requested.some((p) => !recordMap[p.table]?.[p.id])) throw missingRecord(signedIn)
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
        const maps = await Promise.all(batches.slice(at, at + RECORDS_PARALLEL).map((b) => this.findRecords(b)))
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

  /**
   * How a workspace is organized in the sidebar for the signed-in user: its name, their private
   * pages, pages shared with them, the workspace's own top-level pages, and its teamspaces.
   */
  async getSpace(spaceId: string): Promise<WorkspaceTree> {
    const space = notionId(spaceId)
    const { json } = await this.request<Record<string, unknown>>('getSpaces', {}, space)
    // One record map per signed-in user; the one holding this workspace is the tab's.
    const maps = Object.values(json).map(normalizeRecordMap)
    const map = maps.find((m) => m.space?.[space])
    if (!map) throw new NotionError('no_access', NO_ACCESS)
    const ids = (value: unknown) =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
    const view = Object.values(map.space_view ?? {}).find((v) => v.space_id === space)
    const teams = Object.values(map.team ?? {})
      .filter((t) => t.space_id === space && t.alive !== false)
      .map((t) => ({ name: typeof t.name === 'string' ? t.name : 'Teamspace', pages: ids(t.pages) }))
    return {
      name: typeof map.space![space].name === 'string' ? (map.space![space].name as string) : 'Workspace',
      privatePages: ids(view?.private_pages),
      sharedPages: ids(view?.shared_pages_manual_sort),
      workspacePages: ids(map.space![space].pages),
      teams,
    }
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
   * `x-notion-space-id`. When Notion says to slow down, one request backs off at a time, and the
   * client's other requests hold until Notion answers it, so they neither go on as a burst nor
   * all come back at once.
   */
  private async request<T>(
    endpoint: NotionEndpoint,
    body: unknown,
    spaceId?: string,
  ): Promise<{ json: T; signedIn: boolean }> {
    for (;;) {
      await this.held
      if (this.gaveUp) throw new NotionError('rate_limited', RATE_LIMITED)
      this.signal?.throwIfAborted()
      const res = await this.send(endpoint, body, { spaceId })
      if (!slowDown(endpoint, res)) return { json: checkResponse(res) as T, signedIn: res.signedIn }
      // Another request is backing off already: hold until Notion answers it, then send again.
      if (this.backingOff) continue
      this.backingOff = true
      let release = () => {}
      this.held = new Promise((resolve) => (release = resolve))
      try {
        return await this.backOff<T>(endpoint, body, spaceId, res)
      } finally {
        this.backingOff = false
        release()
      }
    }
  }

  /**
   * Waits (as long as Notion asks, and longer with each try) and sends again, a few times at most;
   * then, or once the client waited too long in all, gives up with `rate_limited`.
   */
  private async backOff<T>(
    endpoint: NotionEndpoint,
    body: unknown,
    spaceId: string | undefined,
    res: NotionResponse,
  ): Promise<{ json: T; signedIn: boolean }> {
    for (let retry = 0; slowDown(endpoint, res); retry++) {
      const ms = retryDelay(res.retryAfter, retry)
      if (retry >= RETRIES || this.waited + ms > MAX_WAIT_MS) {
        this.gaveUp = true
        throw new NotionError('rate_limited', RATE_LIMITED)
      }
      this.waited += ms
      await this.wait(ms, this.signal)
      res = await this.send(endpoint, body, { spaceId })
    }
    return { json: checkResponse(res) as T, signedIn: res.signedIn }
  }
}

/**
 * Whether Notion said to slow down, so the request can be sent again, body unchanged (a write
 * keeps its requestId and transaction id). A 429 means Notion turned the request away before
 * doing anything with it, writes included: that is what the status means, and these internal
 * endpoints have no documentation that says otherwise. A 529 to a write may come after Notion
 * applied it, so it stays a server error, and the change's outcome stays unknown.
 */
function slowDown(endpoint: NotionEndpoint, res: NotionResponse): boolean {
  if (res.error !== undefined || res.redirected) return false
  return endpoint === 'saveTransactionsFanout' ? res.status === 429 : SLOW_DOWN.has(res.status)
}

/**
 * How long to wait before try `retry + 1`: what `Retry-After` says (seconds or a date), but never
 * less than the backoff, so a zero, a past date, or a misread header can't send the tries back to back.
 */
function retryDelay(retryAfter: string | undefined, retry: number): number {
  const backoff = BACKOFF_MS * 2 ** retry
  const value = retryAfter?.trim()
  if (!value) return backoff
  const asked = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - Date.now()
  return Number.isNaN(asked) ? backoff : Math.max(asked, backoff)
}

const sleep: Wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** The JSON of a successful response, or a NotionError explaining the failure. */
export function checkResponse(res: NotionResponse): Record<string, unknown> {
  if (res.error !== undefined) {
    throw new NotionError('notion_error', `Could not reach Notion: ${res.error}`, { unanswered: true })
  }
  if (res.redirected) {
    if (!res.signedIn) throw new NotionError('signed_out', SIGNED_OUT)
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
function missingRecord(signedIn: boolean): NotionError {
  return signedIn ? new NotionError('no_access', NO_ACCESS) : new NotionError('signed_out', SIGNED_OUT)
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
    /** A new block under `parentId`; it still has to be listed in its parent's content. */
    create(
      id: string,
      type: string,
      parentId: string,
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
          parent_id: parentId,
          parent_table: 'block',
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
    /** Marks a block as edited now; Notion doesn't do it itself. */
    touch(id: string): Operation {
      return { pointer: pointer(id), path: [], command: 'update', args: { last_edited_time: now } }
    },
  }
}
