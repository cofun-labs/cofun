// Notion's internal API, as the signed-in Notion user: the only module that knows Notion's
// endpoints and request shapes. Tools call the typed methods of NotionClient, never fetch.
// The shapes come from the #64 spike (verified against Notion's web client, 2026-11).
// The worker's tests import this file too, so it uses no chrome APIs (see tab.ts for those).
import { toUuid } from './hosts'

/** Why a Notion call failed, for the model and the user. */
export type NotionErrorCode = 'no_notion_tab' | 'signed_out' | 'no_access' | 'notion_error'

export class NotionError extends Error {
  constructor(
    readonly code: NotionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'NotionError'
  }
}

export const NO_NOTION_TAB = 'No Notion page is open in this window.'
export const SIGNED_OUT = 'Not signed in to Notion in this tab. Sign in to Notion and try again.'
export const NO_ACCESS = "The Notion page doesn't exist, or the signed-in Notion account has no access to it."

/** The endpoints under /api/v3/ the client uses. */
export type NotionEndpoint = 'loadPageChunk' | 'syncRecordValuesMain' | 'saveTransactionsFanout'

/** What one request to Notion returned. `error` is set when no HTTP response came back. */
export interface NotionResponse {
  status: number
  json: unknown
  /** Whether the tab has a signed-in Notion user (the `notion_user_id` cookie). */
  signedIn: boolean
  error?: string
}

/** Sends one request to Notion as the user of a Notion tab (see tab.ts). */
export type NotionTransport = (
  endpoint: NotionEndpoint,
  body: unknown,
  options: { spaceId?: string },
) => Promise<NotionResponse>

export type Table = 'block' | 'collection' | 'collection_view' | 'discussion' | 'comment' | 'notion_user' | 'space'

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

/** A page and everything loadPageChunk returns with it (descendants, databases, comments). */
export interface LoadedPage {
  page: Block
  spaceId: string
  recordMap: RecordMap
  /** False if the page had more chunks than `maxChunks`. */
  complete: boolean
}

const CHUNK_LIMIT = 100

export class NotionClient {
  constructor(private readonly send: NotionTransport) {}

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
      if (!page.space_id) throw new NotionError('notion_error', 'Notion returned the page without its workspace.')
      spaceId = page.space_id
      if (!json.cursor?.stack?.length) return { page, spaceId, recordMap, complete: true }
      cursor = json.cursor
    }
    return { page: recordMap.block![pageId] as Block, spaceId: spaceId!, recordMap, complete: false }
  }

  /** Loads specific records of any table. Every requested record must come back. */
  async getRecords(pointers: Pointer[]): Promise<RecordMap> {
    const requested = pointers.map((p) => ({ ...p, id: notionId(p.id) }))
    const spaces = new Set(requested.map((p) => p.spaceId))
    const { json, signedIn } = await this.request<{ recordMap?: unknown }>(
      'syncRecordValuesMain',
      { requests: requested.map((pointer) => ({ pointer, version: -1 })) },
      spaces.size === 1 ? [...spaces][0] : undefined,
    )
    const recordMap = normalizeRecordMap(json.recordMap)
    if (requested.some((p) => !recordMap[p.table]?.[p.id])) throw missingRecord(signedIn)
    return recordMap
  }

  /** Applies operations in one transaction: Notion applies all of them or none. */
  async submitTransaction(spaceId: string, operations: Operation[], userAction: string): Promise<void> {
    // Text lives in CRDT form too; the server keeps it in sync with `properties`. Writing it
    // directly would corrupt the block.
    if (operations.some((op) => op.path.includes('crdt_data') || hasCrdtData(op.args))) {
      throw new NotionError('notion_error', 'Operations must not write crdt_data.')
    }
    // Records are keyed by dashed, lowercase ids; Notion's own client also names the space on each pointer.
    const ops = operations.map((op) => ({
      ...op,
      pointer: { ...op.pointer, id: notionId(op.pointer.id), spaceId: op.pointer.spaceId ?? spaceId },
    }))
    await this.request(
      'saveTransactionsFanout',
      {
        requestId: crypto.randomUUID(),
        transactions: [{ id: crypto.randomUUID(), spaceId, debug: { userAction }, operations: ops }],
      },
      spaceId,
    )
  }

  /** `spaceId`, when known, goes along as `x-notion-space-id`. */
  private async request<T>(
    endpoint: NotionEndpoint,
    body: unknown,
    spaceId?: string,
  ): Promise<{ json: T; signedIn: boolean }> {
    const res = await this.send(endpoint, body, { spaceId })
    return { json: checkResponse(res) as T, signedIn: res.signedIn }
  }
}

/** The JSON of a successful response, or a NotionError explaining the failure. */
export function checkResponse(res: NotionResponse): Record<string, unknown> {
  if (res.error !== undefined) throw new NotionError('notion_error', `Could not reach Notion: ${res.error}`)
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
  throw new NotionError('notion_error', `Notion returned an error (${res.status}${name}): ${String(detail)}`)
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
