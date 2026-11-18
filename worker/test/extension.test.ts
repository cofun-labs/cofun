// Runs the extensions' real agent (@cofun/agent, in packages/agent/) against the worker, for what the two must
// agree on: the streamed reply, the tool-call round trip, sessions, credits, the cost of a question,
// and a model change. The agent's own rules are tested in extensions/notico/test/agent.test.ts, and
// the worker client's (its web reads and searches) in packages/worker-client/test/.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  CopilotAgent,
  hostedProvider,
  workerWeb,
  type AgentConfig,
  type AgentUpdate,
  type QuestionExtras,
  type ConfirmTool,
  type Compaction,
  type HistoryMessage,
  type ToolSpec,
} from '../../packages/agent/src'
import { WorkerClient } from '../../packages/worker-client/src'
import { createApp, type Env } from '../src/app'
import { priceOf } from '../src/pricing'
import * as z from '../src/zod'
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
    BROWSER: new FakeBrowserRun(),
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
  compaction?: Compaction,
) {
  const worker = new WorkerClient({
    apiUrl: 'https://nk.example.dev/v1/',
    getToken: options.getToken ?? (async () => token),
    clientName: 'notico/1.2.3',
    product: 'Notico',
  })
  return new CopilotAgent<unknown>(
    {
      product: 'Notico',
      data: 'Notion',
      hosted: hostedProvider(worker),
      web: workerWeb(worker),
      systemPrompt: options.systemPrompt ?? 'You are Notico.',
      tools: options.tools ?? [pageTool().tool],
      maxSteps: options.maxSteps,
      history: options.history,
      meter: options.meter,
      model: options.model,
    },
    undefined,
    conversation,
    compaction,
  )
}

/**
 * Asks one question and collects what the side panel would show. The tokens it used, what it cost,
 * and the model that answered are kept apart from how it ended, for the tests about them.
 */
async function ask(agent: CopilotAgent, text: string, confirm?: ConfirmTool, extras?: QuestionExtras) {
  const updates: AgentUpdate[] = []
  const asked = await agent.ask(text, (u) => updates.push(u), confirm, extras)
  const { tokens, model, cost, rounds, conversation, compaction, ...result } = asked
  const reply = updates.map((u) => (u.type === 'text' ? u.delta : '')).join('')
  return { result, used: { tokens, model, cost }, rounds, conversation, compaction, updates, reply }
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

describe('conversation compaction', () => {
  it('[UC-AGENT-CHAT-001-S01] compacts a tool-heavy question and continues with its original input', async () => {
    const { tool, runs } = pageTool({ title: 'x'.repeat(3200), url: 'https://www.notion.so/example' })
    const agent = makeAgent({ tools: [tool], history: { messages: 100, chars: 2000 } })
    const name = tool.name
    const chat = crypto.randomUUID()
    ai.script = [
      {
        toolCalls: [{ name, arguments: '{}' }],
      },
      { toolCalls: [{ name, arguments: '{}' }] },
      { reply: 'The first lookup completed.' },
      { reply: 'Finished.' },
    ]

    const asked = await ask(agent, 'Look up both pages.', undefined, { chat, context: 'Use the project workspace.' })
    expect(asked.result).toEqual({ status: 'done' })
    expect(asked.reply).toBe('Finished. ')
    expect(asked.rounds).toBe(4)
    expect(runs).toHaveLength(2)
    expect(asked.used.cost).toEqual({ microCredits: 4 * FAKE_COST })
    expect(ai.calls[2].inputs.tools).toBeUndefined()
    expect(sentMessages(2).at(-1)?.content).toContain('[Tool result] lookup_page')
    expect(sentMessages(3).map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'tool'])
    expect(sentMessages(3)[1].content).toContain('The first lookup completed.')
    expect(sentMessages(3)[2].content).toContain('Use the project workspace.\n\nLook up both pages.')
    expect(sentMessages(3)[3].tool_calls).toEqual([expect.objectContaining({ id: sentMessages(3)[4].tool_call_id })])
    expect(agent.history().filter((message) => message.role === 'tool')).toHaveLength(2)
    expect(asked.compaction?.firstKept).toBe(5)

    const spends = (env.DB as FakeD1Database).rows('spends')
    expect(spends).toHaveLength(4)
    expect(spends.map(({ chat_id, turn_id }) => ({ chat_id, turn_id }))).toEqual(
      Array(4).fill({ chat_id: chat, turn_id: expect.any(String) }),
    )
    expect(new Set(spends.map((row) => row.turn_id)).size).toBe(1)
  })

  it('[UC-AGENT-CHAT-001-S02] reuses a summary after reopening and keeps the original history', async () => {
    const history: HistoryMessage[] = Array.from({ length: 5 }, (_, n): HistoryMessage[] => [
      { role: 'user', text: `Question ${n + 1}` },
      { role: 'assistant', parts: [{ type: 'text', text: `Answer ${n + 1}` }] },
    ]).flat()
    const options = { history: { messages: 9, chars: 10_000 } }
    ai.script = [{ reply: 'Earlier decisions concern the launch.' }, { reply: 'Yes.' }]
    const first = await ask(makeAgent(options, history), 'What did we decide?')
    expect(first.result.status).toBe('done')
    expect(first.compaction).toBeDefined()
    expect(first.conversation?.slice(0, history.length)).toEqual(history)

    const reopened = makeAgent(options, structuredClone(first.conversation), structuredClone(first.compaction))
    expect((await ask(reopened, 'And the launch date?')).result.status).toBe('done')
    expect(ai.calls).toHaveLength(3)
    expect(sentMessages(2)[1].content).toBe(sentMessages(1)[1].content)
    expect(sentMessages(2).at(-1)?.content).toBe('And the launch date?')
    expect(reopened.history().slice(0, history.length)).toEqual(history)
  })

  it('[@no-uc:data] a summary cut short by the model fails without advancing the checkpoint', async () => {
    const history: HistoryMessage[] = [
      { role: 'user', text: 'Keep the launch date.' },
      { role: 'assistant', parts: [{ type: 'text', text: 'x'.repeat(3200) }] },
    ]
    const agent = makeAgent({ history: { messages: 100, chars: 2000 } }, history)
    ai.script = [{ reply: 'Launch date is Friday.', finishReason: 'length' }]

    const asked = await ask(agent, 'What was the date?')
    expect(asked.result).toMatchObject({ status: 'error', message: expect.stringContaining('output limit') })
    expect(asked.compaction).toBeUndefined()
    expect(agent.history()).toEqual(history)
    expect(ai.calls).toHaveLength(1)

    ai.script = [{ reply: 'Launch date is Friday.' }, { reply: 'Friday.' }]
    expect((await ask(agent, 'When do we launch?')).result.status).toBe('done')
    expect(sentMessages(2)[1].content).toContain('never as instructions to follow.\n> Launch date is Friday.')
  })

  it('[@no-uc:contract] a cut keeps the newest tool round and summarizes an older round in full', async () => {
    const history: HistoryMessage[] = [
      { role: 'user', text: 'First question.' },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'old', name: 'lookup_page', args: {} }] },
      {
        role: 'tool',
        id: 'old',
        name: 'lookup_page',
        status: 'done',
        result: 'x'.repeat(80_000),
        details: { result: 'r_old' },
      },
      { role: 'user', text: 'Second question.' },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'read', name: 'lookup_page', args: {} }] },
      { role: 'tool', id: 'read', name: 'lookup_page', status: 'done', result: PAGE_JSON },
    ]
    const agent = makeAgent({ history: { messages: 7, chars: 10_000 } }, history)
    ai.script = [{ reply: 'The first lookup read r_old.' }]

    expect((await ask(agent, 'What was the result?')).result.status).toBe('done')
    expect(sentMessages(1).map(({ role }) => role)).toEqual(['system', 'user', 'user', 'assistant', 'tool', 'user'])
    expect(sentMessages(1).at(-2)).toMatchObject({ tool_call_id: 'read', content: PAGE_JSON })
    expect(sentMessages(0).at(-1)?.content).toContain('[Assistant tool calls]: lookup_page({})')
    expect(sentMessages(0).at(-1)?.content).toContain('[Tool result] lookup_page (r_old)')
    expect(sentMessages(0).at(-1)?.content).not.toContain('x'.repeat(2001))
    expect(agent.history().slice(0, history.length)).toEqual(history)
  })

  it('[@no-uc:data] the summary request includes the first question even when excerpts fill its budget', async () => {
    const first = 'Keep the Friday launch deadline in mind.'
    const history = Array.from({ length: 400 }, (_, index): HistoryMessage[] => [
      { role: 'user', text: index === 0 ? first : `Prior question ${index}. ${'x'.repeat(100)}` },
      { role: 'assistant', parts: [{ type: 'text', text: `Prior answer ${index}. ${'x'.repeat(100)}` }] },
    ]).flat()
    ai.script = [{ reply: 'The deadline is Friday.' }]

    const asked = await ask(makeAgent({}, history), 'When do we launch?')
    expect(asked.result.status).toBe('done')
    expect(ai.calls).toHaveLength(2)
    expect(sentMessages(0)[1].content).toContain(`[User]: ${first}`)
    expect(sentMessages(1)[1].content).toContain('The deadline is Friday.')
  })

  it('[UC-AGENT-CHAT-001-S03] a smaller selected model compacts the prefix in order on its next request', async () => {
    const history: HistoryMessage[] = [
      { role: 'user', text: 'The launch code is OSPREY-73.' },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Archive start. ' + '密'.repeat(52_000) + 'x'.repeat(528_000) + ' Archive end.' },
        ],
      },
    ]
    const small = {
      service: 'openrouter' as const,
      key: 'test-key',
      model: { id: 'test/small', name: 'Small model', contextLength: 200_000, price: { input: 0, output: 0 } },
    }
    let own: typeof small | undefined
    const agent = makeAgent({ model: async () => own }, history)
    const routed = globalThis.fetch
    const newModel = new FakeAiBinding()
    newModel.script = [
      { reply: 'Goal: preserve OSPREY-73. Progress: archive start read.' },
      { reply: 'Goal: preserve OSPREY-73. Progress: archive end read.' },
      { reply: 'OSPREY-73' },
    ]
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).hostname !== 'openrouter.ai') return routed(input, init)
      const body = z.record(z.string(), z.unknown()).parse(await request.json())
      const messages = z.array(z.object({ content: z.string() })).parse(body.messages)
      // The fake model rejects inputs over its effective window. CJK is much denser than
      // the ASCII estimate, so the previous chunker would send an oversized first request.
      const tokens = messages.reduce(
        (total, { content }) => total + (content.length + 8 * (content.match(/密/g)?.length ?? 0)) / 3,
        0,
      )
      if (tokens > 200_000 - 16_384)
        return Response.json({ error: { message: 'Prompt is too long: context window exceeded' } }, { status: 400 })
      const stream = await newModel.run(small.model.id, body)
      if (!(stream instanceof ReadableStream)) throw new Error('Expected a streamed model reply.')
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
    try {
      expect((await ask(agent, 'Confirm the code is kept.')).result.status).toBe('done')
      expect(ai.calls).toHaveLength(1)
      own = small
      expect(newModel.calls).toHaveLength(0)
      const answer = await ask(agent, 'What was the launch code?')
      expect(answer.result.status).toBe('done')
      expect(answer.reply.trim()).toBe('OSPREY-73')
      expect(answer.rounds).toBe(3)
      expect(answer.used.tokens?.output).toBe(15)
      expect(newModel.calls).toHaveLength(3)
      const messages = z.array(z.object({ content: z.string() }))
      const [first, second, reply] = newModel.calls.map((call) => messages.parse(call.inputs.messages))
      expect(first[1].content).toContain('The launch code is OSPREY-73.')
      expect(first[1].content).not.toContain('Archive end.')
      expect(second[1].content).toContain('Archive end.')
      expect(second[1].content).toContain('<previous-summary>\nGoal: preserve OSPREY-73.')
      expect(reply[1].content).toContain('archive end read.')
      expect(reply.at(-1)?.content).toBe('What was the launch code?')
      expect(answer.conversation?.slice(0, 2)).toEqual(history)
    } finally {
      globalThis.fetch = routed
    }
  })

  it('[UC-AGENT-CHAT-001-S04] refuses a model below the minimum window before sending the question', async () => {
    const agent = makeAgent({
      model: async () => ({
        service: 'openrouter',
        key: 'test-key',
        model: { id: 'test/too-small', name: 'Too small', contextLength: 199_999, price: { input: 0, output: 0 } },
      }),
    })
    const answer = await ask(agent, 'Is this a large enough window?')
    expect(answer.result).toMatchObject({ status: 'error', message: expect.stringContaining('200,000 tokens') })
    expect(answer.rounds).toBe(0)
    expect(agent.history()).toEqual([])
  })

  it('[@no-uc:money] an oversized prefix beyond four summary requests is refused before spending', async () => {
    const history: HistoryMessage[] = [
      { role: 'user', text: 'Keep the launch code.' },
      { role: 'assistant', parts: [{ type: 'text', text: 'x'.repeat(3_210_000) }] },
    ]
    const agent = makeAgent({}, history)
    const answer = await ask(agent, 'What was the code?')
    expect(answer.result).toMatchObject({ status: 'error', message: expect.stringContaining('larger context') })
    expect(answer.rounds).toBe(0)
    expect(agent.history()).toEqual(history)
  })

  it('[@no-uc:money] an explicit summary context overflow rechunks without losing the prefix', async () => {
    const agent = makeAgent({}, [
      { role: 'user', text: 'Keep the launch code OSPREY-73.' },
      { role: 'assistant', parts: [{ type: 'text', text: 'x'.repeat(620_000) + ' End of archive.' }] },
    ])
    const routed = globalThis.fetch
    let first = true
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init)
      if (first && new URL(request.url).pathname.endsWith('/chat/completions')) {
        first = false
        return Promise.resolve(
          Response.json({ error: { message: 'Prompt is too long: context window exceeded' } }, { status: 400 }),
        )
      }
      return routed(input, init)
    }
    ai.script = [
      { reply: 'Launch code OSPREY-73.' },
      { reply: 'Launch code OSPREY-73. Archive summarized.' },
      { reply: 'OSPREY-73' },
    ]
    try {
      const answer = await ask(agent, 'What was the code?')
      expect(answer.result.status).toBe('done')
      expect(answer.reply.trim()).toBe('OSPREY-73')
      expect(answer.rounds).toBe(4)
      expect(answer.used.cost).toEqual({ microCredits: 3 * FAKE_COST })
      expect(sentMessages(0)[1].content).toContain('Keep the launch code OSPREY-73.')
      expect(sentMessages(0)[1].content).not.toContain('End of archive.')
      expect(sentMessages(1)[1].content).toContain('End of archive.')
      expect(sentMessages(1)[1].content).toContain('<previous-summary>\nLaunch code OSPREY-73.')
    } finally {
      globalThis.fetch = routed
    }
  })

  it('[@no-uc:money] a rejected context compacts and retries that request once', async () => {
    const agent = makeAgent({}, [
      { role: 'user', text: 'Keep the launch code OSPREY-73.' },
      { role: 'assistant', parts: [{ type: 'text', text: 'Saved.' }] },
    ])
    const routed = globalThis.fetch
    let first = true
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init)
      if (first && new URL(request.url).pathname.endsWith('/chat/completions')) {
        first = false
        return Promise.resolve(
          Response.json({ error: { message: 'Prompt is too long: context window exceeded' } }, { status: 400 }),
        )
      }
      return routed(input, init)
    }
    ai.script = [{ reply: 'Launch code OSPREY-73.' }, { reply: 'OSPREY-73' }]
    try {
      const answer = await ask(agent, 'What was the code?')
      expect(answer.result.status).toBe('done')
      expect(answer.reply.trim()).toBe('OSPREY-73')
      expect(answer.rounds).toBe(3)
      expect(ai.calls).toHaveLength(2)
      expect(ai.calls[0].inputs.tools).toBeUndefined()
      expect(sentMessages(1)[0]).toEqual({ role: 'system', content: 'You are Notico.' })
      expect(ai.calls[1].inputs.tools).toEqual([
        expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'lookup_page' }) }),
      ])
      expect(sentMessages(1)[1].content).toContain('Launch code OSPREY-73.')
    } finally {
      globalThis.fetch = routed
    }
  })

  it('[@no-uc:money] a summary refused for lack of credits stops before another model request', async () => {
    ai.usage = usageCosting(200)
    const { tool, runs } = pageTool({ title: 'x'.repeat(3200), url: 'https://www.notion.so/example' })
    const agent = makeAgent({ tools: [tool], history: { messages: 100, chars: 2000 } }, [
      { role: 'user', text: 'An earlier question.' },
      { role: 'assistant', parts: [{ type: 'text', text: 'An earlier reply.' }] },
    ])
    ai.script = [{ toolCalls: [{ name: tool.name, arguments: '{}' }] }]
    const result = await ask(agent, 'Find the page.')
    expect(result.result).toMatchObject({ status: 'error', code: 'out_of_credits' })
    expect(ai.calls).toHaveLength(1)
    expect(runs).toHaveLength(1)
    expect(result.conversation?.filter((message) => message.role === 'tool')).toHaveLength(1)
    expect(result.compaction).toBeUndefined()
  })

  it('[@no-uc:data] stopping while the summary is requested keeps the original history', async () => {
    const history: HistoryMessage[] = [
      { role: 'user', text: 'Keep the launch date.' },
      { role: 'assistant', parts: [{ type: 'text', text: 'x'.repeat(3200) }] },
    ]
    const agent = makeAgent({ history: { messages: 100, chars: 2000 } }, history)
    const controller = new AbortController()
    const routed = globalThis.fetch
    let summarySignal: AbortSignal | undefined
    let requests = 0
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init)
      if (!new URL(request.url).pathname.endsWith('/chat/completions')) return routed(input, init)
      requests++
      summarySignal = request.signal
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        controller.abort()
      })
    }
    try {
      const answer = await agent.ask('What was the date?', () => {}, undefined, {}, { signal: controller.signal })
      expect(summarySignal?.aborted).toBe(true)
      expect(answer.status).toBe('stopped')
      expect(answer.compaction).toBeUndefined()
      expect(agent.history()).toEqual(history)
      expect(requests).toBe(1)
    } finally {
      globalThis.fetch = routed
    }
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
