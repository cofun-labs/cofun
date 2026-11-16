// Model provider contract and helpers for reading failures reported by the OpenAI-compatible SDK.
import type { ClientIdentity, Model } from '@earendil-works/pi-ai'
import { z } from '../zod'

/**
 * Which chat (the session's id) and which question of it (an id made for the question) a request to
 * the worker is for, sent as X-Cofun-Chat-Id and X-Cofun-Turn-Id, so the worker records what the
 * request spent with them. Random ids: they say nothing about the content. Never sent to a user's own
 * model's service.
 */
export interface Turn {
  chat?: string
  turn?: string
}

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
   * worker.ts). Only the hosted provider has it: a user's own model spends no credits on its calls.
   */
  callCost?(chunk: unknown): CallCost | undefined
  /**
   * The headers that tell the service which chat and question a model request is for (see Turn).
   * Only the hosted provider has it: a user's own model's service is never told.
   */
  turnHeaders?(turn: Turn): Record<string, string>
}

/** What one model call cost, as the worker charged it: in micro-credits, and whether from estimated tokens. */
export interface CallCost {
  microCredits: number
  estimated: boolean
}

// The worker allows 200 messages and 200,000 characters, tools included.
export const HOSTED_HISTORY = { messages: 100, chars: 150_000 }

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
