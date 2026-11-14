// The agent's types, as the rest of the extension uses them: its configuration, the tools it runs,
// what it reports while it works, and the conversation as saved sessions keep it.
import type { ModelSettings, OwnSetup } from '../models'

export interface AgentConfig {
  /** Base URL including /v1. */
  apiUrl: string
  /** Returns a fresh Clerk session token. Called before every request to the worker. */
  getToken: () => Promise<string | null>
  /**
   * Which model answers, read as each question starts, so a change applies from the next question
   * on and the conversation goes on with it. The hosted model when not given.
   */
  model?: () => Promise<ModelSettings>
  systemPrompt: string
  tools: ToolSpec[]
  /** Model calls allowed per question. */
  maxSteps?: number
  /** How much of a long conversation to send. Defaults stay well under the provider's limits. */
  history?: { messages: number; chars: number }
  /**
   * Called as each question starts, to count the requests its tools make to the user's data (to
   * Notion). `ask` puts a yes/no question to the user on the card of the tool that is running, and
   * resolves false when the question is stopped or nobody can be asked.
   */
  meter?: (ask: (question: string) => Promise<boolean>) => QuestionMeter
}

/** What a question's tools sent, read when it ends. */
interface QuestionMeter {
  readonly requests: number
  /** A request that changes the user's data was sent and may have landed. */
  readonly wrote: boolean
}

/**
 * What goes with a question besides what the user typed, all saved with it. `context` is sent to the
 * model ahead of the question (say, which page is open); `pages` are the pages the user sent it with,
 * shown with the question; `readOnly`: the question is asked in Read only, so the model is offered no
 * tool that changes data (`changesData`) for it.
 */
export interface QuestionExtras {
  context?: string
  pages?: QuestionPage[]
  readOnly?: boolean
}

/** A page a question was sent with: its title and URL, and whether it is a database. */
export interface QuestionPage {
  title: string
  url: string
  database?: true
}

/** A tool the model can ask the extension to run. */
export interface ToolSpec {
  name: string
  description: string
  /**
   * JSON Schema of the arguments object. The model is sent it, and the agent runtime checks each
   * call against it before the tool runs (see `toAgentTool` in calls.ts). Define a tool with
   * `defineTool` (src/tool.ts), which derives this from the schema it parses the arguments with.
   */
  parameters: object
  /**
   * Runs the tool. Throw to report a failure to the model. An error with a `stopsQuestion` string
   * (on it or a cause) also stops the question: nothing more runs, and the user is told that string.
   * The arguments come from the model: a tool parses them before it uses them.
   */
  run: (args: unknown, signal?: AbortSignal) => Promise<unknown>
  /** The tool does what is hard to undo, such as deleting a page, so the user must agree each time before it runs. */
  needsConfirmation?: boolean
  /**
   * The tool changes the user's data. When a question stops after such a tool ran and changed
   * something, or may have (its error has `mayHaveChanged`), the user is told to check before
   * asking again, so they don't ask for a change twice. Every successful run counts, even one
   * that changed nothing (an edit of no-ops): over-warning is the safe side.
   */
  changesData?: boolean
  /**
   * What a call does, in words, from the state before it runs: shown on the call's card, and to the
   * user before agreeing when the tool needs confirmation. It may look things up first.
   */
  preview?: (args: unknown) => string | undefined | Promise<string | undefined>
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
}

/** Asks the user whether a tool may run, or what `question` asks; resolves true for yes. */
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
  /**
   * The call passed validation and runs next, or is put to the user first: `args` as the tool gets
   * them (the model's, checked and converted to the schema), and what it changes, when the tool can say.
   */
  | { type: 'tool_ready'; id: string; args: unknown; preview?: string }
  /** `result`: what the model got back, the error message when the tool failed. */
  | { type: 'tool_end'; id: string; name: string; status: ToolStatus; result: string }

/**
 * The conversation as the agent keeps it, in a form of our own, so saved sessions don't depend on
 * the agent runtime. A reply is an assistant message followed by the results of the tools it called;
 * a question may take several such steps before the final answer.
 */
export type HistoryMessage =
  /**
   * `context`, `pages`, and `readOnly`: what went with the question (see QuestionExtras), besides what
   * the user typed.
   */
  | ({ role: 'user'; text: string; context?: string; pages?: QuestionPage[]; readOnly?: true } & QuestionDetails)
  | { role: 'assistant'; parts: AssistantPart[] }
  /** The result of one tool call. `id` matches the call in the assistant message before it. */
  | { role: 'tool'; id: string; name: string; status: ToolStatus; result: string }

/** What the model wrote, in order: text and the tools it asked to run. */
export type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }

/**
 * What a question used, once it ended; each part only when it is known.
 * `requests`: how many requests its tools made (see AgentConfig.meter).
 * `tokens`: what the model used for it, summed over its model calls, as the service reported them.
 * `model`: the model that was asked.
 */
export interface QuestionDetails {
  requests?: number
  tokens?: TokenUsage
  model?: AnsweredBy
}

/** Tokens a question used. `input` counts all of the input, `cached` the part of it read from the service's cache. */
export interface TokenUsage {
  input: number
  output: number
  cached: number
}

/** Which model a question was asked of: the hosted one, or a user's own one on its service, by its name. */
export type AnsweredBy = { service: 'hosted' } | { service: OwnSetup['service']; name: string }

export type AskResult = (
  | { status: 'done' }
  | { status: 'stopped' }
  | { status: 'step_limit'; steps: number }
  /** `code`: the worker's error code when it refused the question, e.g. `out_of_credits`. */
  | { status: 'error'; message: string; code?: string }
) &
  QuestionDetails
