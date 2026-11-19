import * as z from './zod'

/** The slice of a Workers Analytics Engine dataset binding the usage records use. */
export interface UsageDataset {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void
}

/**
 * One chat request, described by size and outcome only. Never add message or reply text,
 * the system prompt, IP addresses, or raw request or response bodies.
 */
export interface UsageRecord {
  /** Clerk user id (pseudonymous). */
  userId: string
  /** The product the request came from: see `productOf` in charge.ts. */
  product: string
  /** The chat and question the request was for (see `turnOf` in charge.ts), or empty when it named none. */
  chatId: string
  turnId: string
  model: string
  stream: boolean
  /**
   * `ok`, `incomplete`, `cancelled`, `abandoned` (the client fell behind, see MAX_QUEUED_BYTES),
   * `stream_error`, or the error code returned to the client.
   */
  outcome: string
  messages: number
  inputChars: number
  promptTokens: number
  /** The part of `promptTokens` the model read from its prompt cache. */
  cachedTokens: number
  completionTokens: number
  /** What the user was charged for the request, in micro-credits. 0 when nothing was charged. */
  microCredits: number
  /** `stop`, `length`, `content_filter`, `tool_calls`, `other`, or empty when unknown. */
  finishReason: string
  /**
   * From the start of the request until it was refused, the reply was sent, or a stream ended:
   * when the model's stream ended, or the client cancelled before.
   */
  durationMs: number
}

const FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_calls'])

/** Keeps only known finish reasons, so nothing the model wrote can reach a record. */
export function finishReason(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  return typeof value === 'string' && FINISH_REASONS.has(value) ? value : 'other'
}

/** A token count from the model, or 0 when missing or malformed. */
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/**
 * What a reply from the model, or one chunk of a streamed reply, says about itself. Only these
 * fields are read, loosely: a field that is not what is expected counts as missing, and anything
 * else in the reply is passed on unread.
 */
const Choice = z.object({ finish_reason: z.unknown().optional(), delta: z.unknown().optional() }).catch({})

const Usage = z.object({
  prompt_tokens: z.unknown().optional(),
  completion_tokens: z.unknown().optional(),
  // Workers AI reports the cached part of the prompt here, as OpenAI does.
  prompt_tokens_details: z.object({ cached_tokens: z.unknown().optional() }).optional().catch(undefined),
})

const ReplyInfo = z.object({
  error: z.unknown().optional(),
  usage: Usage.optional().catch(undefined),
  // The first choice, as `choices[0]` reads it: from a list, or from an object with a field named 0.
  choices: z.union([z.array(Choice), z.record(z.string(), Choice)]).catch([]),
})

/**
 * The fields of a reply or chunk that usage records read: its error, its token usage, and its first
 * choice's finish reason. Undefined when it is not an object.
 */
export function replyInfo(value: unknown) {
  const parsed = ReplyInfo.safeParse(value)
  if (!parsed.success) return undefined
  const { error, usage, choices } = parsed.data
  const first = Array.isArray(choices) ? choices[0] : choices['0']
  return { error, usage, finish_reason: first?.finish_reason, delta: first?.delta }
}

/** The token counts a reply or chunk reports, 0 for each one it does not. The cached part is never more than the prompt. */
export function tokensOf(usage: z.output<typeof Usage> | undefined) {
  const promptTokens = tokenCount(usage?.prompt_tokens)
  return {
    promptTokens,
    cachedTokens: Math.min(tokenCount(usage?.prompt_tokens_details?.cached_tokens), promptTokens),
    completionTokens: tokenCount(usage?.completion_tokens),
  }
}

/** A piece of a streamed reply, as far as its size goes: the text, the reasoning, and the tool calls it adds. */
const Piece = z.string().optional().catch(undefined)
const Delta = z.object({
  content: Piece,
  reasoning_content: Piece,
  tool_calls: z
    .array(z.object({ function: z.object({ name: Piece, arguments: Piece }).optional().catch(undefined) }).catch({}))
    .optional()
    .catch(undefined),
})

/** How many characters a streamed chunk adds to the reply. Only the count is kept, never the text. */
function deltaChars(value: unknown): number {
  const delta = Delta.safeParse(value).data
  if (!delta) return 0
  const calls = delta.tool_calls ?? []
  return [
    delta.content,
    delta.reasoning_content,
    ...calls.flatMap((call) => [call.function?.name, call.function?.arguments]),
  ]
    .map((piece) => piece?.length ?? 0)
    .reduce((sum, n) => sum + n, 0)
}

/**
 * Writes one record. The column layout is what SQL queries rely on; append new columns, never reorder:
 *
 * - index1: user id
 * - blob1: model, blob2: outcome, blob3: finish reason, blob4: `stream` or `sync`,
 *   blob5: product (`notico`, another extension's name, or `unknown`), blob6: chat id, blob7: turn
 *   id (each empty when the request named none)
 * - double1: messages, double2: input characters, double3: prompt tokens,
 *   double4: completion tokens, double5: duration in ms, double6: cached prompt tokens,
 *   double7: micro-credits charged
 *
 * Analytics Engine adds the timestamp itself.
 */
export function recordUsage(dataset: UsageDataset, r: UsageRecord): void {
  try {
    dataset.writeDataPoint({
      indexes: [r.userId],
      blobs: [r.model, r.outcome, r.finishReason, r.stream ? 'stream' : 'sync', r.product, r.chatId, r.turnId],
      doubles: [
        r.messages,
        r.inputChars,
        r.promptTokens,
        r.completionTokens,
        r.durationMs,
        r.cachedTokens,
        r.microCredits,
      ],
    })
  } catch (err) {
    // A lost usage record must never fail the user's request.
    console.error('usage record failed', err)
  }
}

/** What the final chunks of an OpenAI-style stream say about the reply. */
export interface StreamSummary {
  promptTokens: number
  cachedTokens: number
  completionTokens: number
  finishReason: string
  /** Characters of reply the stream carried: what a cut-short reply's tokens are estimated from. */
  replyChars: number
  /** Whether the stream said it was done (`data: [DONE]`): its totals, if it sends any, have arrived. */
  ended: boolean
}

/**
 * How much of a streamed reply the worker holds for a client that has not read it yet. The model's
 * stream is read as fast as the model writes it, whether or not the client reads, so the call is
 * charged when the model is done, not when the client is. A reader keeping up holds a few chunks at
 * most; this is a couple of thousand tokens of the model's stream (it repeats its usage on each
 * chunk), tens of seconds of its writing. A client that falls this far behind has stopped reading:
 * nothing more is queued for it, the model's stream is read on to the end, so the call is charged by
 * the totals the model reports, and the client's stream then ends in an error, since what it got has
 * a gap. Its stream stays open until then: a request whose client is gone has only moments left to
 * run. What is held lives in the isolate's memory, which the requests of many users share (128 MB),
 * so it is kept small: two dozen clients that stopped reading in one isolate hold a tenth of it.
 */
export const MAX_QUEUED_BYTES = 512 * 1024

/**
 * Passes an OpenAI-style SSE stream through, line by line, while reading the token usage and finish
 * reason from it. The source is read as fast as it comes, not as fast as the client reads: what the
 * client has not read yet waits in the returned stream's queue, up to MAX_QUEUED_BYTES. So the
 * client can never put off when the call ends, and when it is charged.
 *
 * Calls `done` once, when the stream ends, fails, or is cancelled, and waits for it before the
 * returned stream ends, so a reader that saw the end knows it has run. A stream that ends without
 * `data: [DONE]` was cut short and is reported as `incomplete`; one that carried an error event is
 * reported as `provider_error`, like a failed non-streamed call. A client that falls more than
 * MAX_QUEUED_BYTES behind is sent nothing more, and the source read on to its end: the call ends as
 * the source does, `abandoned` when it reached `[DONE]`. The worker sets no deadline of its own: a
 * stream ends when the model ends it, or when the client cancels.
 *
 * `last` gives the fields of one more chunk, written for the client as the last before
 * `data: [DONE]`, or before the end of a stream that ends without it: what the call cost. The
 * stream's totals have all arrived by then, and nothing after `[DONE]` is read into the summary, so
 * `last` and `done` see the same one. A stream the client cancelled has no reader left to tell.
 *
 * When reading the source fails, the error goes to `failed` and the returned stream ends with an
 * error written here, after that last chunk: the source's own error may carry anything, a quote of
 * the request included, and an error left on a response body is outside what the worker decides to log.
 */
export function meterStream(
  source: ReadableStream<Uint8Array>,
  done: (outcome: string, summary: StreamSummary) => void | Promise<void>,
  last: (outcome: string, summary: StreamSummary) => Record<string, unknown>,
  failed: (err: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const summary: StreamSummary = {
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    finishReason: '',
    replyChars: 0,
    ended: false,
  }
  let partial = ''
  let finished = false
  let sawDone = false
  let sawError = false
  // Set once the client has cancelled: the returned stream is closed then and must not be touched,
  // also not by a read that was waiting on `done` when the cancel came.
  let cancelled = false
  // Set once the client fell too far behind (MAX_QUEUED_BYTES): nothing more is queued for it, the
  // source is still read for its totals, and the returned stream errors once the call is settled.
  let dropped = false
  const endDropped = () => controller.error(new Error('the client fell too far behind the reply'))
  // Set when reading the source failed: the stream errors once the client has read what is queued
  // (erroring a stream drops what it has not handed out yet).
  let broke = false
  const finish = async (outcome: string) => {
    if (finished) return
    finished = true
    await done(outcome, summary)
  }
  const lastChunk = (outcome: string) => `data: ${JSON.stringify(last(outcome, summary))}\n\n`
  const isDone = (line: string) => line.startsWith('data:') && line.slice(5).trim() === '[DONE]'

  const scan = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '[DONE]') sawDone = summary.ended = true
    if (!data || data === '[DONE]') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const event = replyInfo(parsed)
    if (!event) return
    // The model can report a failure inside the stream; the extension shows it as an error.
    if (event.error) sawError = true
    // OpenAI sends usage once, in the last chunk. Workers AI also adds per-chunk counts and a
    // zeroed chunk before its final totals, so keep the largest count seen.
    if (event.usage) {
      const tokens = tokensOf(event.usage)
      summary.promptTokens = Math.max(summary.promptTokens, tokens.promptTokens)
      summary.cachedTokens = Math.max(summary.cachedTokens, tokens.cachedTokens)
      summary.completionTokens = Math.max(summary.completionTokens, tokens.completionTokens)
    }
    summary.replyChars += deltaChars(event.delta)
    const reason = event.finish_reason
    if (reason) summary.finishReason = finishReason(reason)
  }

  /** Complete lines, as they go to the client: with the last chunk ahead of `[DONE]`. */
  const pass = (lines: string[]) => {
    let out = ''
    for (const line of lines) {
      if (!sawDone && isDone(line)) out += lastChunk(sawError ? 'provider_error' : 'ok')
      if (!sawDone) scan(line.trimEnd())
      out += `${line}\n`
    }
    return out
  }
  /** The line held back, when the stream ends: it may be a whole event with no newline after it. */
  const rest = () => {
    const tail = partial + decoder.decode()
    partial = ''
    if (!tail) return ''
    const line = tail.trimEnd()
    if (!sawDone && isDone(line)) return `${lastChunk(sawError ? 'provider_error' : 'ok')}${tail}\n`
    if (!sawDone) scan(line)
    return `${tail}\n\n`
  }

  // Counted in bytes, with no room before the client asks: `desiredSize` is then minus what the
  // client has not read.
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const out = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c
      },
      pull() {
        // Called when the client asks for more and nothing is queued: what came before the error
        // has all been read.
        if (broke) controller.error(new Error('the model stream failed'))
      },
      async cancel(reason) {
        // A client that reads an error event stops reading at once, so the error decides the outcome.
        // Stop the model first, then settle: what the reply cost is known either way.
        cancelled = true
        const settled = finish(sawError ? 'provider_error' : 'cancelled')
        await reader.cancel(reason)
        await settled
      },
    },
    { highWaterMark: 0, size: (chunk) => chunk.byteLength },
  )
  const push = (text: string) => {
    if (text && !dropped) controller.enqueue(encoder.encode(text))
  }

  const pump = async () => {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (err) {
        // Once the client has cancelled, it is all handled there.
        if (cancelled) return
        failed(err)
        const tail = rest()
        const outcome = sawError ? 'provider_error' : 'stream_error'
        const end = sawDone ? '' : lastChunk(outcome)
        await finish(outcome)
        if (cancelled) return
        if (dropped) return endDropped()
        push(tail + end)
        // Errored once the client has read what is queued (see `pull`), or now if it has.
        broke = true
        if (controller.desiredSize === 0) controller.error(new Error('the model stream failed'))
        return
      }
      if (cancelled) return
      if (result.done) {
        const tail = rest()
        const outcome = sawError ? 'provider_error' : sawDone ? (dropped ? 'abandoned' : 'ok') : 'incomplete'
        const end = sawDone ? '' : lastChunk(outcome)
        await finish(outcome)
        if (cancelled) return
        if (dropped) return endDropped()
        push(tail + end)
        controller.close()
        return
      }
      const lines = (partial + decoder.decode(result.value, { stream: true })).split('\n')
      partial = lines.pop() ?? ''
      push(pass(lines))
      if (-(controller.desiredSize ?? 0) > MAX_QUEUED_BYTES) dropped = true
    }
  }

  pump().catch((err: unknown) => {
    // Nothing in the pump is meant to throw (`done` handles its own failures): end the stream
    // rather than leave the client waiting.
    failed(err)
    if (!cancelled) controller.error(new Error('the model stream failed'))
  })
  return out
}
