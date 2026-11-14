// Where the agent's model requests go (see ModelProvider), and what is the same for every service:
// how much of a conversation to send, and how a failed request's error reads.
import type { ClientIdentity, Model } from '@earendil-works/pi-ai'
import { z } from '../zod'

/**
 * Where the agent's model requests go, and what is particular to the service behind them: which
 * model to name, how each request is authenticated, how its errors read, and its size limits. The
 * agent loop itself knows none of this.
 */
export interface ModelProvider {
  /** The service, as the user knows it. */
  name: string
  /** The model requests name. Looked up as a conversation starts, and again when `modelChanged`. */
  loadModel(): Promise<Model<'openai-completions'>>
  /** The key for one model request. Throws, with what the user should do, when there is none. */
  apiKey(): Promise<string>
  /** How much of a long conversation to send, unless AgentConfig.history says otherwise. */
  history: { messages: number; chars: number }
  /** What pi tells the service about the client. */
  identity: ClientIdentity
  /** A failed model request's error, in the service's own words when it gives them. */
  parseError(message: string | undefined): Failure
  /** The request failed because the model it named is no longer served: look it up again. */
  modelChanged(failure: Failure): boolean
  /**
   * What a model call cost in credits, when this chunk of its stream says (see `callCost` in
   * worker.ts). Only the hosted provider has it: a user's own model spends no credits.
   */
  callCost?(chunk: unknown): CallCost | undefined
}

/** What one model call cost, as the worker charged it: in micro-credits, and whether from estimated tokens. */
export interface CallCost {
  microCredits: number
  estimated: boolean
}

// The worker allows 200 messages and 200,000 characters, tools included.
export const HOSTED_HISTORY = { messages: 100, chars: 150_000 }

/**
 * How much of a long conversation to send to a model the user pays for: what the hosted provider
 * sends, at most. Every round trip resends the history, so a model with a huge context must not make
 * each question cost dollars. A smaller context lowers it (a token is about four characters: half the
 * context, which leaves room for the reply).
 */
export const ownHistory = (contextLength: number) => ({
  messages: 100,
  chars: Math.min(contextLength * 2, HOSTED_HISTORY.chars),
})

// What the worker answers, as far as the agent reads it. Each field is read loosely: one that is not
// text counts as missing, so a reply the agent can't read ends in the fallback, never in a wrong value.
export const looseText = z.string().optional().catch(undefined)

/** An error as the worker words it. */
const ErrorFields = z.object({ code: looseText, message: looseText })
/** The body of a failed request: the error itself, or wrapped in `error`. */
const ErrorBody = ErrorFields.extend({ error: z.unknown().optional() })

/**
 * The worker's own error message and code when there are any. The SDK reports HTTP errors as
 * `<status>: <body>` or `<status> <message>`, and the worker's body is `{ error: { code, message } }`
 * (sometimes already unwrapped to `{ code, message }`).
 */
export function parseError(message: string | undefined): Failure {
  if (!message) return { text: 'The model failed.' }
  const rest = message.replace(/^\d{3}:?\s+/, '')
  let json: unknown
  try {
    json = JSON.parse(rest)
  } catch {
    return { text: rest }
  }
  const body = ErrorBody.safeParse(json).data
  const inner = body?.error === undefined || body.error === null ? body : ErrorFields.safeParse(body.error).data
  return inner?.message ? { text: inner.message, code: inner.code } : { text: rest }
}

export interface Failure {
  text: string
  /** The service's error code, e.g. the worker's `unsupported_model`. */
  code?: string
}
