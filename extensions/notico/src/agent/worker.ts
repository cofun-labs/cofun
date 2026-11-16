// Notico's public web tools combine Worker calls with the messages shown on the tool cards.
import { looseText, requireToken, turnHeaders, workerBaseUrl, type Turn, type WorkerConfig } from '@cofun/base/agent'
import { z } from '@cofun/base/zod'
import { WebError, WebPage, WebSearchResult } from './types'

/** A refusal from the worker, with its code. */
const CodedError = z.object({ error: z.object({ code: looseText, message: looseText }) })

/** What a render or a search cost, as each of its answers says; a plain read, or one turned away first, says nothing. */
const Charged = z.object({ cost: z.object({ micro_credits: z.number().int().nonnegative() }).optional() })

/** What the user is told when the worker's limit on pages read stops a question. */
const TOO_MANY_PAGES = 'Notico read too many web pages in a minute. Wait a minute, then ask again.'

/**
 * What the user is told when a 429 without a code of the worker's turns a read or a search away:
 * one sent before the worker (by Cloudflare, say), for coming too often.
 */
const TURNED_AWAY = "Notico's service turned away its requests for coming too often. Wait a minute, then ask again."

/** What the model is told when the worker could not be reached, or its answer could not be read. */
const UNREACHABLE = "Notico's service could not be reached"
const UNREADABLE = "Notico's service gave an answer Notico could not read"

/**
 * Whether a render or a search was or may have been charged, by the worker's answer, after calling
 * `charged` with what it cost in micro-credits, or with undefined when the answer does not say so,
 * so what it cost is not known. Results always say what they cost; a refusal only when the worker
 * rendered or searched.
 */
function chargedBy(res: Response, body: unknown, charged?: (microCredits: number | undefined) => void): boolean {
  const cost = Charged.safeParse(body)
  if (!cost.success || (res.ok && !cost.data.cost)) {
    charged?.(undefined)
    return true
  }
  if (!cost.data.cost) return false
  charged?.(cost.data.cost.micro_credits)
  return cost.data.cost.micro_credits > 0
}

/** The worker's refusal: its code and message, or the HTTP status when it gave none. */
function refusalOf(res: Response, body: unknown): { code: string; message: string } {
  const refusal = CodedError.safeParse(body).data?.error
  return { code: refusal?.code ?? `http_${res.status}`, message: refusal?.message ?? `HTTP ${res.status}` }
}

/**
 * What the user is told when the worker's answer to a read stops the question, or undefined when
 * it doesn't. Only a request turned away stops it: for coming too often, or for credits that ran
 * out. Any other failure goes to the model: a read changes nothing and involves no account of the
 * user's (CLAUDE.md, "Calling outside services"). A stopped question sends nothing more.
 */
function stopsReading(code: string, message: string): string | undefined {
  if (code === 'rate_limited') return TOO_MANY_PAGES
  if (code === 'http_429') return TURNED_AWAY
  // The worker's own words: they say when the next free credits arrive.
  if (code === 'out_of_credits') return message
  if (code === 'site_busy')
    return "A site turned away Notico's requests for coming too often. Wait a while, then ask again."
  // The browser that renders pages turned the render away: another would be turned away too.
  if (code === 'render_busy') return `Notico could not render the page: ${message}.`
  return undefined
}

/**
 * What the user is told when the worker's answer to a search stops the question, or undefined when
 * it doesn't: as for a read (see stopsReading), only a search turned away stops it, by the worker
 * or by the provider, for coming too often or for a balance that ran out.
 */
function stopsSearching(code: string, message: string): string | undefined {
  if (code === 'rate_limited')
    return 'Notico searched the web too many times in a minute. Wait a minute, then ask again.'
  if (code === 'http_429') return TURNED_AWAY
  // The worker's own words: they say when the next free credits arrive.
  if (code === 'out_of_credits') return message
  // The provider is busy, or the account's credits for it ran out: another search would be turned away too.
  if (code === 'search_busy' || code === 'search_unavailable') return `Notico could not search the web: ${message}.`
  return undefined
}

/** What a request to the worker's web routes needs: where the worker is, the session, and the question it is for. */
type WebConfig = WorkerConfig & { turn?: Turn }

/**
 * Asks the worker's web route `path`, and gives its answer, with whether it may have cost credits.
 * Throws a WebError: coded `failed` when the worker can't be reached, else the refusal's code,
 * stopping the question when `stops` says so. For a `paid` route, `charged` gets what the call
 * cost, or undefined when that's unknown. A Stop throws what `fetch` or reading the answer threw.
 */
async function askWeb(
  { apiUrl, getToken, client, turn }: WebConfig,
  path: string,
  payload: unknown,
  {
    paid,
    failed,
    stops,
  }: { paid: boolean; failed: string; stops: (code: string, message: string) => string | undefined },
  signal?: AbortSignal,
  charged?: (microCredits: number | undefined) => void,
): Promise<{ body: unknown; mayHaveCost: boolean }> {
  const token = await requireToken(getToken)
  let res: Response
  try {
    res = await fetch(`${workerBaseUrl(apiUrl)}/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-cofun-client': client,
        ...turnHeaders(turn),
      },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (err) {
    // The worker may have rendered or searched, and charged it.
    if (paid) charged?.(undefined)
    if (signal?.aborted) throw err
    throw new WebError(failed, UNREACHABLE, { charged: paid, cause: err })
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    // A Stop while the answer is read is a Stop, not an unreadable answer.
    if (signal?.aborted) {
      if (paid) charged?.(undefined)
      throw err
    }
  }
  const mayHaveCost = paid && chargedBy(res, body, charged)
  if (!res.ok) {
    const { code, message } = refusalOf(res, body)
    throw new WebError(code, message, { stopsQuestion: stops(code, message), charged: mayHaveCost })
  }
  return { body, mayHaveCost }
}

/** Has the worker read the web page at `url`, rendered when `render` is set (see ToolContext.readWeb and askWeb). */
export async function readWebPage(
  config: WebConfig,
  url: string,
  maxChars: number,
  render: boolean,
  signal?: AbortSignal,
  charged?: (microCredits: number | undefined) => void,
): Promise<WebPage> {
  const how = { paid: render, failed: 'read_failed', stops: stopsReading }
  const path = `web/${render ? 'render' : 'read'}`
  const { body, mayHaveCost } = await askWeb(config, path, { url, max_chars: maxChars }, how, signal, charged)
  const page = WebPage.safeParse(body)
  if (!page.success) throw new WebError('read_failed', UNREADABLE, { charged: mayHaveCost, cause: page.error })
  return page.data
}

/** The worker's answer to a search. */
const WebSearch = z.object({ results: z.array(WebSearchResult) })

/** Has the worker search the web for `query`, for at most `limit` results, never retried (see ToolContext.searchWeb and askWeb). */
export async function searchWebFor(
  config: WebConfig,
  query: string,
  limit: number,
  signal?: AbortSignal,
  charged?: (microCredits: number | undefined) => void,
): Promise<WebSearchResult[]> {
  const how = { paid: true, failed: 'search_failed', stops: stopsSearching }
  const { body, mayHaveCost } = await askWeb(config, 'web/search', { query, limit }, how, signal, charged)
  const answer = WebSearch.safeParse(body)
  if (!answer.success) throw new WebError('search_failed', UNREADABLE, { charged: mayHaveCost, cause: answer.error })
  return answer.data.results
}
