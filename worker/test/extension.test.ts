// Runs the extension's real agent (extension/src/agent.ts) against the worker,
// so the two sides can't drift apart.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CopilotAgent, type AgentUpdate, type ToolSpec } from '../../extension/src/agent'
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

beforeAll(async () => {
  clerk = await FakeClerk.create()
  // The extension calls fetch(); route it into the worker app.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(new Request(input, init), undefined, env)) as typeof fetch
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
    getToken?: () => Promise<string | null>
  } = {},
) {
  return new CopilotAgent({
    apiUrl: 'https://nk.example.dev/v1/',
    getToken: options.getToken ?? (async () => token),
    systemPrompt: 'You are Notion Copilot.',
    tools: options.tools ?? [pageTool().tool],
    maxSteps: options.maxSteps,
    history: options.history,
  })
}

/** Asks one question and collects what the side panel would show. */
async function ask(agent: CopilotAgent, text: string) {
  const updates: AgentUpdate[] = []
  const result = await agent.ask(text, (u) => updates.push(u))
  const reply = updates.map((u) => (u.type === 'text' ? u.delta : '')).join('')
  return { result, updates, reply }
}

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
      { type: 'tool_end', id: 'chatcmpl-tool-0', name: 'get_current_page', isError: false },
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
    expect(updates.filter((u) => u.type === 'tool_end').map((u) => 'skipped' in u && u.skipped)).toEqual([
      false,
      false,
      true,
    ])

    // The conversation stays usable: the next question is answered, with the refused call answered too.
    ai.toolCalls = undefined
    expect((await ask(agent, 'Thanks')).result).toEqual({ status: 'done' })
    expect(sentMessages(3).at(-2)).toMatchObject({ role: 'tool', content: expect.stringContaining('limit of 3 steps') })
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
    expect(updates).toContainEqual({ type: 'tool_end', id: 'chatcmpl-tool-0', name: 'get_current_page', isError: true })
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
    expect((await ask(agent, 'Which page am I on?')).result).toEqual({ status: 'stopped' })

    await ask(agent, 'hi')
    expect(sentMessages(1).map((m) => m.role)).toEqual(['system', 'user'])
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
