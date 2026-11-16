/**
 * What a model's tokens cost, in micro-credits per token. A credit is a thousandth of a US dollar,
 * so a price of US$1 per million tokens is 1000 micro-credits per token. Prices are the provider's
 * list prices, with no markup.
 */
interface Price {
  input: number
  /** Input the provider read from its prompt cache. */
  cachedInput: number
  output: number
}

/** The token counts of one model call. `cachedTokens` is the part of `promptTokens` read from the cache. */
export interface Tokens {
  promptTokens: number
  cachedTokens: number
  completionTokens: number
}

/**
 * One entry per model the worker may be set to (`MODEL`), from
 * https://developers.cloudflare.com/workers-ai/platform/pricing/. A model that is not listed is a
 * configuration error, never a free call: add its prices here in the change that switches to it.
 */
const PRICES = new Map<string, Price>([
  // US$0.30 input, US$0.006 cached input, US$1.20 output per million tokens.
  ['@cf/deepseek-ai/deepseek-v4.1-flash-1017', { input: 300, cachedInput: 6, output: 1200 }],
])

export function priceOf(model: string): Price | undefined {
  return PRICES.get(model)
}

/** The cost of one model call in micro-credits: cached input at its own price, the rest of the input at the full one. */
export function costOf(price: Price, tokens: Tokens): number {
  const cached = Math.min(tokens.cachedTokens, tokens.promptTokens)
  return (
    (tokens.promptTokens - cached) * price.input + cached * price.cachedInput + tokens.completionTokens * price.output
  )
}

/**
 * How many characters count as one token when a count has to be estimated: a stream that was cut
 * short never sent its totals. Rough on purpose: English text runs near four characters a token,
 * Chinese near one.
 */
const CHARS_PER_TOKEN = 3

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * How much of a prompt counts as read from the cache when the model never said: a stream gives the
 * cached count only in its last chunk, which a cut-short stream never sent. An agent resends its
 * instructions, tools, and the conversation on every call, so most of a prompt usually is cached.
 */
const ESTIMATED_CACHED_SHARE = 0.9

export function estimateCachedTokens(promptTokens: number): number {
  return Math.floor(promptTokens * ESTIMATED_CACHED_SHARE)
}

/**
 * What a page rendered in Browser Run costs, in micro-credits per ms of browser time: its list price
 * for Quick Actions, US$0.09 per browser hour (https://developers.cloudflare.com/browser-run/pricing/),
 * with nothing added: 90 credits an hour is exactly 25 micro-credits a ms. Like a model's tokens, the
 * hours a month Workers Paid includes are not passed on, and neither is the rounding of a month's
 * time to whole hours on the operator's bill.
 */
const RENDER_PER_MS = 25

/** The cost of a render that used `browserMs` of browser time, in micro-credits. */
export function renderCostOf(browserMs: number): number {
  return browserMs * RENDER_PER_MS
}

/**
 * What a web search costs, in micro-credits: its list price on Ceramic, the search provider, US$0.25
 * per 1,000 searches (https://ceramic.ai/pricing), paid through AI Gateway with nothing added: 0.25
 * credit a search.
 */
export const SEARCH_COST = 250_000
