// The agent loop's rules (UC-WEBCO-AGENT-001) beyond the one example each has in Webco's side panel
// tests: the step limit, stopping after repeated tool failures, the user stopping a question, and
// what a failed or stopped question leaves for the next one. The agent runs against the real worker,
// with the model behind it scripted and tools of the tests' own. What the agent and the worker must
// agree on is in worker/test/extension.test.ts.
import { WorkerClient } from '@cofun/worker-client'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type Env } from '../../../worker/src/app'
import { FakeClerk } from '../../../worker/test/clerk'
import {
  FakeAiBinding,
  FakeD1Database,
  FakeExecutionContext,
  FakeRateLimiter,
  FakeUsageDataset,
  MODEL,
} from '../../../worker/test/fakes'
import { CopilotAgent, hostedProvider, workerWeb, type AgentUpdate, type ConfirmTool, type ToolSpec } from '../src'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const app = createApp()
let clerk: FakeClerk
let env: Env
let ai: FakeAiBinding
let token: string

beforeAll(async () => {
  clerk = await FakeClerk.create()
  // The agent calls fetch(); route it into the worker app.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(new Request(input, init), undefined, env, new FakeExecutionContext())) as typeof fetch
})

beforeEach(async () => {
  env = {
    AI: (ai = new FakeAiBinding('Hello from the worker')),
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

const SYSTEM = 'You are Webco.'

/** A tool with no arguments that returns a fixed page; records each run. */
function pageTool() {
  const runs: unknown[] = []
  const tool: ToolSpec = {
    name: 'lookup_page',
    description: 'Returns the title and URL of a web page.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: async (args) => {
      runs.push(args)
      return JSON.stringify({ title: 'Tea history', url: 'https://tea.example/history' })
    },
  }
  return { tool, runs }
}

/** A tool that runs without asking and records each run, as one that changes something might. */
function renameTool() {
  const runs: unknown[] = []
  const tool: ToolSpec = {
    name: 'rename_page',
    description: 'Renames a page.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
    run: async (args) => {
      runs.push(args)
      return 'Renamed.'
    },
  }
  return { tool, runs }
}

const RENAME_CALL = { name: 'rename_page', arguments: '{"title":"Q4 Plan"}' }
const LOOKUP_CALL = { name: 'lookup_page', arguments: '{}' }

function makeAgent(options: { tools?: ToolSpec[]; maxSteps?: number } = {}) {
  const worker = new WorkerClient({
    apiUrl: 'https://nk.example.dev/v1/',
    getToken: async () => token,
    clientName: 'webco/1.2.3',
    product: 'Webco',
  })
  return new CopilotAgent<unknown>(
    {
      product: 'Webco',
      data: 'the web',
      hosted: hostedProvider(worker),
      web: workerWeb(worker),
      systemPrompt: SYSTEM,
      tools: options.tools ?? [pageTool().tool],
      maxSteps: options.maxSteps,
    },
    {},
  )
}

/** Asks one question and collects how it ended and what the side panel would show. */
async function ask(agent: CopilotAgent, text: string, confirm?: ConfirmTool) {
  const updates: AgentUpdate[] = []
  const asked = await agent.ask(text, (u) => updates.push(u), confirm)
  // How it ended, without what it used and cost.
  const { tokens: _tokens, model: _model, cost: _cost, rounds: _rounds, conversation: _conversation, ...result } = asked
  return { result, updates }
}

const toolStatuses = (updates: AgentUpdate[]) => updates.flatMap((u) => (u.type === 'tool_end' ? [u.status] : []))
const sentMessages = (call: number) => ai.calls[call].inputs.messages as Record<string, unknown>[]

describe('the agent loop', () => {
  it('[UC-WEBCO-AGENT-001-S02] a model that keeps calling tools is stopped at the step limit', async () => {
    const { tool, runs } = pageTool()
    ai.toolCalls = [LOOKUP_CALL]
    const agent = makeAgent({ tools: [tool], maxSteps: 3 })
    const { result, updates } = await ask(agent, 'Which page am I on?')
    expect(result).toEqual({ status: 'step_limit', steps: 3 })
    expect(ai.calls).toHaveLength(3)
    // The last step's tool is refused, not run: the model would never see its result.
    expect(runs).toHaveLength(2)
    expect(toolStatuses(updates)).toEqual(['done', 'done', 'skipped'])
    // The panel gets a start for the refused call too, so it can mark that call as skipped.
    const refusedId = updates.filter((u) => u.type === 'tool_end').at(-1)!.id
    expect(updates).toContainEqual(expect.objectContaining({ type: 'tool_start', id: refusedId }))

    // The conversation stays usable: the next question is answered, with the refused call answered too.
    ai.toolCalls = undefined
    expect((await ask(agent, 'Thanks')).result).toEqual({ status: 'done' })
    expect(sentMessages(3).at(-2)).toMatchObject({ role: 'tool', content: expect.stringContaining('limit of 3 steps') })
  })

  it('[UC-WEBCO-AGENT-001-S03] a model that keeps calling failing tools is stopped after 10 failed calls', async () => {
    const runs: unknown[] = []
    const failing: ToolSpec = {
      ...pageTool().tool,
      run: async (args) => (runs.push(args), Promise.reject(new Error('Page not found.'))),
    }
    // Each step, a call that fails and one the user declines: only the failures count.
    ai.toolCalls = [LOOKUP_CALL, RENAME_CALL]
    const asking: ToolSpec = { ...renameTool().tool, needsConfirmation: true }
    const agent = makeAgent({ tools: [failing, asking] })
    const { result, updates } = await ask(agent, 'Which page am I on?', async () => false)
    expect(result).toEqual({
      status: 'error',
      message: 'Stopped: 10 actions in this question failed. Ask again, perhaps in other words.',
    })
    expect(ai.calls).toHaveLength(10)
    expect(runs).toHaveLength(10)
    // The call after the 10th failure, in the same step, is refused and the user is not asked.
    expect(toolStatuses(updates).slice(-3)).toEqual(['declined', 'failed', 'skipped'])

    // The next question starts counting again, and the model knows why the call was not run.
    ai.toolCalls = undefined
    expect((await ask(agent, 'Thanks')).result).toEqual({ status: 'done' })
    expect(sentMessages(10).at(-2)).toMatchObject({
      role: 'tool',
      content: 'Not run: 10 tool calls of this question failed, so it stopped.',
    })
  })

  it('[UC-WEBCO-AGENT-001-S04] stopping during a tool keeps the tools used so far, and drops what had not started', async () => {
    let agent: CopilotAgent
    const { tool: rename, runs } = renameTool()
    const slow: ToolSpec = {
      ...pageTool().tool,
      run: (_args, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
          agent.stop()
        }),
    }
    agent = makeAgent({ tools: [rename, slow] })
    // Step 1 renames the page. Step 2 looks it up, and would rename it again, but Stop comes first.
    ai.script = [{ toolCalls: [RENAME_CALL] }, { toolCalls: [LOOKUP_CALL, RENAME_CALL] }]
    const stopped = await ask(agent, 'Rename this page to Q4 Plan')
    expect(stopped.result).toEqual({ status: 'stopped' })
    expect(runs).toHaveLength(1)
    // The tool cut short shows as stopped, not as a failure of its own; the last call never started.
    expect(toolStatuses(stopped.updates)).toEqual(['done', 'stopped'])
    expect(agent.history().flatMap((m) => (m.role === 'tool' ? [[m.name, m.status]] : []))).toEqual([
      ['rename_page', 'done'],
      ['lookup_page', 'stopped'],
    ])

    // The next question carries both steps, each call answered right after it; the worker accepts it.
    expect((await ask(agent, 'What is it called now?')).result).toEqual({ status: 'done' })
    const sent = sentMessages(2)
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'user'])
    expect(sent[3]).toMatchObject({ role: 'tool', tool_call_id: 'chatcmpl-tool-0', content: 'Renamed.' })
    expect(sent[4]).toMatchObject({
      tool_calls: [{ id: 'chatcmpl-tool-1', function: { name: 'lookup_page' } }],
    })
    // The model is told the tool was cut short and may have done part of its work.
    expect(sent[5]).toMatchObject({
      role: 'tool',
      tool_call_id: 'chatcmpl-tool-1',
      // The tool's own error follows, in case it failed on its own.
      content: expect.stringMatching(/may have partly happened.*\n.*aborted/s),
    })
  })

  it('[UC-WEBCO-AGENT-001-S05] a question that fails after a tool ran keeps the tool for the next question', async () => {
    const { tool, runs } = renameTool()
    const failing: ToolSpec = {
      ...tool,
      run: async (args, signal, context) => {
        // The model fails on the request that sends the result back.
        ai.failWith = new Error('capacity')
        return tool.run(args, signal, context)
      },
    }
    const agent = makeAgent({ tools: [failing] })
    ai.script = [{ toolCalls: [RENAME_CALL] }]
    expect((await ask(agent, 'Rename this page to Q4 Plan')).result).toMatchObject({ status: 'error' })
    expect(runs).toEqual([{ title: 'Q4 Plan' }])

    ai.failWith = undefined
    expect((await ask(agent, 'Did it work?')).result).toEqual({ status: 'done' })
    expect(sentMessages(2)).toEqual([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'Rename this page to Q4 Plan' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'chatcmpl-tool-0',
            type: 'function',
            function: { name: 'rename_page', arguments: '{"title":"Q4 Plan"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'chatcmpl-tool-0', content: 'Renamed.' },
      { role: 'user', content: 'Did it work?' },
    ])
  })

  it('[UC-WEBCO-AGENT-001-S05] a question stopped or failed before any tool ran is left out', async () => {
    // Fails on the first model request.
    ai.failWith = new Error('capacity')
    const agent = makeAgent()
    expect((await ask(agent, 'first')).result).toMatchObject({ status: 'error' })
    ai.failWith = undefined

    // Stopped while its first model request is under way.
    let stopNext = true
    env.AI = ai = new (class extends FakeAiBinding {
      override async run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) {
        if (stopNext) stopping.stop()
        stopNext = false
        return super.run(model, inputs, options)
      }
    })('Hello from the worker')
    const stopping = makeAgent()
    expect((await ask(stopping, 'second')).result).toEqual({ status: 'stopped' })

    for (const a of [agent, stopping]) {
      expect(a.history()).toEqual([])
      await ask(a, 'hi')
      expect(ai.calls.at(-1)!.inputs.messages).toEqual([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'hi' },
      ])
    }
  })
})
