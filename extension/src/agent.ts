// The side panel's agent: asks the worker's model, runs the tools it calls in the extension, and
// sends the results back until the model answers. This is the only module that imports the agent
// runtime (pi); the rest of the extension uses the types below.
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Model, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'

export interface AgentConfig {
  /** Base URL including /v1. */
  apiUrl: string
  /** Returns a fresh Clerk session token. Called before every model request. */
  getToken: () => Promise<string | null>
  systemPrompt: string
  tools: ToolSpec[]
  /** Model calls allowed per question. */
  maxSteps?: number
  /** How much of a long conversation to send. Defaults stay well under the worker's limits. */
  history?: { messages: number; chars: number }
}

/** A tool the model can ask the extension to run. */
export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema of the arguments object. */
  parameters: object
  /** Runs the tool. Throw to report a failure to the model. */
  run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  /** The tool changes the user's data, so the user must agree each time before it runs. */
  needsConfirmation?: boolean
  /** What a call would do, in words, for the user to read before agreeing. */
  preview?: (args: Record<string, unknown>) => string | undefined
}

/** A tool call waiting for the user's OK. */
export interface ToolCallRequest {
  id: string
  name: string
  args: unknown
}

/** Asks the user whether a tool may run; resolves true to run it. */
export type ConfirmTool = (call: ToolCallRequest) => Promise<boolean>

/**
 * How a tool call ended. `skipped`: refused without running, because the question reached its step
 * limit. `stopped`: the user stopped the question while the tool ran or waited for their OK.
 * `declined`: the user did not let it run.
 */
export type ToolStatus = 'done' | 'failed' | 'skipped' | 'stopped' | 'declined'

/** What the side panel shows while the agent works on a question. */
export type AgentUpdate =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  /** `result`: what the model got back, the error message when the tool failed. */
  | { type: 'tool_end'; id: string; name: string; status: ToolStatus; result: string }

/**
 * The conversation as the agent keeps it, in a form of our own, so saved sessions don't depend on
 * the agent runtime. A reply is an assistant message followed by the results of the tools it called;
 * a question may take several such steps before the final answer.
 */
export type HistoryMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; parts: AssistantPart[] }
  /** The result of one tool call. `id` matches the call in the assistant message before it. */
  | { role: 'tool'; id: string; name: string; status: ToolStatus; result: string }

/** What the model wrote, in order: text and the tools it asked to run. */
export type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }

export type AskResult =
  | { status: 'done' }
  | { status: 'stopped' }
  | { status: 'step_limit'; steps: number }
  | { status: 'error'; message: string }

export const DEFAULT_MAX_STEPS = 10
// The worker allows 200 messages and 200,000 characters, tools included.
const DEFAULT_HISTORY = { messages: 100, chars: 150_000 }

const SIGN_IN = 'Please sign in first.'
// What the model gets back for a call the user declined; it should not just try again.
const DECLINED = 'Not run: the user declined this action. Do not retry it; ask the user how to proceed instead.'
// The same when there was nobody to ask: the model must not claim the user said no.
const UNASKED = "Not run: this action needs the user's confirmation, and they could not be asked."
// What the model gets back for a call the user stopped: whether it may have done something matters
// for a tool that changes a page.
const STOPPED_BEFORE = 'Not run: the user stopped the question before this action started.'
const STOPPED_DURING =
  'Stopped by the user while this action was running; it may have partly happened. Check before trying it again.'

export class CopilotAgent {
  private agent?: Agent
  private model?: Model<'openai-completions'>
  private readonly maxSteps: number
  /** Names of the tools that need the user's OK before each run. */
  private readonly confirmed: Set<string>
  /** Bumped by stop() and reset(), so a question still waiting to start knows it was cancelled. */
  private epoch = 0
  /** The question this agent is answering; reset() clears it, since the next one gets a new pi agent. */
  private running?: object
  /** The conversation to start from, used when the next pi agent is set up. */
  private initial: HistoryMessage[] = []
  /** How each tool call ended, by its result message; pi itself only knows whether it failed. */
  private readonly statuses = new WeakMap<AgentMessage, ToolStatus>()

  constructor(private readonly config: AgentConfig) {
    this.maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS
    this.confirmed = new Set(config.tools.filter((t) => t.needsConfirmation).map((t) => t.name))
  }

  /**
   * Asks one question and resolves once the agent answered, stopped, hit the step limit, or failed.
   * The conversation carries over to the next question. A question that fails or is stopped keeps
   * only the tools it used and how they ended, so the model learns what already happened (a tool may
   * have changed a page) but never sees a half-finished reply. If it used no tool, it is dropped.
   *
   * `confirm` is asked before each run of a tool that needs confirmation. Without it, such tools
   * are declined.
   */
  async ask(text: string, onUpdate: (update: AgentUpdate) => void, confirm?: ConfirmTool): Promise<AskResult> {
    // One question at a time: an overlapping run would roll back the other's messages.
    if (this.running) return { status: 'error', message: 'Already answering a question.' }
    const question = {}
    this.running = question
    try {
      return await this.askWithRetry(text, onUpdate, confirm)
    } finally {
      if (this.running === question) this.running = undefined
    }
  }

  private async askWithRetry(
    text: string,
    onUpdate: (update: AgentUpdate) => void,
    confirm?: ConfirmTool,
  ): Promise<AskResult> {
    const epoch = this.epoch
    const { result, kept, code } = await this.askOnce(text, onUpdate, epoch, confirm)
    // The worker's model changed since this panel looked it up (a deploy). The worker refuses the
    // request before using any quota, so look the model up again. Retry once if the question left
    // nothing behind; a retry runs the whole question again, so after it used a tool (which is now
    // in the conversation), ask the user to repeat it instead.
    if (code === 'unsupported_model' && epoch === this.epoch) {
      try {
        this.model = await this.loadModel()
      } catch (err) {
        return { status: 'error', message: (err as Error).message }
      }
      if (this.agent) this.agent.state.model = this.model
      // The question stays in the conversation with the tools it used, so the model can pick up
      // where it left off; asking the same question again could run those tools twice.
      if (kept) return { status: 'error', message: 'Copilot was just updated. Ask it to continue.' }
      return (await this.askOnce(text, onUpdate, epoch, confirm)).result
    }
    return result
  }

  /** `kept`: the question is part of the conversation now, answered or not. */
  private async askOnce(
    text: string,
    onUpdate: (update: AgentUpdate) => void,
    epoch: number,
    confirm?: ConfirmTool,
  ): Promise<{ result: AskResult; kept: boolean; code?: string }> {
    let agent: Agent
    try {
      agent = await this.getAgent()
    } catch (err) {
      return { result: { status: 'error', message: (err as Error).message }, kept: false }
    }
    // Stopped, or a new chat started, while the agent was being set up.
    if (epoch !== this.epoch) return { result: { status: 'stopped' }, kept: false }

    const before = agent.state.messages.length
    let steps = 0
    let hitLimit = false
    let failure: Failure | undefined
    let stopped = false
    // The model gave its final answer; a Stop after this point is too late to drop it.
    let answered = false
    const refused = new Set<string>()
    const declined = new Set<string>()
    // How the latest call with each id ended, kept with its result message when that arrives.
    const ended = new Map<string, { status: ToolStatus; result: string }>()
    // Calls allowed to run, so a Stop may have cut them short; the others never started. A Stop
    // between the OK and the run counts as started: for a tool that edits pages, "may have partly
    // happened" is the safe thing to tell the model.
    const started = new Set<string>()

    // On the last step, refuse the tools the model asks for instead of running them: the question
    // ends here, so the model would never see their results, and a tool could change a page.
    agent.beforeToolCall = async ({ toolCall, args }, signal) => {
      if (steps >= this.maxSteps) {
        hitLimit = true
        refused.add(toolCall.id)
        return {
          block: true,
          reason: `Not run: this question reached its limit of ${this.maxSteps} steps.`,
          terminate: true,
        }
      }
      if (!this.confirmed.has(toolCall.name)) {
        started.add(toolCall.id)
        return
      }
      const answer = await askUser(confirm, { id: toolCall.id, name: toolCall.name, args }, signal)
      if (answer === 'allow' && epoch === this.epoch) {
        started.add(toolCall.id)
        return
      }
      // Only a no from the user shows as declined. Stopped while waiting shows as stopped, and a
      // prompt that could not be shown as failed, with the reason.
      if (answer === 'deny' && epoch === this.epoch) declined.add(toolCall.id)
      return { block: true, reason: answer === 'deny' ? DECLINED : UNASKED }
    }
    // The model gets no more turns once the steps are used up. beforeToolCall above only sees calls
    // that pi could prepare; unknown tools and invalid arguments get error results without it.
    agent.finishTurn = async ({ toolResults }) => {
      if (steps < this.maxSteps || toolResults.length === 0) return
      hitLimit = true
      return { action: 'end' }
    }
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === 'turn_start') steps++
      const update = toUpdate(event)
      if (update?.type === 'tool_end') {
        if (refused.has(update.id)) update.status = 'skipped'
        else if (declined.has(update.id)) update.status = 'declined'
        // A tool cut short by Stop reports an error; it did not fail on its own. A tool that
        // finished anyway keeps its result: what it did happened.
        else if (update.status === 'failed' && epoch !== this.epoch) {
          update.status = 'stopped'
          // Tell the model whether the tool could have done anything. One that ran keeps its own
          // error too: it may have failed on its own just as Stop landed.
          update.result = started.has(update.id) ? `${STOPPED_DURING}\n${update.result}` : STOPPED_BEFORE
        }
        started.delete(update.id)
        ended.set(update.id, { status: update.status, result: update.result })
      }
      if (update) onUpdate(update)
      if (event.type === 'message_end' && event.message.role === 'toolResult') {
        const end = ended.get(event.message.toolCallId)
        if (end) this.statuses.set(event.message, end.status)
        // pi keeps this same message in the conversation, so the model gets the text the panel shows.
        if (end?.status === 'stopped') event.message.content = [{ type: 'text', text: end.result }]
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const m = event.message as AssistantMessage
        if (m.stopReason === 'error') failure = parseError(m.errorMessage)
        if (m.stopReason === 'aborted') stopped = true
        const final = !m.content.some((block) => block.type === 'toolCall')
        if (final && (m.stopReason === 'stop' || m.stopReason === 'length')) answered = true
      }
    })

    try {
      // String content: the worker accepts only text, and pi would otherwise send content parts.
      await agent.prompt({ role: 'user', content: text, timestamp: Date.now() })
    } catch (err) {
      failure ??= parseError((err as Error).message)
    } finally {
      unsubscribe()
      agent.beforeToolCall = undefined
      agent.finishTurn = undefined
    }

    // Also stopped when the abort landed after a model reply that asked for tools, e.g. while a tool
    // finished. A stop after the final answer keeps it: the user has already read it.
    stopped ||= epoch !== this.epoch && !answered
    if (failure || stopped) {
      const kept = usedTools(agent.state.messages.slice(before))
      agent.state.messages = [...agent.state.messages.slice(0, before), ...kept]
      const result: AskResult = stopped ? { status: 'stopped' } : { status: 'error', message: failure!.text }
      return { result, kept: kept.length > 0, code: stopped ? undefined : failure?.code }
    }
    return { result: hitLimit ? { status: 'step_limit', steps } : { status: 'done' }, kept: true }
  }

  /** Stops the current model call and any running tool. */
  stop(): void {
    this.epoch++
    this.agent?.abort()
  }

  /**
   * Starts another conversation: a new one, or `history` to continue a saved one. A question still
   * running is stopped first. It looks up the model again.
   */
  async reset(history: HistoryMessage[] = []): Promise<void> {
    this.epoch++
    const agent = this.agent
    this.agent = undefined
    this.model = undefined
    this.running = undefined
    this.initial = history
    if (!agent) return
    agent.abort()
    await agent.waitForIdle()
  }

  /**
   * The conversation so far, to save and later continue with reset(). Of a question that failed or
   * was stopped, only the tools it used are part of it. Read it between questions: while one runs, it
   * is still changing.
   */
  history(): HistoryMessage[] {
    if (!this.agent) return this.initial
    return this.agent.state.messages.flatMap((m) => this.toHistory(m))
  }

  private toHistory(message: AgentMessage): HistoryMessage[] {
    switch (message.role) {
      case 'user':
        return [{ role: 'user', text: textOf(message.content) }]
      case 'assistant':
        return [
          {
            role: 'assistant',
            parts: message.content.flatMap((block): AssistantPart[] => {
              if (block.type === 'text') return [{ type: 'text', text: block.text }]
              if (block.type === 'toolCall')
                return [{ type: 'tool_call', id: block.id, name: block.name, args: block.arguments }]
              return []
            }),
          },
        ]
      case 'toolResult':
        return [
          {
            role: 'tool',
            id: message.toolCallId,
            name: message.toolName,
            status: this.statuses.get(message) ?? (message.isError ? 'failed' : 'done'),
            result: textOf(message.content),
          },
        ]
      default:
        return []
    }
  }

  private fromHistory(history: HistoryMessage[], model: Model<'openai-completions'>): AgentMessage[] {
    const timestamp = Date.now()
    return history.map((m): AgentMessage => {
      if (m.role === 'user') return { role: 'user', content: m.text, timestamp }
      if (m.role === 'assistant') {
        const content: AssistantMessage['content'] = m.parts.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'toolCall', id: p.id, name: p.name, arguments: p.args as ToolCall['arguments'] },
        )
        return {
          role: 'assistant',
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST },
          stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop',
          timestamp,
        }
      }
      const result: AgentMessage = {
        role: 'toolResult',
        toolCallId: m.id,
        toolName: m.name,
        content: [{ type: 'text', text: m.result }],
        isError: m.status !== 'done',
        timestamp,
      }
      this.statuses.set(result, m.status)
      return result
    })
  }

  private async getAgent(): Promise<Agent> {
    if (this.agent) return this.agent
    const model = (this.model ??= await this.loadModel())
    // Another question (after a New chat) may have set up the agent while this one waited.
    if (this.agent) return this.agent
    // The tool definitions go with every request and count toward the worker's size limit.
    const toolChars = JSON.stringify(
      this.config.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    ).length
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.config.systemPrompt,
        model,
        tools: this.config.tools.map(toAgentTool),
        messages: this.fromHistory(this.initial, model),
      },
      streamFn: (m, context, options) => streamSimple(m as Model<'openai-completions'>, context, options),
      // A fresh Clerk token for every model request; they expire within minutes.
      getApiKey: async () => {
        const token = await this.config.getToken()
        if (!token) throw new Error(SIGN_IN)
        return token
      },
      // No provider attribution headers; the worker is our own.
      identity: { attribution: null },
      // Notion tools will change pages; run them one at a time, in the order the model asked.
      toolExecution: 'sequential',
      transformContext: async (messages) => recent(messages, this.config.history ?? DEFAULT_HISTORY, toolChars),
    })
    return this.agent
  }

  /** The worker fixes the model; ask it which one, so requests name it. */
  private async loadModel(): Promise<Model<'openai-completions'>> {
    const token = await this.config.getToken()
    if (!token) throw new Error(SIGN_IN)
    const baseUrl = this.config.apiUrl.replace(/\/+$/, '')
    const res = await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${token}` } })
    const body = (await res.json().catch(() => undefined)) as
      | { model?: string; error?: { message?: string } }
      | undefined
    if (!res.ok || !body?.model) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
    return {
      id: body.model,
      name: body.model,
      api: 'openai-completions',
      provider: 'notion-copilot',
      baseUrl,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
      // What the worker accepts: system (not developer) messages, max_tokens, no store field.
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStore: false,
        supportsStrictMode: false,
        maxTokensField: 'max_tokens',
      },
    }
  }
}

/**
 * What stays of a question that failed or was stopped (`tail`: its messages, starting with the
 * question): the question and each step's tool calls that ended, with their results, so every call
 * kept is still answered right after its message. A step's calls without a result are left out:
 * after a Stop, pi skips the calls that come after the one running. The reply that failed or was cut
 * off is left out with everything after it. Empty when the question used no tool.
 */
function usedTools(tail: AgentMessage[]): AgentMessage[] {
  // The question, with anything pi put before it.
  const start = tail.findIndex((m) => m.role === 'user') + 1
  const question = tail.slice(0, start)
  const rest = tail.slice(start)
  const kept: AgentMessage[] = []
  for (let i = 0; i < rest.length;) {
    const reply = rest[i]
    if (reply.role !== 'assistant' || reply.stopReason === 'error' || reply.stopReason === 'aborted') break
    let next = i + 1
    while (next < rest.length && rest[next].role === 'toolResult') next++
    const results = rest.slice(i + 1, next) as ToolResultMessage[]
    const answered = new Set(results.map((r) => r.toolCallId))
    const content = reply.content.filter((block) => block.type !== 'toolCall' || answered.has(block.id))
    if (!content.some((block) => block.type === 'toolCall')) break
    kept.push({ ...reply, content }, ...results)
    i = next
  }
  return kept.length ? [...question, ...kept] : []
}

/**
 * The leading system messages plus the newest part of the conversation that fits the limits.
 * The character budget also pays for the system prompt and the tool definitions (`overhead`).
 * It starts at a user message, so a reply or tool result is never sent without what led to it.
 * The newest question is always kept; if it alone is too long, the worker says so.
 */
function recent(
  messages: AgentMessage[],
  limits: { messages: number; chars: number },
  overhead: number,
): AgentMessage[] {
  let head = 0
  while (head < messages.length && messages[head].role === 'system') head++
  const rest = messages.slice(head)
  let start = rest.length
  let chars = overhead + messages.slice(0, head).reduce((n, m) => n + size(m), 0)
  for (let i = rest.length - 1; i >= 0 && rest.length - i <= limits.messages; i--) {
    chars += size(rest[i])
    if (chars > limits.chars) break
    if (rest[i].role === 'user') start = i
  }
  if (start === rest.length) {
    for (start = rest.length - 1; start > 0 && rest[start].role !== 'user'; start--);
  }
  return [...messages.slice(0, head), ...rest.slice(start)]
}

/** Characters a message adds to a request: its text, tool calls, and tool results. */
function size(message: AgentMessage): number {
  if (!('content' in message)) return 0
  const { content } = message
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const block of content) {
    if (block.type === 'text') n += block.text.length
    else if (block.type === 'toolCall') n += block.name.length + JSON.stringify(block.arguments).length
  }
  return n
}

/**
 * The user's answer. `unasked` when there was no way to ask (no callback, or it failed) or the
 * question was stopped while waiting: the tool must not run, but the user did not say no.
 */
function askUser(
  confirm: ConfirmTool | undefined,
  call: ToolCallRequest,
  signal?: AbortSignal,
): Promise<'allow' | 'deny' | 'unasked'> {
  if (!confirm || signal?.aborted) return Promise.resolve('unasked')
  return new Promise((resolve) => {
    const onAbort = () => resolve('unasked')
    signal?.addEventListener('abort', onAbort, { once: true })
    confirm(call)
      .then(
        (allow) => resolve(allow ? 'allow' : 'deny'),
        () => resolve('unasked'),
      )
      .finally(() => signal?.removeEventListener('abort', onAbort))
  })
}

function toAgentTool(spec: ToolSpec): AgentTool {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (_id, params, signal) => {
      const result = await spec.run(params as Record<string, unknown>, signal)
      // JSON.stringify(undefined) is undefined; tool results must be strings.
      const text = typeof result === 'string' ? result : (JSON.stringify(result) ?? '')
      return { content: [{ type: 'text', text }], details: undefined }
    },
  }
}

function toUpdate(event: AgentEvent): AgentUpdate | undefined {
  switch (event.type) {
    case 'message_update':
      return event.assistantMessageEvent.type === 'text_delta'
        ? { type: 'text', delta: event.assistantMessageEvent.delta }
        : undefined
    case 'tool_execution_start':
      return { type: 'tool_start', id: event.toolCallId, name: event.toolName, args: event.args }
    case 'tool_execution_end':
      return {
        type: 'tool_end',
        id: event.toolCallId,
        name: event.toolName,
        status: event.isError ? 'failed' : 'done',
        result: resultText(event.result),
      }
    default:
      return undefined
  }
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

/** The text of a message's content: a string, or text blocks among others. */
function textOf(content: string | { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content
  return content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n')
}

/** The text a tool result gave the model. */
function resultText(result: { content?: { type: string; text?: string }[] } | undefined): string {
  return (result?.content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n')
}

/**
 * The worker's own error message and code when there are any. The SDK reports HTTP errors as
 * `<status>: <body>` or `<status> <message>`, and the worker's body is `{ error: { code, message } }`
 * (sometimes already unwrapped to `{ code, message }`).
 */
function parseError(message: string | undefined): Failure {
  if (!message) return { text: 'The model failed.' }
  const rest = message.replace(/^\d{3}:?\s+/, '')
  try {
    const body = JSON.parse(rest) as {
      code?: unknown
      message?: unknown
      error?: { code?: unknown; message?: unknown }
    }
    const inner = body.error ?? body
    if (typeof inner.message === 'string' && inner.message) {
      return { text: inner.message, code: typeof inner.code === 'string' ? inner.code : undefined }
    }
  } catch {}
  return { text: rest }
}

interface Failure {
  text: string
  /** The worker's error code, e.g. `unsupported_model`. */
  code?: string
}
