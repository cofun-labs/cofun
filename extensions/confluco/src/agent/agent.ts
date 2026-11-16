// The conversation loop from Notico, using the Cofun hosted model and Confluence tools.
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { Credits, Grants, Packs, type PastGrant } from '../credits'
import { askUser, previewCall, toAgentTool, type Reporter } from './calls'
import { addUsage, detailsOf, recent, textOf, usedTools } from './history'
import type { CallCost, Failure, ModelProvider } from './provider'
import type {
  AgentConfig,
  AgentUpdate,
  AnsweredBy,
  AskResult,
  AssistantPart,
  ConfirmTool,
  HistoryMessage,
  QuestionCost,
  QuestionDetails,
  QuestionExtras,
  TokenUsage,
  ToolCallRequest,
  ToolSpec,
  ToolStatus,
  Turn,
} from './types'
import { ToolDetails } from './types'
import { checkout, hostedProvider, readOwn } from './worker'

const DEFAULT_MAX_STEPS = 20
/**
 * Tool calls of one question that may fail before it stops: a model that keeps retrying failing
 * tools wastes model calls, the user's time, and, for renders and searches, which cost the user
 * nothing when they fail, the operator's money. Calls the user declined or stopped don't count.
 */
const MAX_FAILED_CALLS = 10
/** What the user is told when a question stops at MAX_FAILED_CALLS. */
const TOO_MANY_FAILED = `Stopped: ${MAX_FAILED_CALLS} actions in this question failed. Ask again, perhaps in other words.`
/** For the model, for a call refused once the question stopped at MAX_FAILED_CALLS. */
const NOT_RUN_FAILED = `Not run: ${MAX_FAILED_CALLS} tool calls of this question failed, so it stopped.`

/**
 * How far the user's clock is ahead of UTC, in minutes: the worker totals usage per day, and a day
 * should be the user's own.
 */
const utcOffset = () => String(-new Date().getTimezoneOffset())
// What the model gets back for a call the user declined; it should not just try again.
const DECLINED = 'Not run: the user declined this action. Do not retry it; ask the user how to proceed instead.'
// The same when there was nobody to ask: the model must not claim the user said no.
const UNASKED = "Not run: this action needs the user's confirmation, and they could not be asked."
/** Added for the user when a question stops after a tool changed something, or may have. */
const MAY_HAVE_CHANGED = 'Some changes in this question may already have been made: check before asking again.'
/** For the model: the reason itself is in the failed tool's result. */
const STOPPED_BY_ERROR = "Not run: an earlier tool's error stopped the question."
/** For the model, when the question stopped while this call, or an earlier one, was being prepared. */
function stoppedInPreview(reason: string, earlier: boolean): string {
  const which = earlier ? 'an earlier action' : 'this action'
  return `Not run: the question stopped while ${which} was being prepared. The user was told: ${reason}`
}
// What the model gets back for a call the user stopped: whether it may have done something matters
// for a tool that changes a page.
const STOPPED_BEFORE = 'Not run: the user stopped the question before this action started.'
const STOPPED_DURING =
  'Stopped by the user while this action was running; it may have partly happened. Check before trying it again.'
export class CopilotAgent {
  private agent?: Agent
  private model?: Model<'openai-completions'>
  /** Where model requests go, and the settings it was made from. */
  private readonly provider: ModelProvider
  private readonly maxSteps: number
  /** Names of the tools that need the user's OK before each run. */
  private readonly confirmed: Set<string>
  private readonly tools: Map<string, ToolSpec>
  /** The tools as the agent runtime takes them: every one in Edit, and those that change no data in Read only. */
  private readonly allTools: AgentTool[]
  /** Bumped by stop(), so a question still waiting to start knows it was cancelled. */
  private epoch = 0
  /** Aborted with each epoch bump, so waits that pi doesn't cut short end too. */
  private cancel = new AbortController()
  /** The question this agent is answering. */
  private running?: object
  /** How each tool call ended, by its result message; pi itself only knows whether it failed. */
  private readonly statuses = new WeakMap<AgentMessage, ToolStatus>()
  /** What went with each question, by its user message; see QuestionExtras. */
  private readonly contexts = new WeakMap<AgentMessage, string>()
  /** The id each question's requests to the worker carried (see Turn), by its user message. */
  private readonly turns = new WeakMap<AgentMessage, string>()
  /** What each question used, by its user message; see QuestionDetails. */
  private readonly details = new WeakMap<AgentMessage, QuestionDetails>()
  /** Set by a tool whose error stops the question (see `stopsQuestion` in calls.ts): what the user is told. */
  private stopReason?: string
  /** The code of the error that set `stopReason`, if it had one: the worker's `out_of_credits`, say. */
  private stopCode?: string
  /** Set by a tool that changes data and changed something, or may have (see `changesData`). */
  private changed = false
  /** Set by a tool that failed with an error that has a code, until its call is reported as ended. */
  private failedWith?: string
  /** Takes each chunk of the model's streams while a question runs: what the calls cost is in them. */
  private onChunk?: (chunk: unknown) => void
  /** Which chat and question the requests of the question running are for. */
  private turn?: Turn

  /**
   * One agent holds one conversation: a new one, or `initial` to continue a saved one (see
   * history()). Another conversation gets another agent.
   */
  constructor(
    private readonly config: AgentConfig,
    private readonly initial: HistoryMessage[] = [],
  ) {
    this.provider = hostedProvider(config)
    this.maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS
    this.confirmed = new Set(config.tools.filter((t) => t.needsConfirmation).map((t) => t.name))
    this.tools = new Map(config.tools.map((t) => [t.name, t]))
    this.allTools = config.tools.map((t) => toAgentTool(t, () => this.reporter()))
  }

  /**
   * Asks one question and resolves once the agent answered, stopped, hit the step limit, or failed.
   * The conversation carries over to the next question. A question that fails or is stopped keeps
   * only the tools it used and how they ended, so the model learns what already happened (a tool may
   * have changed a page) but never sees a half-finished reply. If it used no tool, it is dropped.
   * The result carries the conversation with the question in it (`conversation`), which is the one to
   * save.
   *
   * `confirm` is asked before each run of a tool that needs confirmation. Without it, such tools
   * are declined. `extras` go with the question, and are saved with it. `signal` stops the question
   * as stop() does; one already aborted asks nothing and resolves `stopped`.
   */
  async ask(
    text: string,
    onUpdate: (update: AgentUpdate) => void,
    confirm?: ConfirmTool,
    extras: QuestionExtras = {},
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<AskResult> {
    // One question at a time: an overlapping run would roll back the other's messages.
    if (this.running) return { status: 'error', message: 'Already answering a question.', rounds: 0 }
    if (signal?.aborted) return { status: 'stopped', rounds: 0 }
    const question = {}
    this.running = question
    // Only while this question runs: aborted after it ended, the signal must not stop the next one.
    const onAbort = () => {
      if (this.running === question) this.stop()
    }
    signal?.addEventListener('abort', onAbort)
    try {
      return await this.askWithRetry(text, onUpdate, confirm, extras)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async askWithRetry(
    text: string,
    onUpdate: (update: AgentUpdate) => void,
    confirm: ConfirmTool | undefined,
    extras: QuestionExtras,
  ): Promise<AskResult> {
    const epoch = this.epoch
    // One id for the question, a retry below included: it is the same question.
    const turn: Turn = { turn: crypto.randomUUID(), ...(extras.chat && { chat: extras.chat }) }
    const { result, kept, failure } = await this.askOnce(text, onUpdate, epoch, confirm, extras, turn)
    // The provider's model changed since this panel looked it up (for the hosted one, a deploy, which
    // refuses the request before any credits are spent), so look the model up again. Retry once if
    // the question left nothing behind; a retry runs the whole question again, so after it used a
    // tool (which is now in the conversation), ask the user to repeat it instead.
    if (failure && this.provider.modelChanged(failure) && epoch === this.epoch) {
      // What the first try sent counts even when the question goes no further, and so does what it kept.
      const counted = {
        ...detailsOf(result),
        rounds: result.rounds,
        ...(result.conversation && { conversation: result.conversation }),
      }
      try {
        this.model = await this.provider.loadModel()
      } catch (err) {
        return { status: 'error', message: (err as Error).message, ...counted }
      }
      if (this.agent) this.agent.state.model = this.model
      // The question stays in the conversation with the tools it used, so the model can pick up
      // where it left off; asking the same question again could run those tools twice.
      if (kept) return { status: 'error', message: 'Confluco was just updated. Ask it to continue.', ...counted }
      return (await this.askOnce(text, onUpdate, epoch, confirm, extras, turn)).result
    }
    return result
  }

  /** `kept`: the question is part of the conversation now, answered or not. `failure`: why the model request failed. */
  private async askOnce(
    text: string,
    onUpdate: (update: AgentUpdate) => void,
    epoch: number,
    confirm: ConfirmTool | undefined,
    { context }: QuestionExtras,
    turn: Turn,
  ): Promise<{ result: AskResult; kept: boolean; failure?: Failure }> {
    let agent: Agent
    try {
      agent = await this.getAgent()
    } catch (err) {
      return { result: { status: 'error', message: (err as Error).message, rounds: 0 }, kept: false }
    }
    // Stopped while the agent was being set up.
    if (epoch !== this.epoch) return { result: { status: 'stopped', rounds: 0 }, kept: false }
    const before = agent.state.messages.length
    this.stopReason = undefined
    this.stopCode = undefined
    this.changed = false
    this.failedWith = undefined
    let steps = 0
    let hitLimit = false
    // Tool calls of this question that failed on their own, and whether that stopped it (see MAX_FAILED_CALLS).
    let failedCalls = 0
    let tooManyFailed = false
    let failure: Failure | undefined
    let stopped = false
    // The model gave its final answer; a Stop after this point is too late to drop it.
    let answered = false
    // What the model calls of this question reported they used, if any did.
    let tokens: TokenUsage | undefined
    // Sum the exact costs reported by the Worker for the question's model calls.
    let cost: QuestionCost | undefined
    let costUnknown = false
    const provider = this.provider
    // The model the question is asked of, read now, as the question starts.
    const model: AnsweredBy = { service: 'hosted' }
    // Cleared below only while it is still this question's: another may have started meanwhile.
    const onChunk = (chunk: unknown) => {
      let call: CallCost | undefined
      try {
        call = provider.callCost?.(chunk)
      } catch (err) {
        console.error('Could not read what a model call cost', err)
        costUnknown = true
      }
      if (call?.estimated) costUnknown = true
      else if (call) addCost(call.microCredits)
    }
    const addCost = (microCredits: number | undefined) => {
      if (microCredits === undefined) costUnknown = true
      else cost = { microCredits: (cost?.microCredits ?? 0) + microCredits }
    }
    this.onChunk = onChunk
    this.turn = turn
    const refused = new Set<string>()
    const declined = new Set<string>()
    // How the latest call with each id ended, kept with its result message when that arrives.
    const ended = new Map<string, { status: ToolStatus; result: string }>()
    // Calls allowed to run, so a Stop may have cut them short; the others never started. For a tool
    // that needs the user's OK, a Stop between the OK and the run counts as started: for a tool that
    // changes pages, "may have partly happened" is the safe thing to tell the model.
    const started = new Set<string>()
    // Why the question stopped, when it stopped in a call's preview rather than in a tool's run.
    let previewStop: string | undefined
    // On the last step, refuse the tools the model asks for instead of running them: the question
    // ends here, so the model would never see their results, and a tool could change a page.
    agent.beforeToolCall = async ({ toolCall, args }, signal) => {
      // A tool's error, or an earlier call's preview, stopped the question: nothing more runs.
      if (this.stopReason) {
        refused.add(toolCall.id)
        const reason =
          previewStop !== undefined
            ? stoppedInPreview(previewStop, true)
            : tooManyFailed
              ? NOT_RUN_FAILED
              : STOPPED_BY_ERROR
        return { block: true, reason, terminate: true }
      }
      if (steps >= this.maxSteps) {
        hitLimit = true
        refused.add(toolCall.id)
        return {
          block: true,
          reason: `Not run: this question reached its limit of ${this.maxSteps} steps.`,
          terminate: true,
        }
      }
      // From the arguments the tool runs with, and before it runs: the run may change what the preview reads.
      const { preview, stop } = await previewCall(this.tools.get(toolCall.name), args, signal)
      // Stopped while the preview looked things up: the tool must not start.
      if (signal?.aborted || epoch !== this.epoch) {
        return { block: true, reason: STOPPED_BEFORE }
      }
      // Confluence refused the preview: the question
      // stops here, before anyone is asked.
      if (stop) {
        this.stopReason ??= stop
        previewStop = stop
        refused.add(toolCall.id)
        return { block: true, reason: stoppedInPreview(stop, false), terminate: true }
      }
      onUpdate({ type: 'tool_ready', id: toolCall.id, args, preview })
      const call: ToolCallRequest = { id: toolCall.id, name: toolCall.name, args, preview }
      if (!this.confirmed.has(toolCall.name)) {
        started.add(toolCall.id)
        return
      }
      const answer = await askUser(confirm, call, signal)
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
      if (this.stopReason) return { action: 'end' }
      if (steps < this.maxSteps || toolResults.length === 0) return
      hitLimit = true
      return { action: 'end' }
    }
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === 'turn_start') steps++
      const update = toUpdate(event)
      if (update?.type === 'tool_end') {
        // Tools run one at a time, so a code reported since the last call ended is this call's.
        // A question stopped or left reports none: the code, if any, is the next question's.
        if (epoch === this.epoch) {
          if (update.status === 'failed' && this.failedWith) update.code = this.failedWith
          this.failedWith = undefined
        }
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
        // Counted after the status is settled: a call refused, declined, or stopped did not fail on its own.
        if (update.status === 'failed' && ++failedCalls >= MAX_FAILED_CALLS && !this.stopReason) {
          this.stopReason = TOO_MANY_FAILED
          tooManyFailed = true
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
        tokens = addUsage(tokens, m.usage)
        if (m.stopReason === 'error') failure = provider.parseError(m.errorMessage)
        if (m.stopReason === 'aborted') stopped = true
        const final = !m.content.some((block) => block.type === 'toolCall')
        if (final && (m.stopReason === 'stop' || m.stopReason === 'length')) answered = true
      }
    })

    // String content: the worker accepts only text, and pi would otherwise send content parts.
    const question: AgentMessage = { role: 'user', content: text, timestamp: Date.now() }
    try {
      if (context) this.contexts.set(question, context)
      if (turn.turn) this.turns.set(question, turn.turn)
      await agent.prompt(question)
    } catch (err) {
      failure ??= provider.parseError((err as Error).message)
    } finally {
      unsubscribe()
      agent.beforeToolCall = undefined
      agent.finishTurn = undefined
      if (this.onChunk === onChunk) this.onChunk = undefined
      if (this.turn === turn) this.turn = undefined
    }
    // Also stopped when the abort landed after a model reply that asked for tools, e.g. while a tool
    // finished. A stop after the final answer keeps it: the user has already read it.
    stopped ||= epoch !== this.epoch && !answered
    const changed = this.changed
    if (!stopped && this.stopReason)
      failure ??= {
        text: changed ? `${this.stopReason} ${MAY_HAVE_CHANGED}` : this.stopReason,
        ...(this.stopCode ? { code: this.stopCode } : {}),
      }
    // Kept with the question, so a saved session still has it. Only a question that ended normally has
    // a cost: one stopped or failed has none, since a call cut short never hears what it was charged
    // (the balance still shows it).
    const spent = costUnknown || stopped || failure ? undefined : cost
    const counted = detailsOf({ tokens, model, cost: spent })
    this.details.set(question, counted)
    const used = { ...counted, rounds: steps }
    if (failure || stopped) {
      const kept = usedTools(agent.state.messages.slice(before))
      agent.state.messages = [...agent.state.messages.slice(0, before), ...kept]
      const result: AskResult = stopped
        ? { status: 'stopped', ...used }
        : { status: 'error', message: failure!.text, ...(failure!.code ? { code: failure!.code } : {}), ...used }
      return {
        result: { ...result, ...(kept.length > 0 && { conversation: this.historyOf(agent) }) },
        kept: kept.length > 0,
        failure: stopped ? undefined : failure,
      }
    }
    const result: AskResult = hitLimit ? { status: 'step_limit', steps, ...used } : { status: 'done', ...used }
    return { result: { ...result, conversation: this.historyOf(agent) }, kept: true }
  }

  /** Stops the current model call and any running tool. */
  stop(): void {
    this.epoch++
    this.cancel.abort()
    this.cancel = new AbortController()
    this.agent?.abort()
  }

  /**
   * The conversation so far, to save and later continue with another agent. Of a question that failed or
   * was stopped, only the tools it used are part of it. Read it between questions: while one runs, it
   * is still changing.
   */
  history(): HistoryMessage[] {
    return this.agent ? this.historyOf(this.agent) : this.initial
  }

  private historyOf(agent: Agent): HistoryMessage[] {
    return agent.state.messages.flatMap((m) => this.toHistory(m))
  }

  private toHistory(message: AgentMessage): HistoryMessage[] {
    switch (message.role) {
      case 'user': {
        const context = this.contexts.get(message)
        const turn = this.turns.get(message)
        return [
          {
            role: 'user',
            text: textOf(message.content),
            ...(turn && { turn }),
            ...(context && { context }),
            ...this.details.get(message),
          },
        ]
      }
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
            ...withDetails(message.details),
          },
        ]
      default:
        return []
    }
  }

  private fromHistory(history: HistoryMessage[], model: Model<'openai-completions'>): AgentMessage[] {
    const timestamp = Date.now()
    return history.map((m): AgentMessage => {
      if (m.role === 'user') {
        const question: AgentMessage = { role: 'user', content: m.text, timestamp }
        if (m.context) this.contexts.set(question, m.context)
        if (m.turn) this.turns.set(question, m.turn)
        const details = detailsOf(m)
        if (Object.keys(details).length) this.details.set(question, details)
        return question
      }
      if (m.role === 'assistant') {
        const content: AssistantMessage['content'] = m.parts.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'toolCall', id: p.id, name: p.name, arguments: p.args },
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
        ...(m.details && { details: m.details }),
        isError: m.status !== 'done',
        timestamp,
      }
      this.statuses.set(result, m.status)
      return result
    })
  }

  /**
   * For a tool starting now: how it reports to the running question that it stops it (with a
   * reason for the user) or changed data. A tool still running from a question that was stopped
   * reports nothing to the next one.
   */
  private reporter(): Reporter {
    const epoch = this.epoch
    return {
      stop: (reason, code) => {
        if (epoch !== this.epoch || this.stopReason !== undefined) return
        this.stopReason = reason
        this.stopCode = code
      },
      changed: () => {
        if (epoch === this.epoch) this.changed = true
      },
      failed: (code) => {
        if (epoch === this.epoch) this.failedWith = code
      },
    }
  }

  private async getAgent(): Promise<Agent> {
    if (this.agent && this.model) return this.agent
    const model = (this.model ??= await this.provider.loadModel())
    // The provider changed since the agent was set up: the conversation goes on with its model.
    if (this.agent) {
      this.agent.state.model = model
      this.agent.identity = this.provider.identity
      return this.agent
    }
    // The tool definitions go with every request and count toward the provider's size limit.
    const toolChars = JSON.stringify(
      this.config.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    ).length
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.config.systemPrompt,
        model,
        tools: this.allTools,
        messages: this.fromHistory(this.initial, model),
      },
      streamFn: (m, context, options) => {
        // The question asking now: its request reports to it, even if another starts meanwhile.
        const onChunk = this.onChunk
        // Only the hosted provider is told which chat and question the request is for.
        const turn = this.turn && this.provider.turnHeaders?.(this.turn)
        return streamSimple(m as Model<'openai-completions'>, context, {
          ...options,
          ...(turn && { headers: { ...options?.headers, ...turn } }),
          onProviderStreamEvent: (chunk) => onChunk?.(chunk),
        })
      },
      getApiKey: () => this.provider.apiKey(),
      identity: this.provider.identity,
      // Tools can change pages; run them one at a time, in the order the model asked.
      toolExecution: 'sequential',
      transformContext: async (messages) =>
        recent(this.withNotes(messages), this.config.history ?? this.provider.history, toolChars),
    })
    return this.agent
  }

  /** Prefix each question with the page context captured when it was asked. */
  private withNotes(messages: AgentMessage[]): AgentMessage[] {
    return messages.map((message) => {
      if (message.role !== 'user') return message
      const notes = this.contexts.get(message)
      return notes ? { ...message, content: `${notes}\n\n${textOf(message.content)}` } : message
    })
  }

  /**
   * The signed-in user's credits, as the worker reports them. Reading them changes nothing. Throws
   * when they can't be read, when the answer is not what the panel expects, or when `signal` aborts.
   */
  async credits({ signal }: { signal?: AbortSignal } = {}): Promise<Credits> {
    return readOwn(this.config, 'credits', { utc_offset: utcOffset() }, Credits, signal)
  }

  /** Every grant the user was given, newest first. Read only when the user opens the history. */
  async creditGrants(): Promise<PastGrant[]> {
    return (await readOwn(this.config, 'credits/grants', {}, Grants)).grants
  }

  /** The packs of credits on offer. Read when the Credits page opens. */
  async creditPacks(): Promise<Packs> {
    return readOwn(this.config, 'billing/packs', {}, Packs)
  }

  /**
   * Starts buying the pack of `quantity` (a pack's quantity, as `creditPacks` lists it): the worker
   * makes a Stripe Checkout Session for it, for the signed-in user, and gives the URL of its page.
   * Nothing is bought until the user pays there.
   */
  async checkout(quantity: number): Promise<string> {
    return checkout(this.config, quantity)
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
        ...withDetails(event.result?.details),
      }
    default:
      return undefined
  }
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

/**
 * A tool result's details (see ToolDetails), as `{ details }` to spread, or nothing when it has none.
 * pi hands them back untyped, so they are parsed; details that don't parse are left out.
 */
function withDetails(value: unknown): { details?: ToolDetails } {
  const details = ToolDetails.safeParse(value)
  return details.success ? { details: details.data } : {}
}

/** The text a tool result gave the model. */
function resultText(result: { content?: { type: string; text?: string }[] } | undefined): string {
  return (result?.content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n')
}
