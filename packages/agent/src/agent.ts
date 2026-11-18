// The side panel's agent: asks the model, runs the tools it calls in the extension, and sends the
// results back until the model answers. Where the model runs is a provider (see ModelProvider in
// provider.ts): our worker (the hosted one, hosted.ts), or OpenRouter with the user's own key
// (own.ts). Only this package imports the agent runtime (pi); an extension uses the types in
// types.ts, through index.ts.
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import {
  type AssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type Message,
  type Model,
} from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { CallCost } from '@cofun/worker-client'
import { askUser, previewCall, toAgentTool, type Reporter } from './calls'
import {
  COMPACTION_FAILED,
  fitsRequest,
  MAX_SUMMARY_CHUNKS,
  guardHostedPayload,
  planCompaction,
  project,
  requestBudget,
  summaryRequest,
  summaryText,
} from './compaction'
import { addUsage, detailsOf, textOf, usedTools } from './history'
import { ownProvider, type OwnSetup } from './own'
import { HOSTED_TRIGGER, type Failure, type ModelProvider } from './provider'
import { writeTitle } from './title'
import type {
  AgentConfig,
  AgentUpdate,
  AnsweredBy,
  AskOnCard,
  AskResult,
  AssistantPart,
  Compaction,
  ConfirmTool,
  HistoryMessage,
  QuestionCost,
  QuestionDetails,
  QuestionExtras,
  QuestionPage,
  QuestionSelection,
  TokenUsage,
  ToolCallRequest,
  ToolSpec,
  ToolStatus,
  Turn,
  WebCost,
} from './types'
import { ToolDetails } from './types'

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

// What the model gets back for a call the user declined; it should not just try again.
const DECLINED = 'Not run: the user declined this action. Do not retry it; ask the user how to proceed instead.'
// The same when there was nobody to ask: the model must not claim the user said no.
const UNASKED = "Not run: this action needs the user's confirmation, and they could not be asked."
/** Added for the user when a question stops after a tool changed something, or may have. */
export const MAY_HAVE_CHANGED = 'Some changes in this question may already have been made: check before asking again.'
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
/** What the model is told to do with a question in Read only that asks for a change. */
const READ_ONLY_ANSWER =
  "If the question asks for a change, make none and don't describe one as done: say you can't make changes in " +
  'Read only, and that the user can switch to Edit with the mode button at the bottom left of the message box ' +
  'and ask again.'
/** What the model is told of the mode of a question, in the words of the extension it runs in (see AgentConfig). */
function modeNotes(product: string, data: string) {
  return {
    /**
     * Ahead of a question asked in Read only: the tools that change data are still offered (the
     * same tools in every request keep the prompt cache), and are refused when called.
     */
    readOnly:
      `[Read only: the user set ${product} to Read only for this question, so the tools that change ${data} are refused: ` +
      `don't call them. ${READ_ONLY_ANSWER} You can still read and answer.]`,
    /** For a call, in Read only, of a tool that changes data. */
    notRun: `Not run: this question is in Read only, so no tool that changes ${data} runs. ${READ_ONLY_ANSWER}`,
    /** Ahead of a question asked in Edit right after one in Read only: the tools that change data work again. */
    edit: `[Edit: the user switched ${product} back to Edit, so the tools that change ${data} work again.]`,
  }
}

/**
 * The agent of one conversation. `M` is the extension's memory of it, which every tool call gets
 * (see ToolContext.memory).
 */
export class CopilotAgent<M = unknown> {
  private agent?: Agent
  private model?: Model<'openai-completions'>
  /** Where model requests go, and the settings it was made from. */
  private provider: ModelProvider
  private providerFor?: OwnSetup | 'hosted'
  private readonly maxSteps: number
  private readonly tools: Map<string, ToolSpec<M>>
  /** The notes and refusals of the modes, in the extension's words. */
  private readonly notes: ReturnType<typeof modeNotes>
  /**
   * The tools as the agent runtime takes them: every one, in every mode. Read only refuses those that
   * change data when they are called (see beforeToolCall): a tool set that changed with the mode would
   * change the start of the request, which the provider's prompt cache reuses.
   */
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
  private readonly pages = new WeakMap<AgentMessage, QuestionPage[]>()
  private readonly selections = new WeakMap<AgentMessage, QuestionSelection[]>()
  private readonly readOnly = new WeakSet<AgentMessage>()
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
  /** Asks the user on the card of the call running now, in the question being answered. */
  private askOnCard?: AskOnCard
  /** Takes each chunk of the model's streams while a question runs: what the calls cost is in them. */
  private onChunk?: (chunk: unknown) => void
  /**
   * Adds what a render or a search cost to the question running, in micro-credits (undefined when it
   * could not be read), and which of the two it was.
   */
  private onCost?: (microCredits: number | undefined, kind: WebCost) => void
  /** Which chat and question the requests of the question running are for. */
  private turn?: Turn
  private compaction?: Compaction
  /** Real usage is useful only for a reply made with the same model and prefix. */
  private readonly usagePrefix = new WeakMap<AssistantMessage, Compaction | undefined>()
  private onOverflow?: (signal?: AbortSignal) => Promise<Message[] | undefined>
  private onModelRequest?: () => void
  private toolChars = 0

  /**
   * One agent holds one conversation: a new one, or `initial` to continue a saved one (see
   * history()). Another conversation gets another agent. `memory` is what the tools remember of
   * this conversation, given to every call (see ToolContext.memory): one of its own for each chat,
   * which the extension makes, and may set things in between questions (what each one carries).
   */
  constructor(
    private readonly config: AgentConfig<M>,
    readonly memory: M,
    private readonly initial: HistoryMessage[] = [],
    compaction?: Compaction,
  ) {
    if (compaction && compaction.firstKept <= initial.length && initial[compaction.firstKept]?.role !== 'tool') {
      this.compaction = compaction
    }
    this.provider = config.hosted
    this.notes = modeNotes(config.product, config.data)
    this.maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS
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
      if (this.running === question) this.running = undefined
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
    // Once per question: a retry below goes to the same model, whatever the user chose meanwhile.
    try {
      await this.chooseProvider()
    } catch (err) {
      return { status: 'error', message: (err as Error).message, rounds: 0 }
    }
    const { result, kept, failure, summarized } = await this.askOnce(text, onUpdate, epoch, confirm, extras, turn)
    // The provider's model changed since this panel looked it up (for the hosted one, a deploy, which
    // refuses the request before any credits are spent), so look the model up again. Retry once if
    // the question left nothing behind; a retry runs the whole question again, so after it used a
    // tool (which is now in the conversation), ask the user to repeat it instead.
    if (failure && this.provider.modelChanged(failure) && epoch === this.epoch) {
      // What the first try sent counts even when the question goes no further, and so does what it kept.
      const counted = {
        ...detailsOf(result),
        rounds: result.rounds,
        ...(result.conversation && { conversation: result.conversation, compaction: result.compaction }),
      }
      try {
        this.model = await this.provider.loadModel()
      } catch (err) {
        return { status: 'error', message: (err as Error).message, ...counted }
      }
      if (this.agent) this.agent.state.model = this.model
      // The question stays in the conversation with the tools it used, so the model can pick up
      // where it left off; asking the same question again could run those tools twice.
      if (kept || summarized)
        return { status: 'error', message: `${this.config.product} was just updated. Ask it to continue.`, ...counted }
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
    { context, pages, selections, readOnly }: QuestionExtras,
    turn: Turn,
  ): Promise<{ result: AskResult; kept: boolean; failure?: Failure; summarized?: boolean }> {
    let agent: Agent
    try {
      agent = await this.getAgent()
    } catch (err) {
      return { result: { status: 'error', message: (err as Error).message, rounds: 0 }, kept: false }
    }
    // Stopped while the agent was being set up.
    if (epoch !== this.epoch) return { result: { status: 'stopped', rounds: 0 }, kept: false }

    const before = agent.state.messages.length
    const previous = this.compaction
    this.stopReason = undefined
    this.stopCode = undefined
    this.changed = false
    this.failedWith = undefined
    let steps = 0
    let rounds = 0
    let summarized = false
    let compactionFailed = false
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
    // What they cost, summed as the worker reports each call (the hosted model only), with what the
    // pages rendered for it cost (whichever model answers). A cost that could not be read, or was
    // estimated, leaves the sum unknown: only an exact one is shown.
    let cost: QuestionCost | undefined
    let costUnknown = false
    const provider = this.provider
    // The model the question is asked of, read now, as the question starts.
    const model = this.answeredBy()
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
    // A render's or a search's cost is counted apart too, so the reply's details can split the cost.
    const addCost = (microCredits: number | undefined, kind?: WebCost) => {
      if (microCredits === undefined) costUnknown = true
      else {
        cost = { ...cost, microCredits: (cost?.microCredits ?? 0) + microCredits }
        if (kind) cost[kind] = (cost[kind] ?? 0) + microCredits
      }
    }
    const onModelRequest = () => rounds++
    this.onModelRequest = onModelRequest
    this.onChunk = onChunk
    this.onCost = addCost
    this.turn = turn
    let prepared: Message[] | undefined
    let raw: Message[] = []
    const selected = agent.state.model as Model<'openai-completions'>
    const toolChars = this.toolChars
    const compact = async (budget: ReturnType<typeof requestBudget>, signal?: AbortSignal) => {
      const plan = planCompaction(raw, this.compaction, budget.hard, toolChars)
      if (!plan) return undefined
      try {
        // Reject a prefix that cannot possibly fit in four requests before spending credits.
        const maxCharsPerChunk = Math.min(budget.summary.chars, budget.summary.tokens * 3)
        if (plan.source.length > maxCharsPerChunk * MAX_SUMMARY_CHUNKS) throw new Error(COMPACTION_FAILED)
        let next = this.compaction
        let offset = 0
        for (let part = 0; offset < plan.source.length; part++) {
          if (part >= MAX_SUMMARY_CHUNKS) throw new Error(COMPACTION_FAILED)
          const input = summaryRequest(plan.source, offset, next?.summary, budget.summary)
          const key = await provider.apiKey()
          signal?.throwIfAborted()
          const stream = streamSimple(selected, normalizeContext({ messages: input.messages }), {
            apiKey: key,
            identity: provider.identity,
            headers: provider.turnHeaders?.(turn),
            maxTokens: budget.maxSummaryTokens,
            maxRetries: 0,
            signal,
            onPayload: (payload) => {
              signal?.throwIfAborted()
              if (selected.provider === 'cofun') guardHostedPayload(payload)
              onModelRequest()
            },
            onProviderStreamEvent: onChunk,
          })
          for await (const _event of stream);
          const answer = await stream.result()
          signal?.throwIfAborted()
          tokens = addUsage(tokens, answer.usage)
          if (answer.stopReason === 'error') throw new Error(answer.errorMessage ?? COMPACTION_FAILED)
          // Even an unusable answer may have been charged.
          summarized = true
          next = summaryText(answer, plan.firstKept)
          offset = input.end
        }
        const sent = project(raw, next)
        if (!fitsRequest(sent, budget.hard, toolChars)) throw new Error(COMPACTION_FAILED)
        this.compaction = next
        return sent
      } catch (error) {
        compactionFailed = true
        throw error
      }
    }

    // prepareRequest can stop the run on failure. Keep Pi's loop context and agent.state intact,
    // and let the non-throwing transform deliver the prepared view only to the model.
    agent.prepareRequest = async ({ context }, signal) => {
      raw = this.withNotes(context.messages)
      const budget = requestBudget(
        selected,
        this.config.history ?? (selected.provider === 'cofun' ? HOSTED_TRIGGER : undefined),
      )
      const current = project(raw, this.compaction)
      const usageApplies = (message: AssistantMessage) =>
        message.api === selected.api &&
        message.provider === selected.provider &&
        message.model === selected.id &&
        this.usagePrefix.has(message) &&
        this.usagePrefix.get(message) === this.compaction
      this.onOverflow = (retrySignal) => compact(budget, retrySignal)
      prepared = fitsRequest(current, budget.trigger, toolChars, usageApplies)
        ? current
        : ((await compact(budget, signal)) ?? current)
      if (!fitsRequest(prepared, budget.hard, toolChars, usageApplies)) {
        compactionFailed = true
        throw new Error(COMPACTION_FAILED)
      }
    }
    agent.transformContext = async (messages) => prepared ?? messages
    const refused = new Set<string>()
    const declined = new Set<string>()
    // How the latest call with each id ended, kept with its result message when that arrives.
    const ended = new Map<string, { status: ToolStatus; result: string }>()
    // Calls allowed to run, so a Stop may have cut them short; the others never started. For a tool
    // that needs the user's OK, a Stop between the OK and the run counts as started: for a tool that
    // changes pages, "may have partly happened" is the safe thing to tell the model.
    const started = new Set<string>()
    // The call running now (tools run one at a time), for a question it puts to the user.
    let running: ToolCallRequest | undefined
    // Why the question stopped, when it stopped in a call's preview rather than in a tool's run.
    let previewStop: string | undefined
    // A question the running call puts to the user, on its card: the meter's at the request budget,
    // or the tool's own (see ToolSpec.run).
    const askOnCard: AskOnCard = async ({ text, access }) => {
      const call = running
      if (!call || epoch !== this.epoch) return false
      const answer = await askUser(confirm, { ...call, question: text, access }, this.cancel.signal)
      // A site the user did not let the extension read is their choice, not a failure: the call shows as
      // declined, with the tool's own error for the model.
      if (access && answer === 'deny' && epoch === this.epoch) declined.add(call.id)
      return answer === 'allow' && epoch === this.epoch
    }
    this.askOnCard = askOnCard
    const meter = this.config.meter?.((text) => askOnCard({ text }))

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
      // Read only is taken as the question starts: a mode switched while it runs applies from the next
      // one. Refused before the preview, which may look things up for a change that won't be made.
      if (readOnly && this.tools.get(toolCall.name)?.changesData) {
        refused.add(toolCall.id)
        return { block: true, reason: this.notes.notRun }
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
      // Running from here on: a preview's lookups count toward the question, so at its request budget
      // they ask the user on this call's card.
      running = { id: toolCall.id, name: toolCall.name, args }
      // From the arguments the tool runs with, and before it runs: the run may change what the preview reads.
      const tool = this.tools.get(toolCall.name)
      const context = this.reporter().context
      const { preview, stop } = await previewCall(tool, args, context, signal)
      // Stopped while the preview looked things up: the tool must not start.
      if (signal?.aborted || epoch !== this.epoch) {
        running = undefined
        return { block: true, reason: STOPPED_BEFORE }
      }
      // A site turned the preview's lookups away, or the user stopped at the budget: the question
      // stops here, before anyone is asked.
      if (stop) {
        running = undefined
        this.stopReason ??= stop
        previewStop = stop
        refused.add(toolCall.id)
        return { block: true, reason: stoppedInPreview(stop, false), terminate: true }
      }
      onUpdate({ type: 'tool_ready', id: toolCall.id, args, preview })
      const call: ToolCallRequest = { id: toolCall.id, name: toolCall.name, args, preview }
      running = call
      const approval = tool?.needsConfirmation
      if (!(typeof approval === 'function' ? approval(context) : approval)) {
        started.add(toolCall.id)
        return
      }
      const answer = await askUser(confirm, call, signal)
      if (answer === 'allow' && epoch === this.epoch) {
        started.add(toolCall.id)
        return
      }
      running = undefined
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
        if (running?.id === update.id) running = undefined
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
        if (m.stopReason !== 'error' && m.stopReason !== 'aborted') this.usagePrefix.set(m, this.compaction)
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
      if (pages?.length) this.pages.set(question, pages)
      if (selections?.length) this.selections.set(question, selections)
      if (readOnly) this.readOnly.add(question)
      if (turn.turn) this.turns.set(question, turn.turn)
      await agent.prompt(question)
    } catch (err) {
      failure ??= provider.parseError((err as Error).message)
    } finally {
      unsubscribe()
      agent.beforeToolCall = undefined
      agent.finishTurn = undefined
      agent.prepareRequest = undefined
      this.onOverflow = undefined
      agent.transformContext = undefined
      if (this.onModelRequest === onModelRequest) this.onModelRequest = undefined
      if (this.onChunk === onChunk) this.onChunk = undefined
      if (this.onCost === addCost) this.onCost = undefined
      if (this.turn === turn) this.turn = undefined
    }
    // Also stopped when the abort landed after a model reply that asked for tools, e.g. while a tool
    // finished. A stop after the final answer keeps it: the user has already read it.
    stopped ||= epoch !== this.epoch && !answered
    // A write that was sent counts even when the tool that sent it does not say it changed data.
    const changed = this.changed || meter?.wrote === true
    if (!stopped && this.stopReason)
      failure ??= {
        text: changed ? `${this.stopReason} ${MAY_HAVE_CHANGED}` : this.stopReason,
        ...(this.stopCode ? { code: this.stopCode } : {}),
      }
    // Kept with the question, so a saved session still has it. Only a question that ended normally has
    // a cost: one stopped or failed has none, since a call cut short never hears what it was charged
    // (the balance still shows it).
    const spent = costUnknown || stopped || failure ? undefined : cost
    const counted = detailsOf({ requests: meter?.requests, tokens, model, cost: spent })
    this.details.set(question, counted)
    const used = { ...counted, rounds }
    if (failure || stopped) {
      const kept = usedTools(agent.state.messages.slice(before))
      agent.state.messages = [...agent.state.messages.slice(0, before), ...kept]
      // The new summary may cover messages usedTools dropped. Restore the checkpoint for the old prefix.
      this.compaction = previous
      const result: AskResult = stopped
        ? { status: 'stopped', ...used, ...(changed && { warning: MAY_HAVE_CHANGED }) }
        : {
            status: 'error',
            message: compactionFailed && changed ? `${failure!.text} ${MAY_HAVE_CHANGED}` : failure!.text,
            ...(failure!.code ? { code: failure!.code } : {}),
            ...used,
          }
      return {
        result: {
          ...result,
          ...(kept.length > 0 && { conversation: this.historyOf(agent), compaction: this.compaction }),
        },
        summarized,
        kept: kept.length > 0,
        failure: stopped ? undefined : failure,
      }
    }
    const result: AskResult = hitLimit ? { status: 'step_limit', steps, ...used } : { status: 'done', ...used }
    return { result: { ...result, conversation: this.historyOf(agent), compaction: this.compaction }, kept: true }
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
        const pages = this.pages.get(message)
        const selections = this.selections.get(message)
        const turn = this.turns.get(message)
        return [
          {
            role: 'user',
            text: textOf(message.content),
            ...(turn && { turn }),
            ...(context && { context }),
            ...(pages && { pages }),
            ...(selections && { selections }),
            ...(this.readOnly.has(message) && { readOnly: true as const }),
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
        if (m.pages?.length) this.pages.set(question, m.pages)
        if (m.selections?.length) this.selections.set(question, m.selections)
        if (m.readOnly) this.readOnly.add(question)
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
  private reporter(): Reporter<M> {
    const epoch = this.epoch
    const running = this.running
    // The question the tool runs for: its requests to the worker say so.
    const turn = this.turn
    const userMessage = this.agent?.state.messages.findLast((message) => message.role === 'user')
    return {
      stop: (reason, code) => {
        if (epoch !== this.epoch || this.stopReason !== undefined) return
        this.stopReason = reason
        this.stopCode = code
      },
      changed: () => {
        if (running === this.running) this.changed = true
      },
      failed: (code) => {
        if (epoch === this.epoch) this.failedWith = code
      },
      context: {
        userText: userMessage?.role === 'user' ? textOf(userMessage.content) : '',
        ask: async (question) => (epoch === this.epoch && this.askOnCard ? this.askOnCard(question) : false),
        // The same whichever model answers. A render or a search may cost credits, and the question it
        // was for counts them; a plain read is free.
        readWeb: (url, maxChars, render, signal) =>
          this.config.web.read(url, maxChars, render, {
            signal,
            turn,
            charged: (cost) => {
              if (epoch === this.epoch) this.onCost?.(cost, 'renders')
            },
          }),
        searchWeb: (query, limit, signal) =>
          this.config.web.search(query, limit, {
            signal,
            turn,
            charged: (cost) => {
              if (epoch === this.epoch) this.onCost?.(cost, 'searches')
            },
          }),
        keep: async (result) => {
          const store = this.config.results
          if (!store) throw new Error('There is no store to keep results in.')
          return store.keep(result)
        },
        kept: async (id) => {
          if (!this.namesResult(id)) return 'unknown'
          return (await this.config.results?.result(id)) ?? 'gone'
        },
        memory: this.memory,
      },
    }
  }

  /**
   * Whether the conversation's tool results name the kept result `id` (see ToolDetails.result): only
   * those can be read, so a result of another chat is never read in this one.
   */
  private namesResult(id: string): boolean {
    const messages = this.agent?.state.messages ?? []
    return messages.some((m) => m.role === 'toolResult' && ToolDetails.safeParse(m.details).data?.result === id)
  }

  /**
   * Uses the provider the settings name now. Another one than before drops the model, so the next
   * request looks it up from the new provider; the conversation stays.
   */
  private async chooseProvider(): Promise<void> {
    const choice = (await this.config.model?.()) ?? 'hosted'
    const before = this.providerFor
    this.providerFor = choice
    // The agent starts on the hosted provider.
    if (before === undefined ? choice === 'hosted' : JSON.stringify(before) === JSON.stringify(choice)) return
    this.provider = choice === 'hosted' ? this.config.hosted : ownProvider(choice)
    this.model = undefined
  }

  /** The model the question being answered is asked of, once it has been looked up. */
  private answeredBy(): AnsweredBy | undefined {
    const used = this.providerFor
    if (used === undefined || used === 'hosted') return { service: 'hosted' }
    return this.model && { service: used.service, name: this.model.name }
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
    this.toolChars = JSON.stringify(
      this.config.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
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
        const onModelRequest = this.onModelRequest
        // Only the hosted provider is told which chat and question the request is for.
        const turn = this.turn && this.provider.turnHeaders?.(this.turn)
        const selected = m as Model<'openai-completions'>
        const streamOptions = {
          ...options,
          ...(turn && { headers: { ...options?.headers, ...turn } }),
          onProviderStreamEvent: (chunk: unknown) => onChunk?.(chunk),
          onPayload: (payload: unknown) => {
            options?.signal?.throwIfAborted()
            if (m.provider === 'cofun') guardHostedPayload(payload)
            onModelRequest?.()
          },
        }
        const stream = streamSimple(selected, context, streamOptions)
        const overflow = this.onOverflow
        return overflow
          ? retryOnOverflow(stream, async () => {
              options?.signal?.throwIfAborted()
              const messages = await overflow(options?.signal)
              return (
                messages && streamSimple(selected, normalizeContext({ messages }), { ...streamOptions, maxRetries: 0 })
              )
            })
          : stream
      },
      getApiKey: () => this.provider.apiKey(),
      identity: this.provider.identity,
      // Tools can change pages; run them one at a time, in the order the model asked.
      toolExecution: 'sequential',
    })
    return this.agent
  }

  /**
   * The questions as the model gets them: each with its notes first, then what the user typed. The
   * notes are the mode, for a question in Read only and for the first one back in Edit, then the
   * question's context.
   */
  private withNotes(messages: AgentMessage[]): AgentMessage[] {
    let readOnlyBefore = false
    return messages.map((message) => {
      if (message.role !== 'user') return message
      const readOnly = this.readOnly.has(message)
      const mode = readOnly ? this.notes.readOnly : readOnlyBefore ? this.notes.edit : undefined
      readOnlyBefore = readOnly
      const notes = [mode, this.contexts.get(message)].filter(Boolean).join('\n')
      return notes ? { ...message, content: `${notes}\n\n${textOf(message.content)}` } : message
    })
  }

  /**
   * A short title for the conversation `history`, written from its first question and the start of
   * the reply to it. Call it once that reply has come in: it asks the model that answered, so it goes
   * only where the conversation already went, and on the hosted model it spends credits like any
   * request. Resolves undefined, never rejects, when there is no title to use: the request failed,
   * or the model's answer is not a title (see `ModelTitle` in title.ts). `chat` is the session's id:
   * on the hosted model, the request counts toward the chat's first question (see Turn). `signal`
   * cuts the request short, which also resolves undefined.
   */
  async title(
    history: HistoryMessage[],
    { chat, signal }: { chat?: string; signal?: AbortSignal } = {},
  ): Promise<string | undefined> {
    // Read now: the next question may change the provider while this request is out.
    const { provider, model } = this
    if (!model) return undefined
    return writeTitle(provider, model, history, { chat, signal })
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

/** Keep a provider rejection private until we know whether it can be retried before any output appeared. */
async function retryOnOverflow(
  stream: AssistantMessageEventStream,
  retry: () => Promise<AssistantMessageEventStream | undefined>,
): Promise<AssistantMessageEventStream> {
  const events = stream[Symbol.asyncIterator]()
  const first = await events.next()
  if (first.done) return stream
  const next = first.value.type === 'start' ? await events.next() : first
  if (!next.done && next.value.type === 'error' && isContextOverflow(next.value.error)) {
    const retried = await retry()
    if (retried) return retried
  }
  const output = createAssistantMessageEventStream()
  output.push(first.value)
  if (next !== first && !next.done) output.push(next.value)
  void (async () => {
    for (let event = await events.next(); !event.done; event = await events.next()) output.push(event.value)
    output.end(await stream.result())
  })()
  return output
}
