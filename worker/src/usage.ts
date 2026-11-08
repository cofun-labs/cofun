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
  model: string
  stream: boolean
  /** `ok`, `cancelled`, `stream_error`, or the error code returned to the client. */
  outcome: string
  messages: number
  inputChars: number
  promptTokens: number
  completionTokens: number
  /** `stop`, `length`, `content_filter`, `tool_calls`, `other`, or empty when unknown. */
  finishReason: string
  latencyMs: number
}

const FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_calls'])

/** Keeps only known finish reasons, so nothing the model wrote can reach a record. */
export function finishReason(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  return typeof value === 'string' && FINISH_REASONS.has(value) ? value : 'other'
}

/** A token count from the model, or 0 when missing or malformed. */
export function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/**
 * Writes one record. The column layout is what SQL queries rely on; append new columns, never reorder:
 *
 * - index1: user id
 * - blob1: model, blob2: outcome, blob3: finish reason, blob4: `stream` or `sync`
 * - double1: messages, double2: input characters, double3: prompt tokens,
 *   double4: completion tokens, double5: latency in ms
 *
 * Analytics Engine adds the timestamp itself.
 */
export function recordUsage(dataset: UsageDataset, r: UsageRecord): void {
  try {
    dataset.writeDataPoint({
      indexes: [r.userId],
      blobs: [r.model, r.outcome, r.finishReason, r.stream ? 'stream' : 'sync'],
      doubles: [r.messages, r.inputChars, r.promptTokens, r.completionTokens, r.latencyMs],
    })
  } catch (err) {
    // A lost usage record must never fail the user's request.
    console.error('usage record failed', err)
  }
}

/** What the final chunks of an OpenAI-style stream say about the reply. */
interface StreamSummary {
  promptTokens: number
  completionTokens: number
  finishReason: string
}

/**
 * Passes an OpenAI-style SSE stream through unchanged, chunk by chunk, while reading the token
 * usage and finish reason from it. Calls `done` once, when the stream ends, fails, or is cancelled.
 * Only the current incomplete line is held back for parsing; the reply itself is never buffered.
 */
export function meterStream(
  source: ReadableStream<Uint8Array>,
  done: (outcome: string, summary: StreamSummary) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const summary: StreamSummary = { promptTokens: 0, completionTokens: 0, finishReason: '' }
  let partial = ''
  let finished = false
  const finish = (outcome: string) => {
    if (finished) return
    finished = true
    done(outcome, summary)
  }

  const scan = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    const event = parsed as { usage?: Record<string, unknown>; choices?: { finish_reason?: unknown }[] }
    // OpenAI sends usage once, in the last chunk. Workers AI also adds per-chunk counts and a
    // zeroed chunk before its final totals, so keep the largest count seen.
    if (event.usage) {
      summary.promptTokens = Math.max(summary.promptTokens, tokenCount(event.usage.prompt_tokens))
      summary.completionTokens = Math.max(summary.completionTokens, tokenCount(event.usage.completion_tokens))
    }
    const reason = event.choices?.[0]?.finish_reason
    if (reason) summary.finishReason = finishReason(reason)
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (err) {
        finish('stream_error')
        controller.error(err)
        return
      }
      if (result.done) {
        scan(partial + decoder.decode())
        finish('ok')
        controller.close()
        return
      }
      const lines = (partial + decoder.decode(result.value, { stream: true })).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) scan(line.trimEnd())
      controller.enqueue(result.value)
    },
    async cancel(reason) {
      finish('cancelled')
      await reader.cancel(reason)
    },
  })
}
