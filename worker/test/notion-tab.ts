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
    const next = this.responses[endpoint]?.shift()
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
