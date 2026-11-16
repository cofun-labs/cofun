// Runs Notico's real agent (extensions/notico/src/agent/) against the worker, for what the two must
// agree on: the streamed reply, the tool-call round trip, sessions, credits, the cost of a question,
// and a model change. The agent's own rules are tested in extensions/notico/test/agent.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  CopilotAgent,
  type AgentConfig,
  type AgentUpdate,
  type QuestionExtras,
  type ConfirmTool,
  type HistoryMessage,
  type ToolSpec,
} from '../../extensions/notico/src/agent'
import { WebError } from '../../extensions/notico/src/agent/types'
import { readWebPage, searchWebFor } from '../../extensions/notico/src/agent/worker'
import { createApp, type Env } from '../src/app'
import { priceOf } from '../src/pricing'
import { FakeClerk } from './clerk'
import {
  FAKE_COST,
  FakeAiBinding,
  FakeBrowserRun,
  FakeD1Database,
  FakeExecutionContext,
  FakeUsageDataset,
  FakeRateLimiter,
  MODEL,
  usageCosting,
} from './fakes'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
let clock = new Date('2026-11-08T12:00:00Z')
/** The model a deploy switches to in the tests of a model change. It costs what the first one does. */
const NEXT_MODEL = '@cf/test/next-model'
const app = createApp({ now: () => clock, priceOf: (model) => priceOf(model === NEXT_MODEL ? MODEL : model) })
let clerk: FakeClerk
let env: Env
let ai: FakeAiBinding
let browser: FakeBrowserRun
let token: string

const realFetch = globalThis.fetch

beforeAll(async () => {
  clerk = await FakeClerk.create()
  // The extension calls fetch(); route it into the worker app.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(new Request(input, init), undefined, env, new FakeExecutionContext())) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  delete (globalThis as { chrome?: unknown }).chrome
})

beforeEach(async () => {
  clock = new Date('2026-11-08T12:00:00Z')
  env = {
    AI: (ai = new FakeAiBinding('你好 来自 worker')),
    BROWSER: (browser = new FakeBrowserRun()),
    AI_GATEWAY_ID: 'gw-test',
    DB: new FakeD1Database(),
    USAGE: new FakeUsageDataset(),
    CHAT_LIMIT: new FakeRateLimiter(),
    API_LIMIT: new FakeRateLimiter(),
    WEB_LIMIT: new FakeRateLimiter(),
    RENDER_LIMIT: new FakeRateLimiter(),
    SEARCH_LIMIT: new FakeRateLimiter(),
    MODEL,
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: EXT,
  }
  token = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
})

/** A tool with no arguments that returns a fixed page; records each run. */
function pageTool(page = { title: 'Q4 Roadmap', url: 'https://www.notion.so/Q4-Roadmap-abc123' }) {
  const runs: unknown[] = []
  const tool: ToolSpec = {
    name: 'lookup_page',
    description: 'Returns the title and URL of a Notion page.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: async (args) => {
      runs.push(args)
      return JSON.stringify(page)
    },
  }
  return { tool, runs }
}

function makeAgent(
  options: {
    tools?: ToolSpec[]
    maxSteps?: number
    history?: { messages: number; chars: number }
    systemPrompt?: string
    getToken?: () => Promise<string | null>
    meter?: AgentConfig['meter']
    model?: AgentConfig['model']
  } = {},
  conversation?: HistoryMessage[],
) {
  return new CopilotAgent(
    {
      apiUrl: 'https://nk.example.dev/v1/',
      getToken: options.getToken ?? (async () => token),
      client: 'notico/1.2.3',
      names: { product: 'Notico', site: 'Notion' },
      systemPrompt: options.systemPrompt ?? 'You are Notico.',
      tools: options.tools ?? [pageTool().tool],
      maxSteps: options.maxSteps,
      history: options.history,
      meter: options.meter,
      model: options.model,
    },
    conversation,
  )
}

/**
 * Asks one question and collects what the side panel would show. The tokens it used, what it cost,
 * and the model that answered are kept apart from how it ended, for the tests about them.
 */
async function ask(agent: CopilotAgent, text: string, confirm?: ConfirmTool, extras?: QuestionExtras) {
  const updates: AgentUpdate[] = []
  const asked = await agent.ask(text, (u) => updates.push(u), confirm, extras)
  const { tokens, model, cost, rounds, conversation, ...result } = asked
  const reply = updates.map((u) => (u.type === 'text' ? u.delta : '')).join('')
  return { result, used: { tokens, model, cost }, rounds, conversation, updates, reply }
}

const PAGE_JSON = JSON.stringify({ title: 'Q4 Roadmap', url: 'https://www.notion.so/Q4-Roadmap-abc123' })

const sentMessages = (call: number) => ai.calls[call].inputs.messages as Record<string, unknown>[]

describe('extension agent against the worker', () => {
  it('[UC-NOTICO-CHAT-001-S01] a plain question gets a streamed answer', async () => {
    const { result, updates, reply } = await ask(makeAgent(), 'hi')
    expect(result).toEqual({ status: 'done' })
    expect(reply).toBe('你好 来自 worker ')
    expect(updates.filter((u) => u.type === 'text').length).toBeGreaterThan(1)
    // The agent names the server's model and offers its tools; the worker accepts the request as is.
    expect(ai.calls).toHaveLength(1)
    expect(ai.calls[0].inputs.tools).toEqual([
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'lookup_page' }) }),
    ])
    expect(sentMessages(0)).toEqual([
      { role: 'system', content: 'You are Notico.' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('[UC-NOTICO-AGENT-001-S04] a tool the model asks for runs in the extension and the answer uses its result', async () => {
    const { tool, runs } = pageTool()
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }, { reply: 'You are on Q4 Roadmap' }]
    const { result, updates, reply } = await ask(makeAgent({ tools: [tool] }), 'Which page am I on?')

    expect(result).toEqual({ status: 'done' })
    expect(runs).toEqual([{}])
    expect(updates.filter((u) => u.type !== 'text')).toEqual([
      { type: 'tool_start', id: 'chatcmpl-tool-0', name: 'lookup_page', args: {} },
      { type: 'tool_ready', id: 'chatcmpl-tool-0', args: {} },
      { type: 'tool_end', id: 'chatcmpl-tool-0', name: 'lookup_page', status: 'done', result: PAGE_JSON },
    ])
    expect(reply).toBe('You are on Q4 Roadmap ')
    // The second model call got the tool's result right after the call.
    expect(sentMessages(1).slice(-2)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'chatcmpl-tool-0', type: 'function', function: { name: 'lookup_page', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'chatcmpl-tool-0',
        content: JSON.stringify({ title: 'Q4 Roadmap', url: 'https://www.notion.so/Q4-Roadmap-abc123' }),
      },
    ])
  })

  it("[@no-uc:contract] reads only what it can from the worker's replies: anything else is an error, never a wrong value", async () => {
    const routed = globalThis.fetch
    const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    try {
      // The model lookup: a model that is not text is no model.
      const lookups: [number, unknown, string][] = [
        [200, { model: 5 }, 'HTTP 200'],
        [200, 'a model', 'HTTP 200'],
        [200, {}, 'HTTP 200'],
        [503, { error: { message: 'CLERK_JWT_KEY is not set' } }, 'CLERK_JWT_KEY is not set'],
        [500, { error: 'boom' }, 'HTTP 500'],
        [502, null, 'HTTP 502'],
      ]
      for (const [status, body, message] of lookups) {
        globalThis.fetch = (async () => answer(status, body)) as typeof fetch
        expect((await ask(makeAgent(), 'hi')).result, JSON.stringify(body)).toEqual({ status: 'error', message })
      }
      // A failed model request: the worker's own words when it gives them as text, wrapped or not.
      const failures: [unknown, string, string?][] = [
        [{ error: { code: 'bad_request', message: 'wrapped words' } }, 'wrapped words', 'bad_request'],
        [{ code: 'bad_request', message: 'unwrapped words' }, 'unwrapped words', 'bad_request'],
        // Otherwise what the SDK made of the body, as it is.
        [{ error: { message: 5 } }, '{"message":5}'],
        [{ error: 'boom' }, '"boom"'],
        [['boom'], '["boom"]'],
      ]
      for (const [body, message, code] of failures) {
        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
          String(input instanceof Request ? input.url : input).endsWith('/me')
            ? routed(input, init)
            : Promise.resolve(answer(400, body))) as typeof fetch
        const { result } = await ask(makeAgent(), 'hi')
        expect(result, JSON.stringify(body)).toEqual({ status: 'error', message, ...(code ? { code } : {}) })
      }
    } finally {
      globalThis.fetch = routed
    }
  })

  it('[@no-uc:contract] a panel left open across a model change looks the model up again', async () => {
    const agent = makeAgent()
    expect((await ask(agent, 'first')).result).toEqual({ status: 'done' })
    env.MODEL = NEXT_MODEL
    // The worker refuses the old model name before the model is called or credits are checked; the agent retries once.
    const { result, reply } = await ask(agent, 'second')
    expect(result).toEqual({ status: 'done' })
    expect(reply).toBe('你好 来自 worker ')
    expect(ai.calls.map((c) => c.model)).toEqual([MODEL, NEXT_MODEL])
    expect(sentMessages(1).map((m) => m.content)).toEqual(['You are Notico.', 'first', '你好 来自 worker ', 'second'])
  })

  it('[@no-uc:data] a model change after a tool ran is reported, not retried', async () => {
    const { tool, runs } = pageTool()
    const changing: ToolSpec = {
      ...tool,
      run: async (args, signal, context) => {
        env.MODEL = NEXT_MODEL
        return tool.run(args, signal, context)
      },
    }
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }, { reply: 'Q4 Roadmap' }]
    const agent = makeAgent({ tools: [changing] })
    const { result } = await ask(agent, 'Which page am I on?')
    expect(result).toEqual({ status: 'error', message: 'Notico was just updated. Ask it to continue.' })
    // The tool ran once; running the question again would run it again.
    expect(runs).toHaveLength(1)
    // The new model was looked up, so asking again works straight away.
    ai.script = []
    expect((await ask(agent, 'Thanks')).result).toEqual({ status: 'done' })
    expect(ai.calls.at(-1)!.model).toBe(NEXT_MODEL)
  })

  it('[@no-uc:access] asks to sign in when there is no session', async () => {
    const { result } = await ask(makeAgent({ getToken: async () => null }), 'hi')
    expect(result).toEqual({ status: 'error', message: 'Please sign in first.' })
    expect(ai.calls).toHaveLength(0)
  })

  it('[@no-uc:contract] shows the server reason for a rejected session', async () => {
    const { result } = await ask(makeAgent({ getToken: async () => 'not-a-jwt' }), 'hi')
    expect(result).toEqual({ status: 'error', message: 'invalid or expired session' })
  })

  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  const OUT_OF_CREDITS =
    'You have no credits left. Your next 200 free credits arrive on 2026-11-15 at 12:00 UTC, or you can buy credits.'

  it('[UC-NOTICO-CHAT-001-S09] shows when the next free credits arrive, and drops the refused question', async () => {
    // A user starts with 200 credits.
    ai.usage = usageCosting(200)
    const agent = makeAgent()
    expect((await ask(agent, 'first')).result).toEqual({ status: 'done' })
    expect((await ask(agent, 'second')).result).toEqual({
      status: 'error',
      message: OUT_OF_CREDITS,
      code: 'out_of_credits',
    })

    clock = new Date(clock.getTime() + WEEK_MS)
    await ask(agent, 'third')
    expect(sentMessages(1).map((m) => m.content)).toEqual(['You are Notico.', 'first', '你好 来自 worker ', 'third'])
  })

  it('[UC-NOTICO-CHAT-001-S11] a question answered with one tool costs the credits of both model calls', async () => {
    ai.usage = usageCosting(90)
    const { tool, runs } = pageTool()
    const agent = makeAgent({ tools: [tool] })
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }]
    expect((await ask(agent, 'Which page am I on?')).result).toEqual({ status: 'done' })
    expect(runs).toHaveLength(1)
    expect(ai.calls).toHaveLength(2)

    // Both calls were charged: 20 of the 200 credits are left, enough to start one more call and no more.
    expect((await ask(agent, 'hi')).result).toEqual({ status: 'done' })
    expect(ai.calls).toHaveLength(3)
    expect((await ask(agent, 'again')).result).toEqual({
      status: 'error',
      message: OUT_OF_CREDITS,
      code: 'out_of_credits',
    })
    expect(ai.calls).toHaveLength(3)
  })

  /** Asks a question whose first model call, the one asking for a tool, uses up the user's credits. */
  async function askIntoNoCredits() {
    ai.usage = usageCosting(200)
    const { tool, runs } = pageTool()
    const agent = makeAgent({ tools: [tool] })
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }]
    const { result } = await ask(agent, 'Which page am I on?')
    return { agent, runs, result }
  }

  it('[UC-NOTICO-CHAT-001-S12] credits that run out after a tool ran end the question, saying when credits arrive', async () => {
    const { runs, result } = await askIntoNoCredits()
    expect(result).toEqual({ status: 'error', message: OUT_OF_CREDITS, code: 'out_of_credits' })
    expect(runs).toHaveLength(1)
    // The request that would have sent the result back was refused before the model.
    expect(ai.calls).toHaveLength(1)
  })

  it('[@no-uc:contract] surfaces an error event in the stream', async () => {
    ai.rawSse = `data: ${JSON.stringify({ error: { message: 'model overloaded' } })}\n\n`
    const { result } = await ask(makeAgent(), 'hi')
    expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('model overloaded') })
  })
})

describe('tokens per question', () => {
  it('[UC-NOTICO-AGENT-001-S25] a question reports the tokens its model calls used, cached ones too, and the saved session keeps them', async () => {
    ai.usage = { prompt_tokens: 1000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 600 } }
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }, { reply: 'You are on Q4 Roadmap' }]
    const agent = makeAgent()

    const { used } = await ask(agent, 'Which page am I on?')
    // Each call: 400 new input tokens at 300 micro-credits, 600 cached at 6, and 40 output at 1,200.
    const details = {
      tokens: { input: 2000, output: 80, cached: 1200 },
      model: { service: 'hosted' },
      cost: { microCredits: 2 * (400 * 300 + 600 * 6 + 40 * 1200) },
    }
    expect(used).toEqual(details)

    // The title request is not part of the question.
    ai.script = [{ reply: 'Roadmap page' }]
    await agent.title(agent.history())
    const saved = structuredClone(agent.history())
    expect(saved[0]).toEqual({ role: 'user', text: 'Which page am I on?', turn: expect.any(String), ...details })
    const resumed = makeAgent({}, saved)
    expect(resumed.history()).toEqual(saved)
  })

  it('[UC-NOTICO-CHAT-003-S14] a question that failed has no cost; one that ended normally has its exact cost', async () => {
    const agent = makeAgent()
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }, { reply: 'Hi.' }]
    expect((await ask(agent, 'Which page?')).used.cost).toEqual({ microCredits: 2 * FAKE_COST })
    // The first call answers, the second breaks off: it costs nothing, and the question has no cost.
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }]
    ai.rawSse = 'data: {"choices":[{"delta":{"content":"abc"}}]}\n\n'
    const { result, used } = await ask(agent, 'And now?')
    expect(result.status).toBe('error')
    expect(used.cost).toBeUndefined()
  })
})

describe('web reads and searches', () => {
  const config = { apiUrl: 'https://nk.example.dev/v1/', getToken: async () => token, client: 'notico/1.2.3' }
  /** What a read, a render, or a search gave the extension: its result or its WebError, and what it was told it cost. */
  async function outcome<T>(call: (charged: (microCredits: number | undefined) => void) => Promise<T>) {
    const costs: (number | undefined)[] = []
    try {
      return { result: await call((cost) => costs.push(cost)), costs }
    } catch (err) {
      if (!(err instanceof WebError)) throw err
      return { error: { code: err.code, stops: !!err.stopsQuestion, charged: err.charged }, costs }
    }
  }
  const render = (url: string) => outcome((charged) => readWebPage(config, url, 1000, true, undefined, charged))
  const search = () => outcome((charged) => searchWebFor(config, 'tea', 5, undefined, charged))

  it('[@no-uc:contract] a render and a search say what they cost; failed ones cost nothing, and a busy one stops the question', async () => {
    browser.render('https://app.example/board', '# Board', 4000)
    expect(await render('https://app.example/board')).toMatchObject({ result: { title: 'Board' }, costs: [100_000] })
    const failed = { error: { code: 'render_failed', stops: false, charged: false }, costs: [0] }
    expect(await render('https://app.example/broken')).toEqual(failed)
    browser.reply = () => Response.json({ success: false }, { status: 429 })
    const busy = { error: { code: 'render_busy', stops: true, charged: false }, costs: [0] }
    expect(await render('https://app.example/board')).toEqual(busy)

    ai.found.set('tea', [{ url: 'https://tea.example/', title: 'Tea', description: 'About tea.' }])
    expect(await search()).toMatchObject({ result: [{ url: 'https://tea.example/' }], costs: [5_000_000] })
    ai.searchReply = () => Response.json({ results: [] })
    expect(await search()).toEqual({ error: { code: 'search_failed', stops: false, charged: false }, costs: [0] })
  })

  it('[@no-uc:money] a Stop while the answer of a render is read throws the Stop, not an answer that could not be read', async () => {
    browser.render('https://app.example/board', '# Board')
    const controller = new AbortController()
    const worker = globalThis.fetch
    // As fetch does: once the request is aborted, reading its answer's body throws the abort.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await worker(input, init)
      const body = new ReadableStream({
        start(stream) {
          init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason))
          controller.abort()
        },
      })
      return new Response(body, { status: res.status, headers: res.headers })
    }) as typeof fetch
    try {
      const costs: (number | undefined)[] = []
      const read = readWebPage(config, 'https://app.example/board', 1000, true, controller.signal, (cost) =>
        costs.push(cost),
      )
      await expect(read).rejects.toMatchObject({ name: 'AbortError' })
      expect(costs).toEqual([undefined])
    } finally {
      globalThis.fetch = worker
    }
  })
})

// Standalone test for what a question's requests tell the worker about the chat and the question.
describe('chat and question of what a question spends', () => {
  it('[@no-uc:contract] every request a question makes carries the chat and the question, and the question keeps its id', async () => {
    env.BROWSER = new FakeBrowserRun().render('https://tea.example/', '# Tea')
    env.AI_GATEWAY_ID = 'gw-test'
    ai.found.set('tea', [{ url: 'https://tea.example/', title: 'Tea', description: 'All about tea.' }])
    const research: ToolSpec = {
      name: 'research',
      description: 'Renders a page and searches the web.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run: async (_args, signal, context) => {
        await context?.readWeb('https://tea.example/', 1000, true, signal)
        await context?.searchWeb('tea', 3, signal)
        return 'done'
      },
    }
    const agent = makeAgent({ tools: [research] })
    const chat = crypto.randomUUID()
    ai.script = [{ toolCalls: [{ name: 'research', arguments: '{}' }] }, { reply: 'Tea is a drink.' }]
    expect((await ask(agent, 'What is tea?', undefined, { chat })).result).toEqual({ status: 'done' })
    // The title is part of what the first question cost.
    ai.script = [{ reply: 'About tea' }]
    expect(await agent.title(agent.history(), { chat })).toBe('About tea')
    ai.script = [{ reply: 'Green tea.' }]
    await ask(agent, 'And green tea?', undefined, { chat })

    const turns = agent.history().flatMap((m) => (m.role === 'user' ? [m.turn] : []))
    const [first, second] = turns
    expect(turns).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/), expect.stringMatching(/^[0-9a-f-]{36}$/)])
    expect(first).not.toBe(second)
    const db = env.DB as FakeD1Database
    expect(db.rows('spends').map(({ kind, chat_id, turn_id }) => ({ kind, chat_id, turn_id }))).toEqual([
      { kind: 'model_call', chat_id: chat, turn_id: first },
      { kind: 'web_render', chat_id: chat, turn_id: first },
      { kind: 'web_search', chat_id: chat, turn_id: first },
      { kind: 'model_call', chat_id: chat, turn_id: first },
      { kind: 'model_call', chat_id: chat, turn_id: first },
      { kind: 'model_call', chat_id: chat, turn_id: second },
    ])
    // A session saved and opened again keeps each question's id.
    const resumed = makeAgent({}, structuredClone(agent.history()))
    expect(resumed.history().flatMap((m) => (m.role === 'user' ? [m.turn] : []))).toEqual(turns)
  })
})
