// Runs the extension's real agent (extension/src/agent.ts) against the worker,
// so the two sides can't drift apart.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CopilotAgent,
  type AgentUpdate,
  type ConfirmTool,
  type ToolCallRequest,
  type ToolSpec,
} from '../../extension/src/agent'
import { getCurrentPage } from '../../extension/src/tools'
import { createApp, type Env } from '../src/app'
import { FakeClerk } from './clerk'
import { FakeAiBinding, FakeQuotaNamespace, FakeUsageDataset } from './fakes'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const MODEL = '@cf/test/model'
const app = createApp()
let clerk: FakeClerk
let env: Env
let ai: FakeAiBinding
let token: string

const realFetch = globalThis.fetch

beforeAll(async () => {
  clerk = await FakeClerk.create()
  // The extension calls fetch(); route it into the worker app.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(new Request(input, init), undefined, env)) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  delete (globalThis as { chrome?: unknown }).chrome
})

beforeEach(async () => {
  env = {
    AI: (ai = new FakeAiBinding('你好 来自 worker')),
    QUOTA: new FakeQuotaNamespace(),
    USAGE: new FakeUsageDataset(),
    DAILY_REQUEST_LIMIT: '100',
    MODEL,
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: EXT,
  }
  token = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
})

/** A stand-in for get_current_page: same name and arguments, a fixed page instead of the browser tab. */
function pageTool(page = { title: 'Q4 Roadmap', url: 'https://www.notion.so/Q4-Roadmap-abc123' }) {
  const runs: unknown[] = []
  const tool: ToolSpec = {
    name: 'get_current_page',
    description: 'Returns the title and URL of the Notion page open in the current browser tab.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: async (args) => {
      runs.push(args)
      return page
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
  } = {},
) {
  return new CopilotAgent({
    apiUrl: 'https://nk.example.dev/v1/',
    getToken: options.getToken ?? (async () => token),
    systemPrompt: options.systemPrompt ?? 'You are Notion Copilot.',
    tools: options.tools ?? [pageTool().tool],
    maxSteps: options.maxSteps,
    history: options.history,
  })
}

/** Asks one question and collects what the side panel would show. */
async function ask(agent: CopilotAgent, text: string, confirm?: ConfirmTool) {
  const updates: AgentUpdate[] = []
  const result = await agent.ask(text, (u) => updates.push(u), confirm)
  const reply = updates.map((u) => (u.type === 'text' ? u.delta : '')).join('')
  return { result, updates, reply }
}

/** A tool that changes data, so it needs the user's OK; records each run. */
function renameTool() {
  const runs: unknown[] = []
  const tool: ToolSpec = {
    name: 'rename_page',
    description: 'Renames the open Notion page.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
    needsConfirmation: true,
    run: async (args) => {
      runs.push(args)
      return 'Renamed.'
    },
  }
  return { tool, runs }
}

const RENAME_CALL = { name: 'rename_page', arguments: '{"title":"Q4 Plan"}' }
const toolStatuses = (updates: AgentUpdate[]) => updates.flatMap((u) => (u.type === 'tool_end' ? [u.status] : []))

const PAGE_JSON = JSON.stringify({ title: 'Q4 Roadmap', url: 'https://www.notion.so/Q4-Roadmap-abc123' })

const sentMessages = (call: number) => ai.calls[call].inputs.messages as Record<string, unknown>[]

describe('extension agent against the worker', () => {
  it('[UC-CHAT-001-S01] a plain question gets a streamed answer', async () => {
    const { result, updates, reply } = await ask(makeAgent(), 'hi')
    expect(result).toEqual({ status: 'done' })
    expect(reply).toBe('你好 来自 worker ')
    expect(updates.filter((u) => u.type === 'text').length).toBeGreaterThan(1)
    // The agent names the server's model and offers its tools; the worker accepts the request as is.
    expect(ai.calls).toHaveLength(1)
    expect(ai.calls[0].inputs.tools).toEqual([
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'get_current_page' }) }),
    ])
    expect(sentMessages(0)).toEqual([
      { role: 'system', content: 'You are Notion Copilot.' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('[UC-AGENT-001-S04] a tool the model asks for runs in the extension and the answer uses its result', async () => {
    const { tool, runs } = pageTool()
    ai.script = [{ toolCalls: [{ name: 'get_current_page', arguments: '{}' }] }, { reply: 'You are on Q4 Roadmap' }]
    const { result, updates, reply } = await ask(makeAgent({ tools: [tool] }), 'Which page am I on?')

    expect(result).toEqual({ status: 'done' })
    expect(runs).toEqual([{}])
    expect(updates.filter((u) => u.type !== 'text')).toEqual([
      { type: 'tool_start', id: 'chatcmpl-tool-0', name: 'get_current_page', args: {} },
      { type: 'tool_end', id: 'chatcmpl-tool-0', name: 'get_current_page', status: 'done', result: PAGE_JSON },
    ])
    expect(reply).toBe('You are on Q4 Roadmap ')
    // The second model call got the tool's result right after the call.
    expect(sentMessages(1).slice(-2)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'chatcmpl-tool-0', type: 'function', function: { name: 'get_current_page', arguments: '{}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'chatcmpl-tool-0',
        content: JSON.stringify({ title: 'Q4 Roadmap', url: 'https://www.notion.so/Q4-Roadmap-abc123' }),
      },
    ])
  })

  it('[UC-AGENT-001-S05] a model that keeps calling tools is stopped at the step limit', async () => {
    const { tool, runs } = pageTool()
    ai.toolCalls = [{ name: 'get_current_page', arguments: '{}' }]
    const agent = makeAgent({ tools: [tool], maxSteps: 3 })
    const { result, updates } = await ask(agent, 'Which page am I on?')
    expect(result).toEqual({ status: 'step_limit', steps: 3 })
    expect(ai.calls).toHaveLength(3)
    // The last step's tool is refused, not run: the model would never see its result.
    expect(runs).toHaveLength(2)
    expect(updates.flatMap((u) => (u.type === 'tool_end' ? [u.status] : []))).toEqual(['done', 'done', 'skipped'])
    // The panel gets a start for the refused call too, so it can mark that call as skipped.
    const refusedId = updates.filter((u) => u.type === 'tool_end').at(-1)!.id
    expect(updates).toContainEqual(expect.objectContaining({ type: 'tool_start', id: refusedId }))

    // The conversation stays usable: the next question is answered, with the refused call answered too.
    ai.toolCalls = undefined
    expect((await ask(agent, 'Thanks')).result).toEqual({ status: 'done' })
    expect(sentMessages(3).at(-2)).toMatchObject({ role: 'tool', content: expect.stringContaining('limit of 3 steps') })
  })

  it('calls pi cannot run (unknown tool, invalid arguments) still stop at the step limit', async () => {
    for (const calls of [
      [{ name: 'no_such_tool', arguments: '{}' }],
      [{ name: 'get_current_page', arguments: '{"x":1}' }],
      [
        { name: 'get_current_page', arguments: '{}' },
        { name: 'no_such_tool', arguments: '{}' },
      ],
    ]) {
      ai = env.AI = new FakeAiBinding('你好 来自 worker')
      ai.toolCalls = calls
      const agent = makeAgent({ maxSteps: 3 })
      expect((await ask(agent, 'Which page am I on?')).result).toEqual({ status: 'step_limit', steps: 3 })
      expect(ai.calls).toHaveLength(3)
      ai.toolCalls = undefined
      expect((await ask(agent, 'Thanks')).result).toEqual({ status: 'done' })
    }
  })

  it('a tool that returns nothing still gives the model a result', async () => {
    const quiet: ToolSpec = { ...pageTool().tool, run: async () => undefined }
    ai.script = [{ toolCalls: [{ name: 'get_current_page', arguments: '{}' }] }, { reply: 'Done' }]
    expect((await ask(makeAgent({ tools: [quiet] }), 'Which page am I on?')).result).toEqual({ status: 'done' })
    expect(sentMessages(1).at(-1)).toMatchObject({ role: 'tool', content: expect.any(String) })
  })

  it('several tool calls on the last step are all refused, and the next question still works', async () => {
    const { tool, runs } = pageTool()
    ai.toolCalls = [
      { name: 'get_current_page', arguments: '{}' },
      { name: 'get_current_page', arguments: '{}' },
    ]
    const agent = makeAgent({ tools: [tool], maxSteps: 1 })
    expect((await ask(agent, 'Which page am I on?')).result).toEqual({ status: 'step_limit', steps: 1 })
    expect(runs).toHaveLength(0)

    ai.toolCalls = undefined
    expect((await ask(agent, 'Thanks')).result).toEqual({ status: 'done' })
    // Both calls have a result in the conversation, so the worker accepted it.
    expect(sentMessages(1).filter((m) => m.role === 'tool')).toHaveLength(2)
  })

  it('the conversation carries over to the next question', async () => {
    const agent = makeAgent()
    await ask(agent, 'first')
    await ask(agent, 'second')
    expect(sentMessages(1).map((m) => [m.role, m.content])).toEqual([
      ['system', 'You are Notion Copilot.'],
      ['user', 'first'],
      ['assistant', '你好 来自 worker '],
      ['user', 'second'],
    ])
  })

  it('a long conversation sends only its newest part, starting at a question', async () => {
    const agent = makeAgent({ history: { messages: 3, chars: 100_000 } })
    await ask(agent, 'first')
    await ask(agent, 'second')
    await ask(agent, 'third')
    expect(sentMessages(2).map((m) => [m.role, m.content])).toEqual([
      ['system', 'You are Notion Copilot.'],
      ['user', 'second'],
      ['assistant', '你好 来自 worker '],
      ['user', 'third'],
    ])
  })

  it('the system prompt and tool definitions count toward the history budget', async () => {
    const { tool } = pageTool()
    const toolChars = JSON.stringify([
      { name: tool.name, description: tool.description, parameters: tool.parameters },
    ]).length
    // The earlier exchange ("first", its reply, "second") is about 24 characters and fits in 40.
    const budget = (systemPrompt: string) =>
      makeAgent({ systemPrompt, history: { messages: 100, chars: toolChars + 40 } })

    let agent = budget('Short.')
    await ask(agent, 'first')
    await ask(agent, 'second')
    expect(sentMessages(1).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])

    // A long system prompt uses up the room, so only the newest question is sent.
    agent = budget('x'.repeat(100))
    await ask(agent, 'first')
    await ask(agent, 'second')
    expect(sentMessages(3).map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('a second question while one is running is refused, and the first is unharmed', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const agent = makeAgent({
      getToken: async () => {
        await gate
        return token
      },
    })
    const first = ask(agent, 'first')
    expect((await ask(agent, 'second')).result).toEqual({ status: 'error', message: 'Already answering a question.' })
    release()
    expect((await first).result).toEqual({ status: 'done' })
    await ask(agent, 'third')
    expect(sentMessages(1).map((m) => m.content)).toEqual([
      'You are Notion Copilot.',
      'first',
      '你好 来自 worker ',
      'third',
    ])
  })

  it('trimming never separates tool results from their call', async () => {
    const agent = makeAgent({ history: { messages: 3, chars: 100_000 } })
    ai.script = [{ toolCalls: [{ name: 'get_current_page', arguments: '{}' }] }, { reply: 'Q4 Roadmap' }]
    await ask(agent, 'Which page am I on?')
    // Last 3 would be [assistant tool call, tool result, assistant]; the cut moves to the next question.
    await ask(agent, 'thanks')
    expect(sentMessages(2).map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('a tool that fails is reported to the model, which still answers', async () => {
    const failing: ToolSpec = { ...pageTool().tool, run: async () => Promise.reject(new Error('No page is open.')) }
    ai.script = [{ toolCalls: [{ name: 'get_current_page', arguments: '{}' }] }, { reply: 'Open a page first' }]
    const { result, updates, reply } = await ask(makeAgent({ tools: [failing] }), 'Which page am I on?')
    expect(result).toEqual({ status: 'done' })
    // The panel shows the same error the model got.
    expect(updates).toContainEqual({
      type: 'tool_end',
      id: 'chatcmpl-tool-0',
      name: 'get_current_page',
      status: 'failed',
      result: expect.stringContaining('No page is open.'),
    })
    expect(sentMessages(1).at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('No page is open.') })
    expect(reply).toBe('Open a page first ')
  })

  it('[UC-AGENT-001-S07] stopping during a tool ends the question and drops it from the conversation', async () => {
    let agent: CopilotAgent
    const slow: ToolSpec = {
      ...pageTool().tool,
      run: (_args, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
          agent.stop()
        }),
    }
    agent = makeAgent({ tools: [slow] })
    ai.script = [{ toolCalls: [{ name: 'get_current_page', arguments: '{}' }] }]
    const stopped = await ask(agent, 'Which page am I on?')
    expect(stopped.result).toEqual({ status: 'stopped' })
    // The tool shows as stopped, not as a failure of its own.
    expect(stopped.updates.flatMap((u) => (u.type === 'tool_end' ? [u.status] : []))).toEqual(['stopped'])

    await ask(agent, 'hi')
    expect(sentMessages(1).map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('a tool that finishes despite Stop still shows as done', async () => {
    let agent: CopilotAgent
    const stubborn: ToolSpec = {
      ...pageTool().tool,
      run: async () => {
        agent.stop()
        return { title: 'Q4 Roadmap' }
      },
    }
    agent = makeAgent({ tools: [stubborn] })
    ai.script = [{ toolCalls: [{ name: 'get_current_page', arguments: '{}' }] }]
    const { result, updates } = await ask(agent, 'Which page am I on?')
    expect(result).toEqual({ status: 'stopped' })
    expect(updates.flatMap((u) => (u.type === 'tool_end' ? [u.status] : []))).toEqual(['done'])
  })

  it('[UC-AGENT-001-S09] a tool the user declines does not run, and the agent continues without it', async () => {
    const { tool, runs } = renameTool()
    ai.script = [{ toolCalls: [RENAME_CALL] }, { reply: 'OK, I left the title as it is' }]
    const asked: ToolCallRequest[] = []
    const { result, updates, reply } = await ask(
      makeAgent({ tools: [tool] }),
      'Rename this page to Q4 Plan',
      async (call) => {
        asked.push(call)
        return false
      },
    )

    expect(asked).toEqual([{ id: 'chatcmpl-tool-0', name: 'rename_page', args: { title: 'Q4 Plan' } }])
    expect(runs).toEqual([])
    expect(toolStatuses(updates)).toEqual(['declined'])
    // The model is told the user said no, and answers without the tool.
    expect(sentMessages(1).at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('declined') })
    expect(result).toEqual({ status: 'done' })
    expect(reply).toBe('OK, I left the title as it is ')
  })

  it('[UC-AGENT-001-S10] a tool the user agrees to runs, and the answer uses its result', async () => {
    const { tool, runs } = renameTool()
    ai.script = [{ toolCalls: [RENAME_CALL] }, { reply: 'Renamed to Q4 Plan' }]
    const { result, updates, reply } = await ask(
      makeAgent({ tools: [tool] }),
      'Rename this page to Q4 Plan',
      async () => true,
    )

    expect(runs).toEqual([{ title: 'Q4 Plan' }])
    expect(toolStatuses(updates)).toEqual(['done'])
    expect(sentMessages(1).at(-1)).toMatchObject({ role: 'tool', content: 'Renamed.' })
    expect(result).toEqual({ status: 'done' })
    expect(reply).toBe('Renamed to Q4 Plan ')
  })

  it('a tool that needs confirmation is declined when nobody can be asked', async () => {
    const { tool, runs } = renameTool()
    ai.script = [{ toolCalls: [RENAME_CALL] }, { reply: 'I could not do that' }]
    const { result, updates } = await ask(makeAgent({ tools: [tool] }), 'Rename this page to Q4 Plan')
    expect(runs).toEqual([])
    expect(toolStatuses(updates)).toEqual(['declined'])
    // The model is not told that the user said no: nobody was asked.
    expect(sentMessages(1).at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('could not be asked'),
    })
    expect(result).toEqual({ status: 'done' })
  })

  it('a prompt that fails is not reported to the model as the user declining', async () => {
    const { tool, runs } = renameTool()
    ai.script = [{ toolCalls: [RENAME_CALL] }, { reply: 'I could not do that' }]
    const { result } = await ask(makeAgent({ tools: [tool] }), 'Rename this page to Q4 Plan', () =>
      Promise.reject(new Error('panel closed')),
    )
    expect(runs).toEqual([])
    expect(sentMessages(1).at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('could not be asked'),
    })
    expect(result).toEqual({ status: 'done' })
  })

  it('tools that change nothing run without asking', async () => {
    const { tool, runs } = pageTool()
    ai.script = [{ toolCalls: [{ name: 'get_current_page', arguments: '{}' }] }, { reply: 'You are on Q4 Roadmap' }]
    let asked = 0
    await ask(makeAgent({ tools: [tool] }), 'Which page am I on?', async () => {
      asked++
      return true
    })
    expect(asked).toBe(0)
    expect(runs).toEqual([{}])
  })

  it('stopping while the user is asked counts as no, ends the question, and drops it', async () => {
    const { tool, runs } = renameTool()
    const agent = makeAgent({ tools: [tool] })
    ai.script = [{ toolCalls: [RENAME_CALL] }]
    // The user never answers; they press Stop instead.
    const { result, updates } = await ask(agent, 'Rename this page to Q4 Plan', () => {
      agent.stop()
      return new Promise<boolean>(() => {})
    })
    expect(result).toEqual({ status: 'stopped' })
    expect(runs).toEqual([])
    expect(toolStatuses(updates)).toEqual(['stopped'])

    await ask(agent, 'hi')
    expect(sentMessages(1).map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('a new chat while the user is asked counts as no', async () => {
    const { tool, runs } = renameTool()
    const agent = makeAgent({ tools: [tool] })
    ai.script = [{ toolCalls: [RENAME_CALL] }]
    let reset: Promise<void> | undefined
    const { result } = await ask(agent, 'Rename this page to Q4 Plan', () => {
      reset = agent.reset()
      return new Promise<boolean>(() => {})
    })
    await reset
    expect(result).toEqual({ status: 'stopped' })
    expect(runs).toEqual([])
  })

  it('stop and new chat work while the agent is still being set up', async () => {
    for (const cancel of ['stop', 'reset'] as const) {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const agent = makeAgent({
        getToken: async () => {
          await gate
          return token
        },
      })
      const pending = agent.ask('hi', () => {})
      if (cancel === 'stop') agent.stop()
      else void agent.reset()
      release()
      expect(await pending).toEqual({ status: 'stopped' })
    }
    // No model call was made, and nothing was left in either conversation.
    expect(ai.calls).toHaveLength(0)
  })

  it('a panel left open across a model change looks the model up again', async () => {
    const agent = makeAgent()
    expect((await ask(agent, 'first')).result).toEqual({ status: 'done' })
    env.MODEL = '@cf/test/next-model'
    // The worker refuses the old model name before the model or the quota is used; the agent retries once.
    const { result, reply } = await ask(agent, 'second')
    expect(result).toEqual({ status: 'done' })
    expect(reply).toBe('你好 来自 worker ')
    expect(ai.calls.map((c) => c.model)).toEqual([MODEL, '@cf/test/next-model'])
    expect(sentMessages(1).map((m) => m.content)).toEqual([
      'You are Notion Copilot.',
      'first',
      '你好 来自 worker ',
      'second',
    ])
  })

  it('new chat works at once even if the old question has a tool that never finishes', async () => {
    const stuck: ToolSpec = { ...pageTool().tool, run: () => new Promise(() => {}) }
    const agent = makeAgent({ tools: [stuck] })
    ai.script = [{ toolCalls: [{ name: 'get_current_page', arguments: '{}' }] }]
    const first = agent.ask('Which page am I on?', () => {})
    await vi.waitFor(() => expect(ai.calls).toHaveLength(1))
    void agent.reset()
    expect((await ask(agent, 'hi')).result).toEqual({ status: 'done' })
    expect(sentMessages(1).map((m) => m.role)).toEqual(['system', 'user'])
    void first
  })

  it('a question set up after a New chat keeps its agent when an older lookup finishes later', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    const agent = makeAgent({
      getToken: async () => {
        // Only the first question's lookup is slow.
        if (calls++ === 0) await gate
        return token
      },
    })
    const a = agent.ask('A', () => {})
    void agent.reset()
    expect((await ask(agent, 'B')).result).toEqual({ status: 'done' })
    release()
    expect(await a).toEqual({ status: 'stopped' })
    await ask(agent, 'C')
    expect(sentMessages(1).map((m) => m.content)).toEqual(['You are Notion Copilot.', 'B', '你好 来自 worker ', 'C'])
  })

  it('a model change after a tool ran is reported, not retried', async () => {
    const { tool, runs } = pageTool()
    const changing: ToolSpec = {
      ...tool,
      run: async (args) => {
        env.MODEL = '@cf/test/next-model'
        return tool.run(args)
      },
    }
    ai.script = [{ toolCalls: [{ name: 'get_current_page', arguments: '{}' }] }, { reply: 'Q4 Roadmap' }]
    const agent = makeAgent({ tools: [changing] })
    const { result } = await ask(agent, 'Which page am I on?')
    expect(result).toEqual({ status: 'error', message: 'Copilot was just updated. Please ask again.' })
    // The tool ran once; running the question again would run it again.
    expect(runs).toHaveLength(1)
    // The new model was looked up, so asking again works straight away.
    ai.script = []
    expect((await ask(agent, 'Thanks')).result).toEqual({ status: 'done' })
    expect(ai.calls.at(-1)!.model).toBe('@cf/test/next-model')
  })

  it('asks to sign in when there is no session', async () => {
    const { result } = await ask(makeAgent({ getToken: async () => null }), 'hi')
    expect(result).toEqual({ status: 'error', message: 'Please sign in first.' })
    expect(ai.calls).toHaveLength(0)
  })

  it('asks to sign in when the session is lost after the first question', async () => {
    let current: string | null = token
    const agent = makeAgent({ getToken: async () => current })
    expect((await ask(agent, 'first')).result).toEqual({ status: 'done' })
    current = null
    expect((await ask(agent, 'second')).result).toEqual({ status: 'error', message: 'Please sign in first.' })
    expect(ai.calls).toHaveLength(1)
  })

  it('shows the server reason for a rejected session', async () => {
    const { result } = await ask(makeAgent({ getToken: async () => 'not-a-jwt' }), 'hi')
    expect(result).toEqual({ status: 'error', message: 'invalid or expired session' })
  })

  it('[UC-CHAT-001-S04] shows when the daily quota resets, and drops the refused question', async () => {
    env.DAILY_REQUEST_LIMIT = '1'
    const agent = makeAgent()
    expect((await ask(agent, 'first')).result).toEqual({ status: 'done' })
    const { result } = await ask(agent, 'second')
    expect(result).toMatchObject({
      status: 'error',
      message: expect.stringContaining('The quota resets at 00:00 UTC.'),
    })

    env.DAILY_REQUEST_LIMIT = '100'
    await ask(agent, 'third')
    expect(sentMessages(1).map((m) => m.content)).toEqual([
      'You are Notion Copilot.',
      'first',
      '你好 来自 worker ',
      'third',
    ])
  })

  it('surfaces an error event in the stream', async () => {
    ai.rawSse = `data: ${JSON.stringify({ error: { message: 'model overloaded' } })}\n\n`
    const { result } = await ask(makeAgent(), 'hi')
    expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('model overloaded') })
  })
})

describe('get_current_page', () => {
  /** A stand-in for the chrome.tabs API with one active tab. */
  function withActiveTab(tab: { url?: string; title?: string } | undefined) {
    ;(globalThis as { chrome?: unknown }).chrome = { tabs: { query: async () => (tab ? [tab] : []) } }
  }

  it('returns the Notion page in the current window', async () => {
    withActiveTab({ url: 'https://www.notion.so/Q4-Roadmap-abc123', title: 'Q4 Roadmap' })
    expect(await getCurrentPage.run({})).toEqual({
      title: 'Q4 Roadmap',
      url: 'https://www.notion.so/Q4-Roadmap-abc123',
    })
    withActiveTab({ url: 'https://app.notion.com/p/abc', title: 'Notes | Notion' })
    expect(await getCurrentPage.run({})).toEqual({ title: 'Notes', url: 'https://app.notion.com/p/abc' })
  })

  it('never reports a page on another site', async () => {
    for (const tab of [
      { url: 'https://mail.example.com/inbox?token=secret', title: 'Inbox' },
      { url: 'https://www.notion.so.evil.example/x', title: 'x' },
      { title: 'no url' },
      undefined,
    ]) {
      withActiveTab(tab)
      await expect(getCurrentPage.run({})).rejects.toThrow('No Notion page is open in this window.')
    }
  })
})
