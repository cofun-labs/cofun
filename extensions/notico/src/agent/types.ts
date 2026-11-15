// The agent's types, as the rest of the extension uses them: its configuration, the tools it runs,
// what it reports while it works, and the conversation as saved sessions keep it.
import type { ModelSettings, OwnSetup } from '../models'
import { z } from '../zod'

export interface AgentConfig {
  /** Base URL including /v1. */
  apiUrl: string
  /** Returns a fresh Clerk session token. Called before every request to the worker. */
  getToken: () => Promise<string | null>
  /**
   * The extension and its version, `notico/0.3.0`: sent to the worker with each model request as
   * X-Cofun-Client, which records the call under that product.
   */
  client: string
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
const QuestionPage = z.object({ title: z.string(), url: z.string(), database: z.literal(true).optional() })
export type QuestionPage = z.infer<typeof QuestionPage>

/**
 * What a call that worked says about itself for the side panel, apart from the text the model gets:
 * `name`, the name of the thing its card names (a page's title, say), and the pages and databases it
 * `read` and `changed`, by id (32 hex digits, no dashes). Saved with the call's result.
 */
export const ToolDetails = z.object({
  name: z.string().optional(),
  read: z.array(z.string()).optional(),
  changed: z.array(z.string()).optional(),
})
export type ToolDetails = z.infer<typeof ToolDetails>

/** What a tool returns: the text the model gets, and the details the side panel reads (see ToolDetails). */
export interface ToolResult {
  text: string
  details: ToolDetails
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
   * The arguments come from the model: a tool parses them before it uses them. Text alone is a
   * result with no details. `context` is what the agent gives a running call (see ToolContext).
   */
  run: (args: unknown, signal?: AbortSignal, context?: ToolContext) => Promise<string | ToolResult>
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

/** What the agent gives a call while it runs. */
export interface ToolContext {
  /** Puts a question to the user on the call's card (see AskOnCard). */
  ask: AskOnCard
  /**
   * What the user typed in each question of the conversation, oldest first: their own words only,
   * without the notes the extension sends with them, and nothing a tool or the model wrote.
   */
  userText: () => string[]
  /**
   * Reads the web page at `url` through the worker, up to `maxChars` of its text; `render` renders
   * it in a browser first, for a page drawn by scripts. Throws a WebError
   * when the worker could not read it.
   */
  readWeb: (url: string, maxChars: number, render: boolean, signal?: AbortSignal) => Promise<WebPage>
}

/** A web page the worker read (see ToolContext.readWeb). `scripted`: it showed little text and runs scripts. */
export const WebPage = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string(),
  chars: z.number().int().nonnegative(),
  scripted: z.boolean(),
})
export type WebPage = z.infer<typeof WebPage>

/** Why the worker could not read a web page: its code (`no_access`, `no_text`, …) and message. */
export class WebError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Set when the question must stop (the worker's rate limit): what the user is told. */
    readonly stopsQuestion?: string,
  ) {
    super(message)
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

/** Asks the user whether a tool may run, or what `question` asks; resolves true for yes. */
export type ConfirmTool = (call: ToolCallRequest) => Promise<boolean>

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
   * the error the tool failed with, when it has one (a Notion error's, such as `no_access`).
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
const OwnService = z.enum(['openrouter'])
/** True when A and B are the same set of values. */
type Same<A, B> = [A, B] extends [B, A] ? true : false
// The same services as OwnSetup, both ways: one missing here would make every session it answered unreadable.
true satisfies Same<z.infer<typeof OwnService>, OwnSetup['service']>
const AnsweredBy = z.union([
  z.object({ service: z.literal('hosted') }),
  z.object({ service: OwnService, name: z.string() }),
])
export type AnsweredBy = z.infer<typeof AnsweredBy>

/**
 * What a question cost on the hosted model, summed over its model calls as the worker charged them,
 * in micro-credits (a credit is 1,000,000). Exact: only a question that ended normally has one.
 */
const QuestionCost = z.object({ microCredits: z.number().int().nonnegative() })
export type QuestionCost = z.infer<typeof QuestionCost>

/**
 * What a question used, once it ended; each part only when it is known.
 * `requests`: how many requests its tools made (see AgentConfig.meter).
 * `tokens`: what the model used for it, summed over its model calls, as the service reported them.
 * `model`: the model that was asked.
 * `cost`: what it cost in credits, on the hosted model only (a user's own model spends none), and
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
   * `context`, `pages`, and `readOnly`: what went with the question (see QuestionExtras), besides what
   * the user typed.
   */
  QuestionDetails.extend({
    role: z.literal('user'),
    text: z.string(),
    context: z.string().optional(),
    pages: z.array(QuestionPage).optional(),
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

export type AskResult = (
  | { status: 'done' }
  | { status: 'stopped' }
  | { status: 'step_limit'; steps: number }
  /** `code`: the worker's error code when it refused the question, e.g. `out_of_credits`. */
  | { status: 'error'; message: string; code?: string }
) &
  QuestionDetails & {
    /** How many times the model was called for the question: 0 when it never got that far. */
    rounds: number
    /**
     * The conversation the question was asked in, as it stands now that the question is part of it,
     * to save: still that conversation when reset() started another one meanwhile. Not set when the
     * question left the conversation as it was (it failed or was stopped before it used a tool).
     */
    conversation?: HistoryMessage[]
  }
