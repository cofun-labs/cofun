// OpenAI-compatible chat completions (/v1/chat/completions) on the model the worker fixes, charged
// to the user's credits and metered in a usage record.
import { Hono } from 'hono'
import { charge, openLedger, startUsage, type Charging, type Turn } from '../charge'
import { costOf, estimateCachedTokens, estimateTokens, type Tokens } from '../pricing'
import { finishReason, meterStream, replyInfo, tokensOf, type StreamSummary, type UsageRecord } from '../usage'
import { HttpError, errorSummary, parse, type App, type Ctx, type Deps } from '../http'
import { Body, MAX_CONTENT_CHARS, MAX_TOKENS, MaxTokens, Stream, parseModelInputs } from './chat-request'

/**
 * Whether a value can be read as a stream. Judged by the method the worker calls, not by class: the
 * AI binding's stream need not be an instance of this module's `ReadableStream`.
 */
function isStream(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof value === 'object' && 'getReader' in value && typeof value.getReader === 'function'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * What a model call cost, as the client is told: in micro-credits, as charged (`costOf`), and whether
 * its tokens were estimated because the call was cut short. Sent next to `usage`, in the body of a
 * reply or in the last chunk of a stream. The worker is the only place that prices a call.
 */
function callCost(microCredits: number, estimated: boolean) {
  return { micro_credits: microCredits, estimated }
}

/** Chat completions, mounted at /v1/chat. */
export function chatRoutes({ now, priceOf: priceFor, logError }: Deps): App {
  const routes: App = new Hono()
  // OpenAI-compatible chat completions. The model is fixed by the server.
  // Every request that passed auth leaves one usage record, however it ends.
  routes.post('/completions', async (c) => {
    const { usage, record, turn } = startUsage(c, c.env.MODEL)
    try {
      return await chatCompletion(c, usage, record, turn)
    } catch (err) {
      record(err instanceof HttpError ? err.code : 'internal')
      throw err
    }
  })

  /**
   * Fills `usage` with sizes and token counts only, and calls `record` once the reply is complete.
   * Throws HttpError for refusals; the caller records those.
   */
  async function chatCompletion(
    c: Ctx,
    usage: UsageRecord,
    record: (outcome: string) => void,
    readTurn: () => Turn,
  ): Promise<Response> {
    const product = usage.product
    const turn = readTurn()
    const body = parse(Body, await c.req.json().catch(() => undefined))
    usage.stream = body.stream === true
    const { inputs: modelInputs, chars } = parseModelInputs(body)
    usage.messages = modelInputs.messages.length
    usage.inputChars = chars
    if (chars > MAX_CONTENT_CHARS)
      throw new HttpError(400, 'bad_request', `messages and tools exceed ${MAX_CONTENT_CHARS} characters`)
    // null means not set.
    const max_tokens =
      body.max_tokens === undefined || body.max_tokens === null ? undefined : parse(MaxTokens, body.max_tokens)
    const stream = parse(Stream, body.stream)
    if (body.model !== undefined && body.model !== c.env.MODEL) {
      // A distinct code lets a client that cached the old model name notice and look it up again.
      throw new HttpError(400, 'unsupported_model', `unsupported model; use ${c.env.MODEL} or omit it`)
    }

    const priced = priceFor(c.env.MODEL)
    if (!priced) throw new HttpError(503, 'not_configured', 'MODEL has no price')
    const price = priced

    // Calls sent at once all start on the same balance (see below), so how many one user can start
    // a minute is capped. Checked before the credits, so a refused request reads nothing.
    const { success } = await c.env.CHAT_LIMIT.limit({ key: c.get('userId') })
    if (!success) throw new HttpError(429, 'rate_limited', 'Too many requests at once. Wait a minute, then ask again.')

    // Charged when the reply ends (charge.ts); CHAT_LIMIT and MAX_TOKENS bound what calls at once cost.
    const maxTokens = max_tokens ?? MAX_TOKENS
    const charging: Charging = {
      ledger: await openLedger(c, now().getTime(), logError),
      usage,
      turn,
      now: () => now().getTime(),
      logError,
      what: 'model call',
    }

    /** Ends the call, once: records it as a spend of `cost`, with how it ended and its tokens. */
    const startedAt = now().getTime()
    let ended = false
    const endCall = async (outcome: string, tokens: Tokens, finish: string, estimated: boolean, cost: number) => {
      if (ended) return
      ended = true
      const detail = {
        kind: 'model_call',
        model: c.env.MODEL,
        startedAt,
        stream: stream === true,
        outcome,
        finishReason: finish,
        ...tokens,
        estimated,
      } as const
      await charge(charging, cost, detail, Math.max(startedAt, now().getTime()))
    }
    const nothing: Tokens = { promptTokens: 0, cachedTokens: 0, completionTokens: 0 }

    const call = callModel().catch(async (err: unknown) => {
      await endCall(err instanceof HttpError ? err.code : 'internal', nothing, '', false, 0)
      throw err
    })
    // The model is called and the call charged even if the client goes away meanwhile: a request
    // dropped right after it was sent must not be a free call.
    c.executionCtx.waitUntil(call.catch(() => {}))
    return await call

    async function callModel(): Promise<Response> {
      // Pass only the fields the model needs; drop anything else a client added.
      const inputs: Record<string, unknown> = { ...modelInputs }
      // Without an explicit limit, models fall back to their own default, which can be
      // small enough to cut replies short.
      inputs.max_tokens = maxTokens
      if (stream === true) {
        inputs.stream = true
        // Ask for token usage in the final chunk, so streamed replies can be metered too.
        inputs.stream_options = { include_usage: true }
      }
      // collectLog: false keeps prompts and replies out of the gateway logs, and skipCache: true
      // keeps them out of its cache even if caching is turned on in the dashboard. The gateway's
      // analytics (requests, tokens, cost, metadata) still work.
      const options = c.env.AI_GATEWAY_ID
        ? {
            gateway: {
              id: c.env.AI_GATEWAY_ID,
              collectLog: false,
              skipCache: true,
              metadata: { product, user: c.get('userId') },
            },
          }
        : undefined

      let out: unknown
      try {
        out = await c.env.AI.run(c.env.MODEL, inputs, options)
      } catch (err) {
        // A summary goes to Workers Logs, not to the client. Never log the error itself: nothing
        // shows that what the provider returns can't quote the request.
        logError(`model call failed: ${errorSummary(err)}`)
        throw new HttpError(502, 'provider_error', 'the model is unavailable, try again later')
      }

      if (stream === true) {
        // Workers AI already streams OpenAI-style SSE; pass it through, reading usage on the way.
        if (!isStream(out)) throw new Error('the model returned no stream')
        /** What a stream that ended this way is charged by: its tokens, and whether they are an estimate. */
        const charged = (outcome: string, summary: StreamSummary) => {
          const { promptTokens, cachedTokens, completionTokens } = summary
          const tokens: Tokens = { promptTokens, cachedTokens, completionTokens }
          // A model error, or a stream that broke off before [DONE] unless the user stopped it, failed:
          // it costs nothing, whatever it streamed first.
          const failed = outcome === 'provider_error' || (outcome !== 'ok' && outcome !== 'cancelled' && !summary.ended)
          if (failed) return { tokens, estimated: false, cost: 0 }
          // One that reached [DONE] costs its totals. One the user stopped before costs an estimate,
          // since its totals never came: the prompt from the input's size when no chunk gave it, the
          // reply from the characters streamed, and a fixed share of the prompt as cached.
          const estimated = outcome === 'cancelled' && !summary.ended
          if (estimated) {
            tokens.promptTokens ||= estimateTokens(chars)
            tokens.cachedTokens = estimateCachedTokens(tokens.promptTokens)
            tokens.completionTokens = Math.max(tokens.completionTokens, estimateTokens(summary.replyChars))
          }
          return { tokens, estimated, cost: costOf(price, tokens) }
        }
        const settle = async (outcome: string, summary: StreamSummary) => {
          const { tokens, estimated, cost } = charged(outcome, summary)
          usage.promptTokens = tokens.promptTokens
          usage.cachedTokens = tokens.cachedTokens
          usage.completionTokens = tokens.completionTokens
          usage.finishReason = summary.finishReason
          await endCall(outcome, tokens, summary.finishReason, estimated, cost)
          record(outcome)
        }
        const metered = meterStream(
          out,
          (outcome, summary) => {
            const settled = settle(outcome, summary)
            // A client that went away must not take the charge with it.
            c.executionCtx.waitUntil(settled)
            return settled
          },
          // The cost goes to the client in a chunk of its own, as the last before [DONE]: it is known
          // only once the stream's totals are in, and Workers AI reports usage on many chunks.
          (outcome, summary) => {
            const { estimated, cost } = charged(outcome, summary)
            return { choices: [], cost: callCost(cost, estimated) }
          },
          (err) => logError(`model stream failed: ${errorSummary(err)}`),
        )
        return new Response(metered, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        })
      }
      const reply = replyInfo(out)
      const tokens = tokensOf(reply?.usage)
      Object.assign(usage, tokens)
      usage.finishReason = finishReason(reply?.finish_reason)
      // The reply as the model gave it. Build the response first: if that throws, the request is
      // recorded once, as internal, and nothing is charged.
      const cost = costOf(price, tokens)
      const body = isRecord(out) ? { ...out, cost: callCost(cost, false) } : out
      const res = c.newResponse(JSON.stringify(body), 200, { 'content-type': 'application/json' })
      await endCall('ok', tokens, usage.finishReason, false, cost)
      record('ok')
      return res
    }
  }

  return routes
}
