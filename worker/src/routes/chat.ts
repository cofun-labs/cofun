// OpenAI-compatible chat completions (/v1/chat/completions) on the model the worker fixes, charged
// to the user's credits and metered in a usage record.
import { Hono } from 'hono'
import * as z from '../zod'
import { FREE_CREDITS, Ledger, type Balance } from '../credits'
import { costOf, estimateCachedTokens, estimateTokens, type Tokens } from '../pricing'
import {
  finishReason,
  meterStream,
  recordUsage,
  replyInfo,
  tokensOf,
  type StreamSummary,
  type UsageRecord,
} from '../usage'
import { HttpError, errorSummary, parse, type App, type Ctx, type Deps, type Env } from '../http'
import { Body, MAX_CONTENT_CHARS, MAX_TOKENS, MaxTokens, Stream, parseModelInputs } from './chat-request'

/** A time as the out-of-credits message gives it: to the minute, in UTC, since the worker does not know the user's time zone. */
function utcMinute(ms: number): string {
  // Rounded up, so the time named is never before the credits arrive.
  const iso = new Date(Math.ceil(ms / 60_000) * 60_000).toISOString()
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`
}

/** The product of a model call whose caller is no listed extension. */
const UNKNOWN_PRODUCT = 'unknown'

/** The PRODUCTS var: extension origins, each with a product name of lowercase letters. */
const Products = z.record(
  z.string().regex(/^chrome-extension:\/\/[a-p]{32}$/, { error: 'keys must be chrome-extension://<extension id>' }),
  z
    .string()
    .regex(/^[a-z]{1,32}$/, { error: 'product names are 1 to 32 lowercase letters' })
    .refine((name) => name !== UNKNOWN_PRODUCT, { error: `${UNKNOWN_PRODUCT} is not a product name` }),
)

/** The origin a session token was issued to, when it names one. */
const Azp = z.object({ azp: z.string().optional() })

/**
 * The product a model call comes from: the one PRODUCTS lists for the origin the session token was
 * issued to (its `azp`, which Clerk signs, so a client cannot pick it), or `unknown`. Unknown callers
 * are not refused: the product only sorts what was spent, credits are one balance across products.
 */
function productOf(env: Env, claims: unknown): string {
  const products = Products.optional().safeParse(env.PRODUCTS)
  if (!products.success) {
    throw new HttpError(503, 'not_configured', `PRODUCTS is invalid: ${products.error.issues[0].message}`)
  }
  const listed = products.data ?? {}
  const azp = Azp.safeParse(claims).data?.azp
  return azp !== undefined && Object.hasOwn(listed, azp) ? listed[azp] : UNKNOWN_PRODUCT
}

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
    const started = Date.now()
    const usage: UsageRecord = {
      userId: c.get('userId'),
      product: UNKNOWN_PRODUCT,
      model: c.env.MODEL,
      stream: false,
      outcome: '',
      messages: 0,
      inputChars: 0,
      promptTokens: 0,
      cachedTokens: 0,
      completionTokens: 0,
      microCredits: 0,
      finishReason: '',
      durationMs: 0,
    }
    const record = (outcome: string) => {
      usage.outcome = outcome
      usage.durationMs = Date.now() - started
      recordUsage(c.env.USAGE, usage)
    }
    try {
      return await chatCompletion(c, usage, record)
    } catch (err) {
      record(err instanceof HttpError ? err.code : 'internal')
      throw err
    }
  })

  /**
   * Fills `usage` with sizes and token counts only, and calls `record` once the reply is complete.
   * Throws HttpError for refusals; the caller records those.
   */
  async function chatCompletion(c: Ctx, usage: UsageRecord, record: (outcome: string) => void): Promise<Response> {
    const product = productOf(c.env, c.get('claims'))
    usage.product = product
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

    // Charged after use: a call goes ahead while the user has credits, and its cost is taken when
    // the reply ends. The last call may take the balance below zero; the next grant pays that back
    // first. Calls sent at once all start on the same balance, so together they can overspend by
    // more than one call: accepted, since one call costs little and what was overspent is owed.
    const maxTokens = max_tokens ?? MAX_TOKENS
    const ledger = new Ledger(c.env.DB, c.get('userId'))
    let balance: Balance
    try {
      balance = await ledger.open(now().getTime())
    } catch (err) {
      logError(`credit check failed: ${errorSummary(err)}`)
      throw new HttpError(503, 'credits_unavailable', 'Credits are unavailable, try again in a moment.')
    }
    if (balance.balance <= 0) {
      throw new HttpError(
        402,
        'out_of_credits',
        `You have no credits left. Your next ${FREE_CREDITS} free credits arrive on ${utcMinute(balance.nextGrantAt)}, or you can buy credits.`,
      )
    }

    /**
     * Ends the call, once: records it in the database with how it ended and its tokens, takes what
     * it cost from the user's credits, and puts the cost in the usage record. Every call that
     * reached the model is recorded, failed ones too; one that failed costs nothing. A record that
     * fails is logged and the reply still goes out: the model has already answered.
     */
    const startedAt = now().getTime()
    let ended = false
    const endCall = async (outcome: string, tokens: Tokens, finish: string, estimated: boolean) => {
      if (ended) return
      ended = true
      const cost = costOf(price, tokens)
      try {
        await ledger.endCall({
          product,
          model: c.env.MODEL,
          startedAt,
          endedAt: Math.max(startedAt, now().getTime()),
          stream: stream === true,
          outcome,
          finishReason: finish,
          ...tokens,
          estimated,
          cost,
        })
        usage.microCredits = cost
      } catch (err) {
        logError(`model call record failed: ${errorSummary(err)}`)
      }
    }
    const nothing: Tokens = { promptTokens: 0, cachedTokens: 0, completionTokens: 0 }

    const call = callModel().catch(async (err: unknown) => {
      await endCall(err instanceof HttpError ? err.code : 'internal', nothing, '', false)
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
          // A reply the user stopped, or a stream that broke off, costs what it used. Its totals come
          // in the stream's last chunks, which never arrived, so they are estimated: the prompt from
          // the size of the input when no chunk gave it, the reply from the characters that were
          // streamed (never below what the stream did report), and the part of the prompt read from
          // the cache as a fixed share of it, since nothing says how much it was.
          // Two cases cost what the stream reported and no more. One that ran to its end has its
          // totals, even when the client stopped reading right there. And one that broke off before
          // it reported or carried anything is a call that failed without usage: it costs nothing.
          // (A reply the user stopped that early is still charged its prompt: the model was reading it.)
          const cutShort = outcome === 'cancelled' || outcome === 'incomplete' || outcome === 'stream_error'
          const empty = outcome !== 'cancelled' && !promptTokens && !completionTokens && !summary.replyChars
          const estimated = cutShort && !summary.ended && !empty
          if (estimated) {
            tokens.promptTokens ||= estimateTokens(chars)
            tokens.cachedTokens = estimateCachedTokens(tokens.promptTokens)
            tokens.completionTokens = Math.max(tokens.completionTokens, estimateTokens(summary.replyChars))
          }
          return { tokens, estimated }
        }
        const settle = async (outcome: string, summary: StreamSummary) => {
          const { tokens, estimated } = charged(outcome, summary)
          usage.promptTokens = tokens.promptTokens
          usage.cachedTokens = tokens.cachedTokens
          usage.completionTokens = tokens.completionTokens
          usage.finishReason = summary.finishReason
          await endCall(outcome, tokens, summary.finishReason, estimated)
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
            const { tokens, estimated } = charged(outcome, summary)
            return { choices: [], cost: callCost(costOf(price, tokens), estimated) }
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
      const body = isRecord(out) ? { ...out, cost: callCost(costOf(price, tokens), false) } : out
      const res = c.newResponse(JSON.stringify(body), 200, { 'content-type': 'application/json' })
      await endCall('ok', tokens, usage.finishReason, false)
      record('ok')
      return res
    }
  }

  return routes
}
