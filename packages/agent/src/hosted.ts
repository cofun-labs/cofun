// Our worker, as the agent uses it: the hosted model's provider, with what the worker accepts of its
// requests, and the worker's web reads and searches as the tools get them. The requests and the
// worker's answers are the worker's client's (@cofun/worker-client); this module puts them in the
// agent's terms. It takes the client by what it uses of it, so the agent depends on no class.
import {
  callCost,
  turnHeaders,
  WorkerError,
  type WebCall,
  type WebPage,
  type WebSearchResult,
} from '@cofun/worker-client'
import { parseError, type ModelProvider } from './provider'
import { ToolError, type WebAccess } from './types'

/** What the hosted model's provider uses of the worker's client (WorkerClient). */
export interface HostedService {
  /** The worker's base URL, including /v1, without a trailing slash. */
  readonly baseUrl: string
  /** The headers a hosted model request carries besides its token. */
  readonly modelHeaders: Record<string, string>
  /** The model the worker serves. */
  model(): Promise<string>
  /** A fresh session token for one request. */
  token(): Promise<string>
}

/** What web reads and searches use of the worker's client (WorkerClient). */
export interface WebService {
  readWebPage(url: string, maxChars: number, render: boolean, call?: WebCall): Promise<WebPage>
  searchWeb(query: string, limit: number, call?: WebCall): Promise<WebSearchResult[]>
}

/** Our worker. It fixes the model, so the agent asks it which one. */
export function hostedProvider(worker: HostedService): ModelProvider {
  return {
    name: 'Cofun',
    async loadModel() {
      const model = await worker.model()
      return {
        id: model,
        name: model,
        api: 'openai-completions',
        provider: 'cofun',
        baseUrl: worker.baseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // Which extension asks, so the worker records the call under its product.
        headers: worker.modelHeaders,
        // The model's own, on Workers AI. pi fits max_tokens into what the input leaves of it.
        contextWindow: 1_048_576,
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
    },
    apiKey: () => worker.token(),
    // No provider attribution headers; the worker is our own.
    identity: { attribution: null },
    parseError,
    // The worker's model changed since the panel looked it up (a deploy).
    modelChanged: (failure) => failure.code === 'unsupported_model',
    callCost,
    turnHeaders,
  }
}

/**
 * The worker's refusal as the tools get it: a request the worker turned away stops the question,
 * and the user is told why. Any other error is thrown as it is.
 */
function asToolError(err: unknown): never {
  if (!(err instanceof WorkerError)) throw err
  throw new ToolError(err.code, err.message, { stopsQuestion: err.turnedAway, charged: err.charged, cause: err })
}

/** The worker's web reads and searches, as the agent gives them to the tools (see AgentConfig.web). */
export function workerWeb(worker: WebService): WebAccess {
  return {
    read: (url, maxChars, render, call) => worker.readWebPage(url, maxChars, render, call).catch(asToolError),
    search: (query, limit, call) => worker.searchWeb(query, limit, call).catch(asToolError),
  }
}
