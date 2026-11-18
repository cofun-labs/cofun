// Our worker, as the agent uses it: the hosted model's provider, and the worker's web reads and
// searches as the tools get them. The requests and the worker's answers are the worker's client's
// (@cofun/worker-client); this module puts them in the agent's terms.
import { callCost, turnHeaders, WorkerError, type WebCall, type WorkerClient } from '@cofun/worker-client'
import { HOSTED_HISTORY, parseError, type ModelProvider } from './provider'
import { WebError, type WebPage, type WebSearchResult } from './types'

/** Our worker. It fixes the model, so the agent asks it which one. */
export function hostedProvider(worker: WorkerClient): ModelProvider {
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
    apiKey: worker.token,
    history: HOSTED_HISTORY,
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
function asWebError(err: unknown): never {
  if (!(err instanceof WorkerError)) throw err
  throw new WebError(err.code, err.message, { stopsQuestion: err.turnedAway, charged: err.charged, cause: err })
}

/** Has the worker read the web page at `url`, rendered when `render` is set (see ToolContext.readWeb). */
export function readWebPage(
  worker: WorkerClient,
  url: string,
  maxChars: number,
  render: boolean,
  call: WebCall,
): Promise<WebPage> {
  return worker.readWebPage(url, maxChars, render, call).catch(asWebError)
}

/** Has the worker search the web for `query`, for at most `limit` results (see ToolContext.searchWeb). */
export function searchWebFor(
  worker: WorkerClient,
  query: string,
  limit: number,
  call: WebCall,
): Promise<WebSearchResult[]> {
  return worker.searchWeb(query, limit, call).catch(asWebError)
}
