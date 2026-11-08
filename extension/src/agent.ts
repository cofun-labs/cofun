// The side panel's agent: asks the worker's model, runs the tools it calls in the extension, and
// sends the results back until the model answers. This is the only module that imports the agent
// runtime (pi); the rest of the extension uses the types below.
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
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
}

/** What the side panel shows while the agent works on a question. */
export type AgentUpdate =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  /** `skipped`: refused without running, because the question reached its step limit. */
  | { type: 'tool_end'; id: string; name: string; isError: boolean; skipped?: boolean }

export type AskResult =
  | { status: 'done' }
  | { status: 'stopped' }
  | { status: 'step_limit'; steps: number }
  | { status: 'error'; message: string }

export const DEFAULT_MAX_STEPS = 10
// The worker allows 200 messages and 200,000 characters, tools included.
const DEFAULT_HISTORY = { messages: 100, chars: 150_000 }

const SIGN_IN = 'Please sign in first.'

export class CopilotAgent {
  private agent?: Agent
  private model?: Model<'openai-completions'>
  private readonly maxSteps: number
  /** Bumped by stop() and reset(), so a question still waiting to start knows it was cancelled. */
  private epoch = 0
  /** The question this agent is answering; reset() clears it, since the next one gets a new pi agent. */
  private running?: object

  constructor(private readonly config: AgentConfig) {
    this.maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS
  }

  /**
   * Asks one question and resolves once the agent answered, stopped, hit the step limit, or failed.
   * The conversation carries over to the next question. A question that fails or is stopped is
   * dropped from it, so the model never sees a half-finished exchange.
   */
  async ask(text: string, onUpdate: (update: AgentUpdate) => void): Promise<AskResult> {
    // One question at a time: an overlapping run would roll back the other's messages.
    if (this.running) return { status: 'error', message: 'Already answering a question.' }
    const question = {}
    this.running = question
    try {
      return await this.askWithRetry(text, onUpdate)
    } finally {
      if (this.running === question) this.running = undefined
    }
  }

  private async askWithRetry(text: string, onUpdate: (update: AgentUpdate) => void): Promise<AskResult> {
    const epoch = this.epoch
    const { result, ranTools, code } = await this.askOnce(text, onUpdate, epoch)
    // The worker's model changed since this panel looked it up (a deploy). The worker refuses the
    // request before using any quota, so look the model up again and retry once, but only if no tool
    // ran yet: a retry runs the whole question again.
    if (code === 'unsupported_model' && !ranTools && epoch === this.epoch) {
      try {
        this.model = await this.loadModel()
      } catch (err) {
        return { status: 'error', message: (err as Error).message }
      }
      if (this.agent) this.agent.state.model = this.model
      return (await this.askOnce(text, onUpdate, epoch)).result
    }
    return result
  }

  private async askOnce(
    text: string,
    onUpdate: (update: AgentUpdate) => void,
    epoch: number,
  ): Promise<{ result: AskResult; ranTools: boolean; code?: string }> {
    let agent: Agent
    try {
      agent = await this.getAgent()
    } catch (err) {
      return { result: { status: 'error', message: (err as Error).message }, ranTools: false }
    }
    // Stopped, or a new chat started, while the agent was being set up.
    if (epoch !== this.epoch) return { result: { status: 'stopped' }, ranTools: false }

    const before = agent.state.messages.length
    let steps = 0
    let hitLimit = false
    let failure: Failure | undefined
    let stopped = false
    // The model gave its final answer; a Stop after this point is too late to drop it.
    let answered = false
    let ranTools = false
    const refused = new Set<string>()

    // On the last step, refuse the tools the model asks for instead of running them: the question
    // ends here, so the model would never see their results, and a tool could change a page.
    agent.beforeToolCall = async ({ toolCall }) => {
      if (steps < this.maxSteps) return
      hitLimit = true
      refused.add(toolCall.id)
      return {
        block: true,
        reason: `Not run: this question reached its limit of ${this.maxSteps} steps.`,
        terminate: true,
      }
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
      if (event.type === 'tool_execution_start') ranTools = true
      const update = toUpdate(event)
      if (update?.type === 'tool_end' && refused.has(update.id)) onUpdate({ ...update, skipped: true })
      else if (update) onUpdate(update)
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
      agent.state.messages = agent.state.messages.slice(0, before)
      const result: AskResult = stopped ? { status: 'stopped' } : { status: 'error', message: failure!.text }
      return { result, ranTools, code: stopped ? undefined : failure?.code }
    }
    return { result: hitLimit ? { status: 'step_limit', steps } : { status: 'done' }, ranTools }
  }

  /** Stops the current model call and any running tool. */
  stop(): void {
    this.epoch++
    this.agent?.abort()
  }

  /** Starts a new conversation, once a question still running has stopped. It looks up the model again. */
  async reset(): Promise<void> {
    this.epoch++
    const agent = this.agent
    this.agent = undefined
    this.model = undefined
    this.running = undefined
    if (!agent) return
    agent.abort()
    await agent.waitForIdle()
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
      return { type: 'tool_end', id: event.toolCallId, name: event.toolName, isError: event.isError }
    default:
      return undefined
  }
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
