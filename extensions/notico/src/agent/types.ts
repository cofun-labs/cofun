// Context supplied by Notico to its tools, and the records its session store keeps for long results.
import type { AgentConfig as BaseAgentConfig, AskOnCard, ToolSpec as BaseToolSpec } from '@cofun/base/agent'
import { z } from '@cofun/base/zod'
import type { ModelSettings } from '../models'

export type AgentConfig = Omit<
  BaseAgentConfig<ToolContext>,
  'model' | 'toolContext' | 'readOnlyNotes' | 'modelUpdatedMessage'
> & {
  model?: () => Promise<ModelSettings>
  results?: ResultStore
}
export type ToolSpec = BaseToolSpec<ToolContext>

export type {
  AgentUpdate,
  AskOnCard,
  ConfirmTool,
  QuestionDetails,
  QuestionExtras,
  QuestionPage,
  QuestionSelection,
  ToolCallRequest,
  ToolResult,
} from '@cofun/base/agent'
export { HistoryMessage, ToolDetails, WebError } from '@cofun/base/agent'

/** What the agent gives a call while it runs. */
export interface ToolContext {
  /** Puts a question to the user on the call's card (see AskOnCard). */
  ask: AskOnCard
  /**
   * Reads the web page at `url` through the worker, up to `maxChars` of its text; `render` renders
   * it in a browser first, for a page drawn by scripts. Throws a WebError
   * when the worker could not read it, which stops the question only when it carries `stopsQuestion`.
   */
  readWeb: (url: string, maxChars: number, render: boolean, signal?: AbortSignal) => Promise<WebPage>
  /**
   * Searches the web for `query` through the worker, for at most `limit` results. Throws a WebError
   * when the search failed, which stops the question only when it carries `stopsQuestion`.
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
  /** How many characters the question being answered holds in tool results so far. */
  questionChars: () => number
}

/**
 * The full text of a long tool result, kept on the device for a while (src/sessions.ts), so the
 * model can read the parts it was not given (read_result, search_result). `tool` is the tool that
 * read it; `title` and `url`, the page's; `markdown`, whether `text` is the extension's own
 * Markdown (src/web/markdown.ts), as the result labels it; `chars`, how long the whole text was,
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

/** Where long results are kept: the saved sessions' store (src/sessions.ts). */
interface ResultStore {
  keep(result: ResultToKeep): Promise<string>
  /** `undefined` when it is gone or can't be read. */
  result(id: string): Promise<KeptResult | undefined>
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

/** A result of a web search the worker made (see ToolContext.searchWeb): a page's address, title, and description. */
export const WebSearchResult = z.object({ url: z.string(), title: z.string(), description: z.string() })
export type WebSearchResult = z.infer<typeof WebSearchResult>
