// A fake Notion tab for tests of the extension's Notion code: stands in for chrome.tabs and
// chrome.scripting, and answers the page's requests with sanitized fixtures of Notion's responses.
import { readFileSync } from 'node:fs'
import { expect } from 'vitest'
import { NotionError } from '../../extension/src/notion/api'

export const SPACE = '5a5a5a5a-0000-4000-8000-000000000001'
export const USER = '0e0e0e0e-0000-4000-8000-000000000002'
export const PAGE = '1a1a1a1a-0000-4000-8000-000000000010'
export const BLOCKS = [
  '1b1b1b1b-0000-4000-8000-000000000011',
  '1b1b1b1b-0000-4000-8000-000000000012',
  '1b1b1b1b-0000-4000-8000-000000000013',
]
export const PAGE_URL = `https://app.notion.com/p/Fixture-page-${PAGE.replace(/-/g, '')}`

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/notion/${name}.json`, import.meta.url), 'utf8'))
}

export interface SentRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

const globals = globalThis as Record<string, unknown>
const saved = { chrome: globals.chrome, fetch: globals.fetch, location: globals.location, document: globals.document }

/** Puts back the globals a FakeNotionTab replaced. Call it after each test. */
export function restoreGlobals(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globals[key]
    else globals[key] = value
  }
}

/**
 * A browser window with one active tab, standing in for the chrome.tabs and chrome.scripting APIs.
 * executeScript runs the injected function the way Chrome does: rebuilt from its source, so it can
 * only use its own body, with JSON-cloned arguments, in a page that has the tab's location, cookies,
 * and fetch. The page's fetch answers with queued Notion responses.
 */
export class FakeNotionTab {
  sent: SentRequest[] = []
  injections: { tabId: number; world?: string }[] = []
  /** Responses per endpoint, in order. */
  responses: Record<string, { status: number; text: string }[]> = {}
  /** Where the page is when the script runs; defaults to the tab's URL. */
  pageUrl?: string
  closed = false
  /** Makes executeScript fail with this message while the tab is still open on Notion. */
  injectionError?: string
  networkDown = false
  /** Makes Notion answer with a redirect, as it might to a sign-in page. */
  redirects = false
  /** Answers requests no queued response is left for, like Notion would. */
  workspace?: FakeWorkspace

  /** Signals the page's requests were sent with, to check each has a timeout. */
  signals: (AbortSignal | null | undefined)[] = []

  constructor(
    readonly url: string | undefined,
    readonly cookie = `notion_browser_id=b; notion_user_id=${USER}; notion_users=%5B%22${USER}%22%5D`,
  ) {}

  respond(endpoint: string, status: number, json: unknown): this {
    return this.respondText(endpoint, status, JSON.stringify(json))
  }

  respondText(endpoint: string, status: number, text: string): this {
    ;(this.responses[endpoint] ??= []).push({ status, text })
    return this
  }

  install(): this {
    globals.chrome = {
      tabs: {
        query: async () => (this.url === undefined ? [] : [{ id: 7, url: this.url, title: 'Fixture page' }]),
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
          // The page's globals exist only while the script runs, so code outside the tab (say, the
          // agent calling the worker) keeps its own fetch.
          const outside = { fetch: globals.fetch, location: globals.location, document: globals.document }
          globals.location = location
          globals.document = { cookie: this.cookie }
          globals.fetch = (input: string, init: RequestInit) => this.fetch(new URL(input, location).href, init)
          try {
            const rebuilt = new Function(`return (${func.toString()})`)() as Function
            return [{ frameId: 0, result: await rebuilt(...structuredClone(args)) }]
          } finally {
            Object.assign(globals, outside)
          }
        },
      },
    }
    return this
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    if (this.networkDown) throw new TypeError('Failed to fetch')
    this.signals.push(init.signal)
    this.sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) })
    const endpoint = url.split('/api/v3/')[1]
    const queued = this.responses[endpoint]?.shift()
    const served = queued ?? this.workspace?.answer(endpoint, JSON.parse(init.body as string))
    const next = served && 'json' in served ? { status: served.status, text: JSON.stringify(served.json) } : served
    if (!next) throw new Error(`Unexpected request to ${url}`)
    if (this.redirects) {
      // A browser following a 307 sends the same body again, to wherever the redirect points.
      if (init.redirect !== 'manual') this.sent.push({ ...this.sent.at(-1)!, url: 'https://app.notion.com/login' })
      return Object.defineProperties(new Response(null), { type: { value: 'opaqueredirect' }, status: { value: 0 } })
    }
    return new Response(next.text, { status: next.status })
  }
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
  transactions: { operations: { pointer: { id: string }; path: string[]; command: string; args: unknown }[] }[] = []
  /** Makes the next transaction fail with Notion's validation error, applying nothing. */
  reject = false

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
      const visit = (id: string) => {
        const r = this.records.get(id)
        if (!r || block[id]) return
        block[id] = wrap(r)
        for (const c of (r.content as string[]) ?? []) visit(c)
      }
      visit(pageId)
      return { status: 200, json: { cursor: { stack: [] }, recordMap: { __version__: 3, block } } }
    }
    if (endpoint === 'syncRecordValuesMain') {
      const block: Record<string, unknown> = {}
      for (const { pointer } of body.requests as { pointer: { id: string } }[]) {
        const r = this.records.get(pointer.id)
        if (r) block[pointer.id] = wrap(r)
      }
      return { status: 200, json: { recordMap: { __version__: 3, block } } }
    }
    if (endpoint === 'saveTransactionsFanout') {
      if (this.reject) {
        this.reject = false
        return { status: 400, json: { isNotionError: true, name: 'ValidationError', debugMessage: 'Invalid input.' } }
      }
      for (const tx of body.transactions as FakeWorkspace['transactions']) {
        // All or nothing, like Notion: apply to a copy, and keep it only if every operation applies.
        const next = new Map([...this.records].map(([k, v]) => [k, structuredClone(v)]))
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
          const before = this.records.get(id)
          next.get(id)!.version = (before?.version ?? 0) + 1
        }
        this.records = next
        this.transactions.push(tx)
      }
      return { status: 200, json: {} }
    }
    return undefined
  }
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
    default:
      throw new Error(`Unexpected command ${op.command}`)
  }
}
