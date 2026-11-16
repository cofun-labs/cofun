import type { AiBinding } from '../src/app'
import type { RateLimiter } from '../src/http'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Database, Statement } from '../src/credits'
import type { UsageDataset } from '../src/usage'
import type { SearchOptions } from '../src/search'
import type { BrowserBinding, WebFetcher } from '../src/web'

type Call = { model: string; inputs: Record<string, unknown>; options?: Record<string, unknown> }

/** A model the worker has prices for: the tests are charged the real prices. */
export const MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017'

/** Token counts the fake model reports for a reply, unless a test sets its own. */
export const FAKE_USAGE = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }

/** What a reply reporting FAKE_USAGE costs, in micro-credits: 12 input tokens at 300 and 5 output tokens at 1200. */
export const FAKE_COST = 9600

/** Token counts for a reply that costs `credits`, all of it new input: 300 micro-credits a token. */
export const usageCosting = (credits: number) => {
  const prompt_tokens = Math.round((credits * 1_000_000) / 300)
  return { prompt_tokens, completion_tokens: 0, total_tokens: prompt_tokens }
}

/** A tool call the fake model makes: which tool, and its arguments as a JSON string. */
export interface FakeToolCall {
  name: string
  arguments: string
}

/** One scripted model reply: text, tool calls, or text followed by tool calls. */
export interface FakeTurn {
  reply?: string
  toolCalls?: FakeToolCall[]
}

/**
 * Stands in for the Workers AI binding (env.AI) with the same `run` signature,
 * replying in the OpenAI chat-completion shape that current models use.
 * Streams arrive in small byte slices, so lines and characters split across chunks.
 */
export class FakeAiBinding implements AiBinding {
  calls: Call[] = []
  failWith?: Error
  /** When set, a streamed call returns this raw SSE text instead of the reply. */
  rawSse?: string
  /** When set, a streamed call fails with this error after sending the first slice. */
  streamFailWith?: Error
  /** When set, a streamed reply stops once `after` bytes are sent, until `until` resolves: a model still writing. */
  pause?: { after: number; until: Promise<void> }
  /** When set, the model writes the reply as a preamble and then asks the client to run these tools. */
  toolCalls?: FakeToolCall[]
  /**
   * Replies for the next calls, one per call, used before `reply` and `toolCalls`:
   * a turn with tool calls asks the client to run them, one without answers with its text.
   */
  script: FakeTurn[] = []
  /** The token counts every reply reports. */
  usage: Record<string, unknown> = FAKE_USAGE
  private nextToolCallId = 0

  /** Every web search asked for (`websearch`), with its options. */
  searches: SearchOptions[] = []
  /** The results a search for a query finds; a query not set finds none. */
  readonly found = new Map<string, { url: string; title: string; description: string }[]>()
  /** When set, every search answers this instead of results: a refusal, or an answer of another shape. */
  searchReply?: () => Response

  constructor(private reply = 'Hello from Workers AI') {}

  /** Answers a search the way AI Gateway's Web Search API does, from `found`. */
  async websearch(options: SearchOptions): Promise<Response> {
    this.searches.push(options)
    if (this.searchReply) return this.searchReply()
    const items = (this.found.get(options.query) ?? []).slice(0, options.limit)
    return Response.json({ items, metadata: { query: options.query, requestId: 'req-1', latencyMs: 300 } })
  }

  async run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ model, inputs, options })
    if (this.failWith) throw this.failWith

    const turn = this.script.shift()
    const reply = turn ? (turn.reply ?? '') : this.reply
    const toolCalls = turn ? turn.toolCalls : this.toolCalls
    if (toolCalls) return this.toolCallReply(model, toolCalls, inputs, reply)

    if (!inputs.stream) {
      return {
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: this.usage,
      }
    }

    if (this.rawSse !== undefined) return new Response(this.rawSse).body

    const events: unknown[] = reply.split(' ').map((w) => ({ choices: [{ index: 0, delta: { content: w + ' ' } }] }))
    events.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    // Like OpenAI, usage comes in a last chunk with no choices, only when asked for.
    const streamOptions = inputs.stream_options as { include_usage?: boolean } | undefined
    if (streamOptions?.include_usage) events.push({ choices: [], usage: this.usage })
    return sliced(new TextEncoder().encode(toSse(events)), this.streamFailWith, this.pause)
  }

  /**
   * A reply that asks the client to run tools, in the shapes the real model returns (recorded in #35).
   * Streamed, each call's name comes first and its arguments follow in pieces, and usage arrives the
   * Workers AI way: per-chunk counts, a zeroed chunk, then a `response` chunk with the totals.
   */
  private toolCallReply(model: string, toolCalls: FakeToolCall[], inputs: Record<string, unknown>, reply: string) {
    // Like the real model's random ids, these don't repeat across replies.
    const ids = toolCalls.map(() => `chatcmpl-tool-${this.nextToolCallId++}`)
    if (!inputs.stream) {
      return {
        object: 'chat.completion',
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: reply,
              tool_calls: toolCalls.map((t, i) => ({
                id: ids[i],
                type: 'function',
                function: { name: t.name, arguments: t.arguments },
              })),
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: this.usage,
      }
    }

    const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
      choices: [{ index: 0, delta, finish_reason }],
      usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
    })
    const events: unknown[] = [
      {
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        usage: {
          prompt_tokens: this.usage.prompt_tokens,
          completion_tokens: 0,
          total_tokens: this.usage.prompt_tokens,
        },
      },
      ...(reply ? reply.split(' ').map((w) => chunk({ content: w + ' ' })) : []),
    ]
    // Short arguments (`{}`) come with the name; longer ones follow it in pieces, and the last piece
    // carries the finish reason. After short arguments the finish reason comes in a chunk of its own.
    let finishedOnPiece = false
    toolCalls.forEach((t, index) => {
      const head = { id: ids[index], type: 'function', index, function: { name: t.name } }
      finishedOnPiece = false
      if (t.arguments.length <= 2) {
        events.push(chunk({ tool_calls: [{ ...head, function: { ...head.function, arguments: t.arguments } }] }))
        return
      }
      events.push(chunk({ tool_calls: [head] }))
      for (let i = 0; i < t.arguments.length; i += 8) {
        const last = i + 8 >= t.arguments.length && index === toolCalls.length - 1
        const piece = { tool_calls: [{ index, function: { arguments: t.arguments.slice(i, i + 8) } }] }
        events.push(chunk(piece, last ? 'tool_calls' : null))
        finishedOnPiece ||= last
      }
    })
    if (!finishedOnPiece) events.push(chunk({}, 'tool_calls'))
    const streamOptions = inputs.stream_options as { include_usage?: boolean } | undefined
    if (streamOptions?.include_usage) {
      events.push({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
      events.push({ response: '', usage: this.usage })
    }
    return sliced(new TextEncoder().encode(toSse(events)), this.streamFailWith, this.pause)
  }
}

const toSse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'

function sliced(
  bytes: Uint8Array,
  failWith?: Error,
  pause?: { after: number; until: Promise<void> },
  size = 16,
): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    async pull(controller) {
      if (failWith && offset > 0) return controller.error(failWith)
      if (pause && offset >= pause.after) await pause.until
      if (offset >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(offset, (offset += size)))
    },
  })
}

/** The schema as deployed: every migration file, in order. */
const MIGRATIONS = join(import.meta.dirname, '../migrations')

/**
 * Stands in for the D1 binding (env.DB) with the slice of its interface the worker uses, over a
 * real SQLite database in memory with the deployed schema: the worker's own SQL is what runs. Like
 * D1, a batch is one transaction, and batches run one at a time.
 */
export class FakeD1Database implements Database {
  readonly sqlite = new DatabaseSync(':memory:')
  /** When set, every statement fails with this error, like an unreachable database. */
  failWith?: Error
  /** When set, statements whose SQL contains `sql` fail with `error`, and nothing else does. */
  failOn?: { sql: string; error: Error }

  constructor() {
    const files = readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith('.sql'))
      .toSorted()
    for (const file of files) this.sqlite.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
  }

  prepare(query: string): FakeStatement {
    return new FakeStatement(this, query, [])
  }

  async batch(statements: Statement[]): Promise<{ results: unknown[] }[]> {
    const own = statements.map((statement) => {
      if (!(statement instanceof FakeStatement)) throw new Error('not a statement of this database')
      return statement
    })
    this.sqlite.exec('BEGIN')
    try {
      const results = own.map((statement) => statement.runNow())
      this.sqlite.exec('COMMIT')
      return results
    } catch (err) {
      this.sqlite.exec('ROLLBACK')
      throw err
    }
  }

  /** Every row of `table`, for tests that look at what was written. */
  rows(
    table:
      | 'grants'
      | 'manual_grants'
      | 'purchases'
      | 'grant_revocations'
      | 'spends'
      | 'spend_grants'
      | 'model_calls'
      | 'web_renders'
      | 'web_searches',
  ): Record<string, unknown>[] {
    return this.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
  }

  /** Every model call with its spend, as one row each: what a test looks at for a call and what it cost. */
  calls(): Record<string, unknown>[] {
    return this.sqlite
      .prepare(
        `SELECT m.id, s.user_id, s.product, s.kind, s.micro_credits, s.created_at, m.model, m.started_at, m.stream,
          m.outcome, m.finish_reason, m.prompt_tokens, m.cached_tokens, m.completion_tokens, m.estimated
        FROM model_calls m JOIN spends s ON s.id = m.spend_id ORDER BY m.id`,
      )
      .all()
  }

  /** Every render with its spend, as one row each: what a test looks at for a render and what it cost. */
  renders(): Record<string, unknown>[] {
    return this.sqlite
      .prepare(
        `SELECT s.user_id, s.product, s.kind, s.micro_credits, s.created_at, r.outcome, r.browser_ms
        FROM web_renders r JOIN spends s ON s.id = r.spend_id ORDER BY r.id`,
      )
      .all()
  }

  /** Every web search with its spend, as one row each: what a test looks at for a search and what it cost. */
  webSearches(): Record<string, unknown>[] {
    return this.sqlite
      .prepare(
        `SELECT s.user_id, s.product, s.kind, s.micro_credits, s.created_at, w.outcome, w.results
        FROM web_searches w JOIN spends s ON s.id = w.spend_id ORDER BY w.id`,
      )
      .all()
  }

  /** Every grant, with what is left of it: its amount less what was spent from it. */
  grants(): Record<string, unknown>[] {
    return this.sqlite
      .prepare(
        `SELECT g.*, g.amount - coalesce((SELECT sum(micro_credits) FROM spend_grants WHERE grant_id = g.id), 0) AS left
        FROM grants g ORDER BY g.id`,
      )
      .all()
  }

  failure(query: string): Error | undefined {
    if (this.failWith) return this.failWith
    if (this.failOn && query.includes(this.failOn.sql)) return this.failOn.error
  }
}

class FakeStatement implements Statement {
  constructor(
    private readonly db: FakeD1Database,
    private readonly query: string,
    private readonly values: (string | number | null)[],
  ) {}

  bind(...values: (string | number | null)[]): FakeStatement {
    return new FakeStatement(this.db, this.query, values)
  }

  async all(): Promise<{ results: unknown[] }> {
    return this.runNow()
  }

  runNow(): { results: unknown[] } {
    const failure = this.db.failure(this.query)
    if (failure) throw failure
    return { results: this.db.sqlite.prepare(this.query).all(...this.values) }
  }
}

/**
 * Stands in for a request's execution context: the worker hands it the work that must finish even
 * when the client has gone. The work runs either way; nothing here waits for it.
 */
export class FakeExecutionContext {
  props = {}
  waitUntil(_promise: Promise<unknown>): void {}
  passThroughOnException(): void {}
}

/** Stands in for the Analytics Engine dataset (env.USAGE): drops every data point written. */
export class FakeUsageDataset implements UsageDataset {
  writeDataPoint(): void {}
}

/**
 * Stands in for a rate limiting binding (env.CHAT_LIMIT, env.API_LIMIT): lets each key through `limit` times, and
 * counts which keys asked. Time never passes for it: a test that needs the period over makes a new one.
 */
export class FakeRateLimiter implements RateLimiter {
  keys: string[] = []

  constructor(private readonly max = Infinity) {}

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(key)
    return { success: this.keys.filter((k) => k === key).length <= this.max }
  }
}

/** A page a FakeWeb serves: a body with its type, or another status, with headers of its own. */
export interface FakePage {
  status?: number
  body?: string
  type?: string
  headers?: Record<string, string>
}

/**
 * Stands in for the internet the worker reads pages from (env.WEB): serves the pages a test set, by
 * address without the fragment, and answers 404 for any other. Records every address asked for, and
 * what each request carried.
 */
export class FakeWeb implements WebFetcher {
  readonly pages = new Map<string, FakePage>()
  readonly requests: Request[] = []
  /** When set, every request fails with this error, as an unreachable site's would. */
  failWith?: Error

  /** Serves `page` at `url`: HTML by default. */
  serve(url: string, page: FakePage | string): this {
    this.pages.set(url, typeof page === 'string' ? { body: page } : page)
    return this
  }

  get asked(): string[] {
    return this.requests.map((r) => r.url)
  }

  async fetch(request: Request): Promise<Response> {
    this.requests.push(request)
    if (this.failWith) throw this.failWith
    const page = this.pages.get(request.url)
    if (!page) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } })
    return new Response(page.body ?? '', {
      status: page.status ?? 200,
      headers: { 'content-type': page.type ?? 'text/html; charset=utf-8', ...page.headers },
    })
  }
}

/**
 * Stands in for Browser Run (env.BROWSER): renders the pages a test set as Markdown, and fails for
 * any other as Browser Run does for a page it could not load. Every response reports the browser
 * time it used (`X-Browser-Ms-Used`), as Browser Run's do, unless a test turns that off.
 */
export class FakeBrowserRun implements BrowserBinding {
  readonly pages = new Map<string, { markdown: string; browserMs: number }>()
  readonly calls: { action: string; options: Record<string, unknown> }[] = []
  /** The browser time a page it could not load reports. */
  failedMs = 1500
  /** When false, responses report no browser time. */
  reportsTime = true
  /** When set, the binding throws this, and no response comes back. */
  failWith?: Error
  /** Runs while a page renders, for a test that moves its clock. */
  during?: () => void

  render(url: string, markdown: string, browserMs = 4000): this {
    this.pages.set(url, { markdown, browserMs })
    return this
  }

  async quickAction(action: 'markdown', options: Record<string, unknown>): Promise<Response> {
    this.calls.push({ action, options })
    this.during?.()
    if (this.failWith) throw this.failWith
    const page = typeof options.url === 'string' ? this.pages.get(options.url) : undefined
    const used = (ms: number): Record<string, string> => (this.reportsTime ? { 'x-browser-ms-used': String(ms) } : {})
    if (page === undefined)
      return Response.json(
        { success: false, errors: [{ code: 5000, message: 'navigation failed' }] },
        { status: 422, headers: used(this.failedMs) },
      )
    return Response.json({ success: true, result: page.markdown }, { headers: used(page.browserMs) })
  }
}
