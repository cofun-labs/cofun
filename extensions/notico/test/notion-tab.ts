// A fake Notion tab for tests of the extension's Notion code: stands in for chrome.tabs and
// chrome.scripting, and answers the page's requests with sanitized fixtures of Notion's responses.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { NotionError } from '../src/notion/api'
import { notionCooldown } from '../src/notion/tab'

export const SPACE = '5a5a5a5a-0000-4000-8000-000000000001'
export const USER = '0e0e0e0e-0000-4000-8000-000000000002'
export const PAGE = '1a1a1a1a-0000-4000-8000-000000000010'
export const BLOCKS = [
  '1b1b1b1b-0000-4000-8000-000000000011',
  '1b1b1b1b-0000-4000-8000-000000000012',
  '1b1b1b1b-0000-4000-8000-000000000013',
]
export const PAGE_URL = `https://app.notion.com/p/Fixture-page-${PAGE.replace(/-/g, '')}`

// As a path, not a URL: in a DOM test environment the global URL is the DOM's, which node:fs does not take.
const FIXTURES = fileURLToPath(import.meta.resolve('./fixtures/notion'))

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}/${name}.json`, 'utf8'))
}

export interface SentRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

const globals = globalThis as Record<string, unknown>
const saved = { chrome: globals.chrome, fetch: globals.fetch }

/** Puts back the globals a FakeNotionTab replaced. Call it after each test. */
export function restoreGlobals(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globals[key]
    else globals[key] = value
  }
}

type StorageListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void

/**
 * Stands in for chrome.storage: the `local` area, and the change events every document of the
 * extension gets, the one that made the change included.
 */
export class FakeStorage {
  values: Record<string, unknown> = {}
  private listeners: StorageListener[] = []

  local = {
    get: async (key: string) => (key in this.values ? { [key]: this.values[key] } : {}),
    set: async (items: Record<string, unknown>) => {
      const changes: Parameters<StorageListener>[0] = {}
      for (const [key, newValue] of Object.entries(items)) {
        changes[key] = { oldValue: this.values[key], newValue }
        this.values[key] = newValue
      }
      for (const listener of this.listeners) listener(changes, 'local')
    },
  }

  onChanged = {
    addListener: (listener: StorageListener) => void this.listeners.push(listener),
    removeListener: (listener: StorageListener) => void (this.listeners = this.listeners.filter((l) => l !== listener)),
  }
}

/**
 * A browser window with one active tab, standing in for the chrome.tabs and chrome.scripting APIs.
 * executeScript runs the injected function the way Chrome does: rebuilt from its source, so it can
 * only use its own body, with JSON-cloned arguments, and sees the tab's location, cookies, and fetch
 * in place of the globals. The page's fetch answers with queued Notion responses.
 */
export class FakeNotionTab {
  sent: SentRequest[] = []
  injections: { tabId: number; world?: string }[] = []
  /** Responses per endpoint, in order. */
  responses: Record<string, { status: number; text: string; headers?: Record<string, string> }[]> = {}
  /** Where the page is when the script runs; defaults to the tab's URL. */
  pageUrl?: string
  closed = false
  /** Makes executeScript fail with this message while the tab is still open on Notion. */
  injectionError?: string
  networkDown = false
  /** Makes Notion never answer, as a stalled tab would. */
  stalled = false
  /** Makes Notion answer with a redirect, as it might to a sign-in page. */
  redirects = false
  /** The page's DOM, for scripts that read it (the selection); only what they use. */
  dom?: object

  /** Answers requests no queued response is left for, like Notion would. */
  workspace?: FakeWorkspace

  /** Signals the page's requests were sent with, to check each has a timeout. */
  signals: (AbortSignal | null | undefined)[] = []

  /** The tab's title, as chrome.tabs reports it. */
  title = 'Fixture page'

  constructor(
    /** Where the tab is; a test moves the user to another tab by changing it. */
    public url: string | undefined,
    readonly cookie = `notion_browser_id=b; notion_user_id=${USER}; notion_users=%5B%22${USER}%22%5D`,
  ) {}

  respond(endpoint: string, status: number, json: unknown): this {
    return this.respondText(endpoint, status, JSON.stringify(json))
  }

  respondText(endpoint: string, status: number, text: string, headers?: Record<string, string>): this {
    ;(this.responses[endpoint] ??= []).push({ status, text, headers })
    return this
  }

  /** Turns away the `nth` request to `endpoint` (1 is the first), letting the others through. */
  limitNth(endpoint: string, nth: number, status = 429): this {
    this.limitAt = { endpoint, nth, status }
    return this
  }

  private limitAt?: { endpoint: string; nth: number; status: number }
  private counts: Record<string, number> = {}

  /**
   * Notion turning `times` requests to `endpoint` away: too many requests (429), or too busy (529),
   * with a Retry-After header when `retryAfter` is given.
   */
  limit(endpoint: string, times: number, status = 429, retryAfter?: string): this {
    const body = JSON.stringify({ isNotionError: true, name: 'RateLimitedError', message: 'Rate limited' })
    for (let i = 0; i < times; i++) {
      this.respondText(endpoint, status, body, retryAfter === undefined ? undefined : { 'retry-after': retryAfter })
    }
    return this
  }

  /** The browser's chrome.storage, which all its side panels share. */
  storage = new FakeStorage()

  private activated: ((info: { tabId: number; windowId: number }) => void)[] = []
  private updated: ((tabId: number, change: { url?: string; title?: string }, tab: object) => void)[] = []

  /** The user switches to another tab, showing `url`; Chrome tells the side panel. */
  switchTab(url: string | undefined, title = ''): void {
    this.url = url
    this.title = title
    for (const listener of this.activated) listener({ tabId: 7, windowId: 1 })
  }

  /** The tab goes to `url` (or renames its page, given the same URL); Chrome tells the side panel. */
  navigate(url: string, title = this.title): void {
    const change = { ...(url !== this.url && { url }), ...(title !== this.title && { title }) }
    this.url = url
    this.title = title
    for (const listener of this.updated) listener(7, change, { id: 7, active: true, url, title })
  }

  install(): this {
    globals.chrome = {
      storage: this.storage,
      tabs: {
        query: async () => (this.url === undefined ? [] : [{ id: 7, url: this.url, title: this.title }]),
        onActivated: listeners(this.activated),
        onUpdated: listeners(this.updated),
        get: async (tabId: number) => {
          if (this.closed) throw new Error(`No tab with id: ${tabId}.`)
          return { id: tabId, url: this.pageUrl ?? this.url }
        },
      },
      scripting: {
        executeScript: async ({
          target,
          world,
          func,
          args,
        }: {
          target: { tabId: number }
          world?: string
          func: Function
          args: unknown[]
        }) => {
          if (this.closed) throw new Error(`No tab with id: ${target.tabId}.`)
          if (this.injectionError) throw new Error(this.injectionError)
          this.injections.push({ tabId: target.tabId, world })
          const location = new URL(this.pageUrl ?? this.url!)
          const document = Object.assign(this.dom ?? {}, { cookie: this.cookie })
          const fetch = (input: string, init: RequestInit) => this.fetch(new URL(input, location).href, init)
          // The page's globals are the function's own: its `location`, `document`, and `fetch` are
          // the tab's, while code outside the tab (say, the agent calling the worker, or the side
          // panel's own document) keeps the real ones.
          const rebuilt = new Function('location', 'document', 'fetch', `return (${func.toString()})`)(
            location,
            document,
            fetch,
          ) as Function
          return [{ frameId: 0, result: await rebuilt(...(asChromeSends(args) as unknown[])) }]
        },
      },
    }
    // A new browser: no wait is left over from Notion turning an earlier test's requests away.
    notionCooldown.clear()
    notionCooldown.now = () => Date.now()
    return this
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    if (this.networkDown) throw new TypeError('Failed to fetch')
    if (this.stalled) return new Promise<Response>(() => {})
    this.signals.push(init.signal)
    this.sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) })
    const endpoint = url.split('/api/v3/')[1]
    this.counts[endpoint] = (this.counts[endpoint] ?? 0) + 1
    if (this.limitAt?.endpoint === endpoint && this.limitAt.nth === this.counts[endpoint]) {
      const body = { isNotionError: true, name: 'RateLimitedError', message: 'Rate limited' }
      return new Response(JSON.stringify(body), { status: this.limitAt.status })
    }
    const queued = this.responses[endpoint]?.shift()
    const served = queued ?? this.workspace?.answer(endpoint, JSON.parse(init.body as string))
    const next: { status: number; text: string; headers?: Record<string, string> } | undefined =
      served && 'json' in served ? { status: served.status, text: JSON.stringify(served.json) } : served
    if (!next) throw new Error(`Unexpected request to ${url}`)
    if (this.redirects) {
      // A browser following a 307 sends the same body again, to wherever the redirect points.
      if (init.redirect !== 'manual') this.sent.push({ ...this.sent.at(-1)!, url: 'https://app.notion.com/login' })
      return Object.defineProperties(new Response(null), { type: { value: 'opaqueredirect' }, status: { value: 0 } })
    }
    return new Response(next.text, { status: next.status, headers: next.headers })
  }
}

/** A chrome.events.Event that keeps its listeners in `list`. */
function listeners<L>(list: L[]) {
  return {
    addListener: (listener: L) => void list.push(listener),
    removeListener: (listener: L) => {
      const i = list.indexOf(listener)
      if (i >= 0) list.splice(i, 1)
    },
  }
}

/**
 * Script arguments as Chrome hands them to the page: copied, with object keys whose value is null
 * left out (Chrome's conversion of extension API arguments strips them).
 */
function asChromeSends(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(asChromeSends)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).flatMap(([k, v]) => (v === null ? [] : [[k, asChromeSends(v)]])))
  return value
}

export function pageTab(url = PAGE_URL, cookie?: string) {
  return new FakeNotionTab(url, cookie)
    .respond('loadPageChunk', 200, fixture('load-page-chunk-0'))
    .respond('loadPageChunk', 200, fixture('load-page-chunk-1'))
    .install()
}

export async function notionError(promise: Promise<unknown>): Promise<NotionError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(NotionError)
  return err as NotionError
}

type NotionRecordLike = Record<string, unknown> & { id: string; version: number }

/**
 * A Notion workspace in memory: holds records, applies transactions the way Notion does (each
 * changed record gets a new version), and answers reads in Notion's response shapes.
 */
export class FakeWorkspace {
  records = new Map<string, NotionRecordLike>()
  /** Transactions applied, in order. */
  transactions: {
    operations: { pointer: { id: string; table?: string }; path: string[]; command: string; args: unknown }[]
  }[] = []
  /** Makes the next transaction fail with Notion's validation error, applying nothing. */
  reject = false
  /** Makes the next transaction apply, then answer with a server error, as a lost answer would. */
  failAfterApply = false
  /** Databases' data sources (their schemas), by collection id. */
  collections = new Map<string, NotionRecordLike>()
  /** Background tasks (duplicates), by task id; each reports `in_progress` once before it ends. */
  tasks = new Map<string, { polls: number; result: Record<string, unknown> }>()
  /** Makes the next duplicate fail on Notion's side. */
  failTask = false
  /** Makes the next duplicate keep running with this error, as a misrouted task does in Notion. */
  stuckTask?: string
  /** Makes the next duplicate keep running, with no error, for as long as it is checked. */
  endlessTask = false
  /** deleteContentRecords requests, as sent. */
  contentDeletes: { records: { id: string }[]; permanentlyDelete: unknown }[] = []
  /** The table of each record that isn't a block (discussions, comments, users), by id. */
  tables = new Map<string, string>()
  /** The users getVisibleUsers lists, by id; every user record when not set. */
  visibleUsers?: string[]

  constructor(
    blocks: Record<string, unknown>[],
    readonly spaceId: string,
  ) {
    for (const b of blocks)
      this.records.set(
        b.id as string,
        { version: 1, alive: true, space_id: spaceId, ...b } as unknown as NotionRecordLike,
      )
  }

  /** Adds a record of another table than `block`: a discussion, a comment, or a user. */
  put(table: string, record: Record<string, unknown>): this {
    this.records.set(record.id as string, { version: 1, ...record } as NotionRecordLike)
    this.tables.set(record.id as string, table)
    return this
  }

  /** The records of a table other than `block`. */
  table(name: string): NotionRecordLike[] {
    return [...this.tables].filter(([, t]) => t === name).map(([id]) => this.records.get(id)!)
  }

  /** A user editing the page in Notion: changes a record's fields, and its version. */
  edit(id: string, fields: Record<string, unknown>): void {
    const r = this.records.get(id)!
    this.records.set(id, { ...r, ...fields, version: r.version + 1 })
  }

  /** The blocks under `id`, in order, alive or not as Notion keeps them. */
  content(id: string): NotionRecordLike[] {
    return ((this.records.get(id)?.content as string[]) ?? []).map((c) => this.records.get(c)!).filter(Boolean)
  }

  answer(endpoint: string, body: Record<string, unknown>): { status: number; json: unknown } | undefined {
    const wrap = (r: NotionRecordLike) => ({
      spaceId: this.spaceId,
      value: { role: 'editor', value: structuredClone(r) },
    })
    if (endpoint === 'loadPageChunk') {
      const pageId = (body.page as { id: string }).id
      if (!this.records.has(pageId))
        return { status: 200, json: { cursor: { stack: [] }, recordMap: { __version__: 3 } } }
      const block: Record<string, unknown> = {}
      // Like Notion, the page's chunk carries the discussions on its blocks and their comments.
      const discussion: Record<string, unknown> = {}
      const comment: Record<string, unknown> = {}
      const visit = (id: string) => {
        const r = this.records.get(id)
        if (!r || block[id]) return
        block[id] = wrap(r)
        for (const d of (r.discussions as string[]) ?? []) {
          const thread = this.records.get(d)
          if (!thread) continue
          discussion[d] = wrap(thread)
          for (const c of (thread.comments as string[]) ?? []) {
            const found = this.records.get(c)
            if (found) comment[c] = wrap(found)
          }
        }
        for (const c of (r.content as string[]) ?? []) visit(c)
      }
      visit(pageId)
      const comments = Object.keys(discussion).length ? { discussion, comment } : {}
      // Like Notion, the people its blocks mention come along.
      const notion_user: Record<string, unknown> = {}
      for (const b of Object.values(block) as { value: { value: NotionRecordLike } }[]) {
        for (const user of mentionedUsers(b.value.value.properties)) {
          const r = this.tables.get(user) === 'notion_user' ? this.records.get(user) : undefined
          if (r) notion_user[user] = wrap(r)
        }
      }
      const users = Object.keys(notion_user).length ? { notion_user } : {}
      return {
        status: 200,
        json: { cursor: { stack: [] }, recordMap: { __version__: 3, block, ...comments, ...users } },
      }
    }
    if (endpoint === 'syncRecordValuesMain') {
      const out: Record<string, Record<string, unknown>> = { block: {} }
      for (const { pointer } of body.requests as { pointer: { id: string; table: string } }[]) {
        const r =
          pointer.table === 'collection' && this.collections.has(pointer.id)
            ? this.collections.get(pointer.id)
            : (this.tables.get(pointer.id) ?? 'block') === pointer.table
              ? this.records.get(pointer.id)
              : undefined
        if (r) (out[pointer.table] ??= {})[pointer.id] = wrap(r)
      }
      return { status: 200, json: { recordMap: { __version__: 3, ...out } } }
    }
    if (endpoint === 'queryCollection') {
      // A database's rows, in the order they were added; the view's filters and sorts don't apply.
      const collectionId = (body.source as { id: string }).id
      const limit = (body.loader as { reducers: { collection_group_results: { limit: number } } }).reducers
        .collection_group_results.limit
      const rows = [...this.records.values()].filter(
        (r) => r.parent_id === collectionId && r.parent_table === 'collection' && r.alive !== false,
      )
      const shown = rows.slice(0, limit)
      return {
        status: 200,
        json: {
          result: {
            reducerResults: {
              collection_group_results: {
                type: 'results',
                blockIds: shown.map((r) => r.id),
                hasMore: rows.length > limit,
              },
            },
          },
          recordMap: { __version__: 3, block: Object.fromEntries(shown.map((r) => [r.id, wrap(r)])) },
        },
      }
    }
    if (endpoint === 'getVisibleUsers') {
      if (body.spaceId !== this.spaceId) return { status: 400, json: { name: 'ValidationError' } }
      const users = (this.visibleUsers ?? this.table('notion_user').map((u) => u.id)).map((userId) => ({
        userId,
        membershipType: 'member',
        firstJoinedSpaceTime: 0,
        aliases: [],
      }))
      return { status: 200, json: { users, userSimilarity: {}, shouldUseEdgeCache: false, joinedMemberIds: [] } }
    }
    if (endpoint === 'enqueueTask') {
      const task = body.task as { eventName: string; request: Record<string, unknown> }
      const taskId = `${crypto.randomUUID()}:fake-cell`
      if (task.eventName !== 'duplicateSubtree') return { status: 400, json: { name: 'ValidationError' } }
      const request = task.request as {
        source: { ids: string[]; spaceId?: string }
        destination: { parent: { id: string; spaceId?: string }; siblingId: string }
      }
      // Notion routes the task by its workspace; without it the task fails, as it does in Notion.
      if (request.source.spaceId !== this.spaceId || request.destination.parent.spaceId !== this.spaceId) {
        this.tasks.set(taskId, { polls: 0, result: { state: 'in_progress', error: 'Invalid input.' } })
        return { status: 200, json: { taskId } }
      }
      if (this.endlessTask) {
        this.tasks.set(taskId, { polls: 0, result: { state: 'in_progress' } })
        this.endlessTask = false
        return { status: 200, json: { taskId } }
      }
      if (this.stuckTask) {
        this.tasks.set(taskId, { polls: 0, result: { state: 'in_progress', error: this.stuckTask } })
        this.stuckTask = undefined
        return { status: 200, json: { taskId } }
      }
      if (this.failTask) {
        this.failTask = false
        this.tasks.set(taskId, { polls: 0, result: { state: 'failure', error: 'Copy failed.' } })
        return { status: 200, json: { taskId } }
      }
      const copy = this.duplicate(request.source.ids[0], request.destination.parent.id, request.destination.siblingId)
      this.tasks.set(taskId, { polls: 0, result: { state: 'success', status: { targetIds: [copy] } } })
      return { status: 200, json: { taskId } }
    }
    if (endpoint === 'getTasks') {
      const results = (body.taskIds as string[]).map((id) => {
        const task = this.tasks.get(id)!
        const result = task.polls++ === 0 ? { state: 'in_progress' } : task.result
        return { id, eventName: 'duplicateSubtree', ...result }
      })
      return { status: 200, json: { results } }
    }
    if (endpoint === 'deleteContentRecords') {
      this.contentDeletes.push(body as FakeWorkspace['contentDeletes'][number])
      return { status: 200, json: { recordMap: { __version__: 3 } } }
    }
    if (endpoint === 'saveTransactionsFanout') {
      if (this.reject) {
        this.reject = false
        return { status: 400, json: { isNotionError: true, name: 'ValidationError', debugMessage: 'Invalid input.' } }
      }
      for (const tx of body.transactions as FakeWorkspace['transactions']) {
        // All or nothing, like Notion: apply to a copy, and keep it only if every operation applies.
        // Databases' collections change in transactions too.
        const next = new Map([...this.records, ...this.collections].map(([k, v]) => [k, structuredClone(v)]))
        const touched = new Set<string>()
        try {
          for (const op of tx.operations) {
            applyOperation(next, op)
            touched.add(op.pointer.id)
          }
        } catch (err) {
          // Notion refuses the whole transaction.
          return {
            status: 400,
            json: { isNotionError: true, name: 'ValidationError', debugMessage: (err as Error).message },
          }
        }
        for (const id of touched) {
          const before = this.records.get(id) ?? this.collections.get(id)
          next.get(id)!.version = (before?.version ?? 0) + 1
        }
        for (const id of this.collections.keys()) {
          this.collections.set(id, next.get(id)!)
          next.delete(id)
        }
        this.records = next
        for (const op of tx.operations) {
          const table = op.pointer.table ?? 'block'
          if (op.command === 'set' && !op.path.length && table !== 'block') this.tables.set(op.pointer.id, table)
        }
        this.transactions.push(tx)
      }
      if (this.failAfterApply) {
        this.failAfterApply = false
        return { status: 502, json: { isNotionError: true, name: 'BadGateway', debugMessage: 'Bad gateway.' } }
      }
      return { status: 200, json: {} }
    }
    return undefined
  }

  /**
   * Copies a page and everything under it, as Notion's duplicateSubtree does: new ids throughout,
   * a number added to the title, and the copy right after `siblingId` in `parentId`.
   */
  private duplicate(sourceId: string, parentId: string, siblingId: string): string {
    const copyOf = (id: string, parent: string): string => {
      const r = this.records.get(id)!
      const copy = structuredClone(r)
      copy.id = crypto.randomUUID()
      copy.version = 1
      copy.parent_id = parent
      copy.parent_table = 'block'
      copy.copied_from = id
      copy.content = ((r.content as string[] | undefined) ?? []).map((c) => copyOf(c, copy.id))
      this.records.set(copy.id, copy)
      return copy.id
    }
    const copyId = copyOf(sourceId, parentId)
    const copy = this.records.get(copyId)!
    const title = (copy.properties as { title?: string[][] } | undefined)?.title?.[0]?.[0] ?? 'Untitled'
    copy.properties = { ...(copy.properties as object), title: [[`${title} (1)`]] }
    const parent = this.records.get(parentId)!
    const list = [...((parent.content as string[]) ?? [])]
    list.splice(list.indexOf(siblingId) + 1, 0, copyId)
    this.records.set(parentId, { ...parent, content: list, version: parent.version + 1 })
    return copyId
  }
}

/** The users rich text properties mention (`u` marks). */
function mentionedUsers(properties: unknown): string[] {
  return Object.values((properties ?? {}) as Record<string, unknown>).flatMap((value) =>
    Array.isArray(value)
      ? value.flatMap((run) =>
          Array.isArray(run) && Array.isArray(run[1])
            ? (run[1] as unknown[][]).flatMap((m) => (m[0] === 'u' && typeof m[1] === 'string' ? [m[1]] : []))
            : [],
        )
      : [],
  )
}

function applyOperation(
  records: Map<string, NotionRecordLike>,
  op: { pointer: { id: string }; path: string[]; command: string; args: unknown },
): void {
  const id = op.pointer.id
  const args = op.args as Record<string, unknown>
  if (op.command === 'set' && op.path.length === 0) {
    if (records.has(id)) throw new Error(`Record ${id} already exists`)
    records.set(id, structuredClone(args) as NotionRecordLike)
    return
  }
  const record = records.get(id)
  if (!record) throw new Error(`No record ${id} for ${op.command}`)
  // Notion's own rule: property values change only through updateBlockPropertyValue.
  if ((op.command === 'set' || op.command === 'update') && op.path[0] === 'properties') {
    throw new Error('Block property value updates must use high-level property operations.')
  }
  if (op.command === 'update' && op.path.length === 0 && 'properties' in args) {
    throw new Error('Block property value updates must use high-level property operations.')
  }
  const at = (path: string[]) =>
    path.reduce<Record<string, unknown>>((o, k) => (o[k] ??= {}) as Record<string, unknown>, record)
  switch (op.command) {
    case 'update':
      Object.assign(at(op.path), structuredClone(args))
      return
    case 'updateCollectionPropertySchema':
    case 'updateCollectionDeletedPropertySchema': {
      // A database's properties, as Notion's web client changes them (see collectionOps).
      const field = op.command === 'updateCollectionPropertySchema' ? 'schema' : 'deleted_schema'
      if (op.path[0] !== field) throw new Error(`${op.command} must change ${field}`)
      const primitive = args.primitiveOp as { command: string; args: unknown }
      const parentPath = op.path.slice(0, -1)
      const last = op.path.at(-1)!
      // Only the schema itself may be created on the way; a property or an option must exist.
      const existing = (path: string[]) =>
        path.reduce<Record<string, unknown>>((o, k) => {
          if (!o[k] || typeof o[k] !== 'object') throw new Error(`No ${path.join('.')} to change`)
          return o[k] as Record<string, unknown>
        }, record)
      switch (primitive.command) {
        case 'update': {
          const target = op.path.length === 1 ? at(op.path) : existing(op.path)
          for (const [key, value] of Object.entries(primitive.args as object)) {
            if (value === null) delete target[key]
            else target[key] = structuredClone(value)
          }
          return
        }
        case 'set':
          existing(parentPath)[last] = structuredClone(primitive.args)
          return
        case 'keyedObjectListAfter':
        case 'keyedObjectListUpdate':
        case 'keyedObjectListRemove': {
          const holder = existing(parentPath)
          const list = (Array.isArray(holder[last]) ? holder[last] : []) as { id: string }[]
          const { value, remove } = primitive.args as { value?: { id: string }; remove?: { id: string } }
          const i = list.findIndex((o) => o.id === (value ?? remove)!.id)
          if (primitive.command === 'keyedObjectListAfter') {
            if (i >= 0) throw new Error(`Option ${value!.id} already exists`)
            holder[last] = [...list, structuredClone(value)]
          } else {
            if (i < 0) throw new Error(`No option ${(value ?? remove)!.id}`)
            holder[last] =
              primitive.command === 'keyedObjectListUpdate'
                ? list.map((o, n) => (n === i ? structuredClone(value) : o))
                : list.filter((_, n) => n !== i)
          }
          return
        }
        default:
          throw new Error(`Unexpected primitive op ${primitive.command}`)
      }
    }
    case 'updateBlockPropertyValue': {
      const primitive = args.primitiveOp as { command: string; args: Record<string, unknown> }
      if (primitive.command !== 'update') throw new Error(`Unexpected primitive op ${primitive.command}`)
      Object.assign(at(op.path), structuredClone(primitive.args))
      return
    }
    case 'listAfter':
    case 'listBefore':
    case 'listRemove': {
      const list = ((record[op.path[0]] as string[] | undefined) ?? []).filter((x) => x !== args.id)
      // A block goes only into the list of the block it names as its parent.
      if (op.command !== 'listRemove' && records.get(args.id as string)?.parent_id !== id) {
        throw new Error(`${String(args.id)} does not have ${id} as its parent`)
      }
      if (op.command === 'listAfter') {
        const i = args.after ? list.indexOf(args.after as string) : list.length - 1
        if (args.after && i < 0) throw new Error(`listAfter: ${String(args.after)} not in list`)
        list.splice(i + 1, 0, args.id as string)
      } else if (op.command === 'listBefore') {
        const i = args.before ? list.indexOf(args.before as string) : 0
        if (args.before && i < 0) throw new Error(`listBefore: ${String(args.before)} not in list`)
        list.splice(i, 0, args.id as string)
      }
      record[op.path[0]] = list
      return
    }
    case 'insertChildrenAfter': {
      // Notion's "Move to": it takes each page out of its old parent itself.
      const { ids, after } = args as { ids: string[]; after?: string }
      for (const moved of ids) {
        for (let at: NotionRecordLike | undefined = record; at;) {
          if (at.id === moved) throw new Error('incomplete_ancestor_path')
          at = at.parent_table === 'block' ? records.get(at.parent_id as string) : undefined
        }
        const child = records.get(moved)
        if (!child) throw new Error(`No record ${moved} to move`)
        const old = records.get(child.parent_id as string)
        const oldList = child.parent_table === 'block' ? 'content' : 'pages'
        if (old) old[oldList] = ((old[oldList] as string[] | undefined) ?? []).filter((x) => x !== moved)
        child.parent_id = id
        child.parent_table = 'block'
      }
      const list = ((record.content as string[] | undefined) ?? []).filter((x) => !ids.includes(x))
      const i = after ? list.indexOf(after) + 1 : list.length
      list.splice(i, 0, ...ids)
      record.content = list
      return
    }
    case 'removeChild': {
      // Notion's "Move to Trash": out of the parent's list, and into the trash.
      const childId = args.id as string
      const child = records.get(childId)
      if (!child || child.parent_id !== id) throw new Error(`${childId} does not have ${id} as its parent`)
      record[op.path[0]] = ((record[op.path[0]] as string[] | undefined) ?? []).filter((x) => x !== childId)
      child.alive = false
      child.moved_to_trash_time = Date.now()
      return
    }
    default:
      throw new Error(`Unexpected command ${op.command}`)
  }
}
