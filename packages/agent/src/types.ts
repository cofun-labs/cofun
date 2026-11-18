// The agent's types, as an extension uses them: its configuration, the tools it runs, what it
// reports while it works, and the conversation as saved sessions keep it.
import type { Turn, WebCall, WebPage, WebSearchResult } from '@cofun/worker-client'
import { OwnService, type OwnSetup } from './own'
import type { ModelProvider } from './provider'
import { z } from './zod'

/**
 * What an agent is made with. `M` is the extension's own memory of a conversation, which its tools
 * get as `ToolContext.memory` (see CopilotAgent).
 */
export interface AgentConfig<M = unknown> {
  /** The extension's name as its users know it, `Notico`: in the notes to the model and in what the user is told. */
  product: string
  /** What the tools that change data change, as the notes to the model name it: `Notion`, `site data`. */
  data: string
  /** The hosted model (see hostedProvider): it answers unless `model` names the user's own. */
  hosted: ModelProvider
  /**
   * The user's own model that answers, read as each question starts, so a change applies from the
   * next question on and the conversation goes on with it; undefined for the hosted model.
   */
  model?: () => Promise<OwnSetup | undefined>
  /** Where the tools read web pages and search the web, whichever model answers (see workerWeb). */
  web: WebAccess
  systemPrompt: string
  tools: ToolSpec<M>[]
  /** Model calls allowed per question. */
  maxSteps?: number
  /**
   * Where long tool results are kept on the device (see KeptResult): the saved sessions' store.
   * Without it, a long result is clipped.
   */
  results?: ResultStore
  /** How much of a long conversation to send. Defaults stay well under the provider's limits. */
  history?: { messages: number; chars: number }
  /**
   * Called as each question starts, to count the requests its tools make to the user's data (to
   * the site). `ask` puts a yes/no question to the user on the card of the tool that is running, and
   * resolves false when the question is stopped or nobody can be asked.
   */
  meter?: (ask: (question: string) => Promise<boolean>) => QuestionMeter
}

/**
 * Reads web pages and searches the web for the tools (see ToolContext.readWeb and searchWeb), for
 * the question `call` names. Throws a ToolError when it could not, which stops the question only
 * when it carries `stopsQuestion`.
 */
export interface WebAccess {
  read(url: string, maxChars: number, render: boolean, call: WebCall): Promise<WebPage>
  search(query: string, limit: number, call: WebCall): Promise<WebSearchResult[]>
}

/** What a question's tools sent, read when it ends. */
interface QuestionMeter {
  readonly requests: number
  /** A request that changes the user's data was sent and may have landed. */
  readonly wrote: boolean
}

/**
 * What goes with a question besides what the user typed, all saved with it but `chat`. `context` is
 * sent to the model ahead of the question (say, which page is open); `pages` are the pages the user
 * sent it with, shown with the question; `selections`, text the user selected on pages and sent it
 * with, shown with it too (what the model gets of it is in `context`); `readOnly`: the question is
 * asked in Read only, so tools marked `changesData` are refused before they run. `chat`, the id of
 * the session it is asked in, goes to the worker with the question's requests (see Turn).
 */
export interface QuestionExtras {
  context?: string
  pages?: QuestionPage[]
  selections?: QuestionSelection[]
  readOnly?: boolean
  chat?: string
}

/**
 * The worker's client's: which chat and question a request to the worker is for (Turn, never sent to
 * a user's own model's service), a web read or search as WebAccess gets it, and a web page it read
 * and a search result it found.
 */
export type { Turn, WebCall, WebPage, WebSearchResult }

/**
 * A page a question was sent with: its title and URL; for a page on another site than the
 * extension's own (`web`), the tab the user added (`tab`, Chrome's id for it, in the browser's run
 * `run`). Other fields an extension gives a page (Notico's `database`) are kept as they are, for the
 * extension to read with a schema of its own.
 */
const QuestionPageFields = z.object({
  title: z.string(),
  url: z.string(),
  web: z.literal(true).optional(),
  tab: z.number().int().optional(),
  run: z.string().optional(),
})
export const QuestionPage = QuestionPageFields.loose()
/** The fields the agent reads; other fields, kept as they are, are the extension's to read. */
export type QuestionPage = z.infer<typeof QuestionPageFields>

/**
 * Text a question was sent with, selected on a page, as the question shows it: the page's title, its
 * URL (with a text fragment that finds the selection, on a web page), and the start of the text.
 */
const QuestionSelection = z.object({ title: z.string(), url: z.string(), quote: z.string() })
export type QuestionSelection = z.infer<typeof QuestionSelection>

/**
 * What a call that worked says about itself for the side panel, apart from the text the model gets:
 * `name`, the name of the thing its card names (a page's title, say), and the pages it
 * `read` and `changed`, by id; and `result`, the id of the result it kept
 * on the device when it was long (see KeptResult), which the conversation names it by. Saved with
 * the call's result.
 */
export const ToolDetails = z.object({
  name: z.string().optional(),
  read: z.array(z.string()).optional(),
  changed: z.array(z.string()).optional(),
  result: z.string().optional(),
})
export type ToolDetails = z.infer<typeof ToolDetails>

/** What a tool returns: the text the model gets, and the details the side panel reads (see ToolDetails). */
export interface ToolResult {
  text: string
  details: ToolDetails
  /** A change tool can verify that its successful call made no change. */
  changed?: boolean
}

/** A tool the model can ask the extension to run; `M` is the extension's memory (see ToolContext). */
export interface ToolSpec<M = unknown> {
  name: string
  description: string
  /**
   * JSON Schema of the arguments object. The model is sent it, and the agent runtime checks each
   * call against it before the tool runs (see `toAgentTool` in calls.ts). Define a tool with
   * `defineTool` (tool.ts), which derives this from the schema it parses the arguments with.
   */
  parameters: object
  /**
   * Runs the tool. Throw to report a failure to the model. An error with a `stopsQuestion` string
   * (on it or a cause) also stops the question: nothing more runs, and the user is told that string.
   * The arguments come from the model: a tool parses them before it uses them. Text alone is a
   * result with no details. `context` is what the agent gives a running call (see ToolContext).
   */
  run: (args: unknown, signal: AbortSignal | undefined, context: ToolContext<M>) => Promise<string | ToolResult>
  /**
   * The tool does what is hard to undo, such as deleting a page, so the user must agree each time
   * before it runs; a function says so for the call about to run, from its context.
   */
  needsConfirmation?: boolean | ((context: ToolContext<M>) => boolean)
  /**
   * The tool changes the user's data. When a question stops after such a tool ran and changed
   * something, or may have (its error has `mayHaveChanged`), the user is told to check before
   * asking again, so they don't ask for a change twice. Every successful run counts, even one
   * that changed nothing (an edit of no-ops), unless its result says `changed: false`: over-warning
   * is the safe side.
   */
  changesData?: boolean
  /**
   * What a call does, in words, from the state before it runs: shown on the call's card, and to the
   * user before agreeing when the tool needs confirmation. It may look things up first. `context` is
   * the one the call will run with; `signal` aborts its lookups when the question stops.
   */
  preview?: (
    args: unknown,
    context: ToolContext<M>,
    signal?: AbortSignal,
  ) => string | undefined | Promise<string | undefined>
}

/**
 * A question a running tool puts to the user on its card. `access`: an origin (`https://example.com`)
 * the tool asks to read; the card offers to allow it, and its yes is the browser granting it, which
 * only a click in the side panel can ask for.
 */
interface CardQuestion {
  text: string
  access?: string
}

/**
 * Puts a question to the user on the card of the call that asks it; resolves true for yes, and false
 * when the question is stopped or nobody can be asked.
 */
export type AskOnCard = (question: CardQuestion) => Promise<boolean>

/** What the agent gives a call while it runs; `memory` is the extension's own (`M`). */
export interface ToolContext<M = unknown> {
  /** The current question as the user typed it, without notes or text returned by tools. */
  userText: string
  /** Puts a question to the user on the call's card (see AskOnCard). */
  ask: AskOnCard
  /**
   * Reads the web page at `url` (see AgentConfig.web), up to `maxChars` of its text; `render`
   * renders it in a browser first, for a page drawn by scripts. Throws a ToolError when it could not
   * be read, which stops the question only when it carries `stopsQuestion`.
   */
  readWeb: (url: string, maxChars: number, render: boolean, signal?: AbortSignal) => Promise<WebPage>
  /**
   * Searches the web for `query` (see AgentConfig.web), for at most `limit` results. Throws a
   * ToolError when the search failed, which stops the question only when it carries `stopsQuestion`.
   */
  searchWeb: (query: string, limit: number, signal?: AbortSignal) => Promise<WebSearchResult[]>
  /**
   * Keeps a long result on the device and resolves with its id; rejects when there is no store or
   * it can't be written.
   */
  keep: (result: ResultToKeep) => Promise<string>
  /**
   * A kept result by its id, only when the conversation's tool results name it (see
   * ToolDetails.result): `'unknown'` when they don't, `'gone'` when they do but it is not kept any
   * more (site data cleared).
   */
  kept: (id: string) => Promise<KeptResult | 'unknown' | 'gone'>
  /**
   * What the tools remember of the conversation (the extension's own): the agent's, the same for
   * every call it runs, so the pages one chat read never count as read in another.
   */
  memory: M
}

/**
 * The full text of a long tool result, kept on the device for a while (the extension's session
 * store), so the model can read the parts it was not given (read_result, search_result). `tool` is
 * the tool that read it; `title` and `url`, the page's; `markdown`, whether `text` is the
 * extension's own Markdown, as the result labels it; `chars`, how long the whole text was,
 * which is more than `text` when only the first part of it was kept; `keptAt`, when it was kept,
 * which is what it is swept by.
 */
export const KeptResult = z.object({
  id: z.string(),
  tool: z.string(),
  title: z.string(),
  url: z.string(),
  markdown: z.boolean(),
  text: z.string(),
  chars: z.number().int().nonnegative(),
  keptAt: z.number(),
})
export type KeptResult = z.infer<typeof KeptResult>

/** What a tool gives to keep (see KeptResult). */
export type ResultToKeep = Pick<KeptResult, 'tool' | 'title' | 'url' | 'markdown' | 'text' | 'chars'>

/** Where long results are kept: the saved sessions' store. */
interface ResultStore {
  keep(result: ResultToKeep): Promise<string>
  /** `undefined` when it is gone or can't be read. */
  result(id: string): Promise<KeptResult | undefined>
}

/**
 * A tool's error that the agent reads (see `toAgentTool` in calls.ts): its code (`no_access`,
 * `rate_limited`, …) and message, which the model gets. Any error may carry these fields, on it or
 * on a cause; this class is the one way to make one with them.
 */
export class ToolError extends Error {
  /** Set when the question must stop (a rate limit, no credits left): what the user is told. */
  readonly stopsQuestion?: string
  /** Set when the call may have changed the user's data although it failed: the user is told to check. */
  readonly mayHaveChanged?: true
  /** Set when the call was or may have been charged (a render, a search), so the model is told not to repeat it. */
  readonly charged: boolean

  constructor(
    readonly code: string,
    message: string,
    {
      stopsQuestion,
      mayHaveChanged,
      charged = false,
      cause,
    }: { stopsQuestion?: string; mayHaveChanged?: boolean; charged?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause })
    if (stopsQuestion) this.stopsQuestion = stopsQuestion
    if (mayHaveChanged) this.mayHaveChanged = true
    this.charged = charged
  }
}

/** A tool call waiting for the user's OK. */
export interface ToolCallRequest {
  id: string
  name: string
  args: unknown
  /** What the call would change, in words, when the tool can say. */
  preview?: string
  /**
   * Set when the call is already running and asks the user this instead, such as whether to go on
   * at the question's request budget; resolves true for yes.
   */
  question?: string
  /** With `question`: the origin the call asks to read (see CardQuestion). */
  access?: string
}

/** A prompt can fail locally, for example when Chrome cannot request site access. */
export type ConfirmationAnswer = boolean | Error

/** Asks whether a tool may run; resolves with the answer or a failure of the prompt. */
export type ConfirmTool = (call: ToolCallRequest) => Promise<ConfirmationAnswer>

/**
 * How a tool call ended. `skipped`: refused without running, because the question reached its step
 * limit. `stopped`: the user stopped the question while the tool ran or waited for their OK.
 * `declined`: the user did not let it run.
 */
const ToolStatus = z.enum(['done', 'failed', 'skipped', 'stopped', 'declined'])
export type ToolStatus = z.infer<typeof ToolStatus>

/** What the side panel shows while the agent works on a question. */
export type AgentUpdate =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  /**
   * The call passed validation and runs next, or is put to the user first: `args` as the tool gets
   * them (the model's, checked and converted to the schema), and what it changes, when the tool can say.
   */
  | { type: 'tool_ready'; id: string; args: unknown; preview?: string }
  /**
   * `result`: what the model got back, the error message when the tool failed. `code`: the code of
   * the error the tool failed with, when it has one (such as `no_access`).
   * `details`: what the tool said about the call, when it worked and said anything (see ToolDetails).
   */
  | {
      type: 'tool_end'
      id: string
      name: string
      status: ToolStatus
      result: string
      code?: string
      details?: ToolDetails
    }

/** Tokens a question used. `input` counts all of the input, `cached` the part of it read from the service's cache. */
const TokenUsage = z.object({ input: z.number(), output: z.number(), cached: z.number() })
export type TokenUsage = z.infer<typeof TokenUsage>

/** Which model a question was asked of: the hosted one, or a user's own one on its service, by its name. */
const AnsweredBy = z.union([
  z.object({ service: z.literal('hosted') }),
  z.object({ service: OwnService, name: z.string() }),
])
export type AnsweredBy = z.infer<typeof AnsweredBy>

/**
 * What a question cost, in micro-credits (a credit is 1,000,000): `microCredits` in all, the hosted
 * model's calls as the worker charged them and the renders and searches made for it; and of that,
 * `renders` and `searches`, when there were any. Exact: only a question that ended normally has one.
 * A question asked before the split was kept has the sum only.
 */
const MicroCredits = z.number().int().nonnegative()
const QuestionCost = z.object({
  microCredits: MicroCredits,
  renders: MicroCredits.optional(),
  searches: MicroCredits.optional(),
})
/** What a call to the worker other than the model's spent credits on (see QuestionCost). */
export type WebCost = 'renders' | 'searches'
export type QuestionCost = z.infer<typeof QuestionCost>

/**
 * What a question used, once it ended; each part only when it is known.
 * `requests`: how many requests its tools made (see AgentConfig.meter).
 * `tokens`: what the model used for it, summed over its model calls, as the service reported them.
 * `model`: the model that was asked.
 * `cost`: what it cost in credits: the hosted model's calls and the pages rendered for it (a user's own
 * model spends none on its calls), and
 * only when it ended normally: a question stopped or failed has none (see `ask` in agent.ts).
 */
const QuestionDetails = z.object({
  requests: z.number().optional(),
  tokens: TokenUsage.optional(),
  model: AnsweredBy.optional(),
  cost: QuestionCost.optional(),
})
export type QuestionDetails = z.infer<typeof QuestionDetails>

/** A JSON value; arrays are read-only, as the agent runtime hands them over. */
type Json = string | number | boolean | null | readonly Json[] | { [key: string]: Json }
const Json: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(Json).readonly(), z.record(z.string(), Json)]),
)
const JsonObject = z.record(z.string(), Json)

/**
 * What the model wrote, in order: text and the tools it asked to run. A call's `args` are what the
 * model sent, a JSON object, whatever the tool; the tool parses them when it runs.
 */
const AssistantPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), id: z.string(), name: z.string(), args: JsonObject }),
])
export type AssistantPart = z.infer<typeof AssistantPart>

/**
 * The conversation as the agent keeps it, in a form of our own, so saved sessions don't depend on
 * the agent runtime. A reply is an assistant message followed by the results of the tools it called;
 * a question may take several such steps before the final answer. Saved sessions are read back
 * through this schema, so one an earlier version saved in another form is refused, not misread.
 */
export const HistoryMessage = z.discriminatedUnion('role', [
  /**
   * `context`, `pages`, `selections`, and `readOnly`: what went with the question (see QuestionExtras), besides what
   * the user typed. `turn`: the id its requests to the worker carried (see Turn), to match the question
   * to what they spent; a question asked before ids were sent has none.
   */
  QuestionDetails.extend({
    role: z.literal('user'),
    text: z.string(),
    turn: z.string().optional(),
    context: z.string().optional(),
    pages: z.array(QuestionPage).optional(),
    selections: z.array(QuestionSelection).optional(),
    readOnly: z.literal(true).optional(),
  }),
  z.object({ role: z.literal('assistant'), parts: z.array(AssistantPart) }),
  /**
   * The result of one tool call. `id` matches the call in the assistant message before it.
   * `details`: what the tool said about the call for the side panel (see ToolDetails).
   */
  z.object({
    role: z.literal('tool'),
    id: z.string(),
    name: z.string(),
    status: ToolStatus,
    result: z.string(),
    details: ToolDetails.optional(),
  }),
])
export type HistoryMessage = z.infer<typeof HistoryMessage>

/** The summary of messages before firstKept in the saved HistoryMessage array. */
export const Compaction = z.object({
  firstKept: z.int().positive(),
  summary: z.string().trim().min(1).max(4000),
})
export type Compaction = z.infer<typeof Compaction>

export type AskResult = (
  | { status: 'done' }
  | { status: 'stopped'; warning?: string }
  | { status: 'step_limit'; steps: number }
  /** `code`: the worker's error code when it refused the question, e.g. `out_of_credits`. */
  | { status: 'error'; message: string; code?: string }
) &
  QuestionDetails & {
    /** How many times the model was called for the question: 0 when it never got that far. */
    rounds: number
    /**
     * The conversation the question was asked in, as it stands now that the question is part of it,
     * to save. Not set when the
     * question left the conversation as it was (it failed or was stopped before it used a tool).
     */
    conversation?: HistoryMessage[]
    compaction?: Compaction
  }
