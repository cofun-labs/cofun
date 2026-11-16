// Stands in for OpenRouter's API at the edge, for the side panel's UI tests: the public model list,
// the key endpoint the settings page checks a key with, and chat completions behind a key. Replies come from a FakeAiBinding, which streams the
// OpenAI-style events OpenRouter sends too.
import { FakeAiBinding } from '../../../worker/test/fakes'
import { answerTitle, failingTitles, titleRequests } from './titles'

export const OPENROUTER = 'https://openrouter.ai'

/** A model as OpenRouter lists it, with only the fields the panel reads. */
export interface ListedModel {
  id: string
  name: string
  context_length: number
  pricing: { prompt: string; completion: string }
  supported_parameters?: string[]
}

/** A model that takes tools, priced in dollars per million tokens. */
export function listed(id: string, name: string, input = 1, output = 5): ListedModel {
  return {
    id,
    name,
    context_length: 200_000,
    pricing: { prompt: String(input / 1_000_000), completion: String(output / 1_000_000) },
    supported_parameters: ['tools', 'temperature'],
  }
}

/** The recommended models (@cofun/base's src/models.ts), all offered. */
const RECOMMENDED_LISTED: ListedModel[] = [
  listed('anthropic/claude-sonnet-5.5', 'Anthropic: Claude Sonnet 5.5', 2, 10),
  listed('openai/gpt-6.1-sol', 'OpenAI: GPT-6.1 Sol', 2, 10),
  listed('anthropic/claude-haiku-5.5', 'Anthropic: Claude Haiku 5.5', 0.1, 0.5),
  listed('openai/gpt-6-luna', 'OpenAI: GPT-6 Luna', 0.1, 0.5),
  listed('deepseek/deepseek-v4.1-flash', 'DeepSeek: DeepSeek V4.1 Flash', 0.3, 1.2),
]

/** A model call that reached OpenRouter: the key it carried and what it asked. */
interface Call {
  key: string | undefined
  model: string
  messages: { role: string; content?: unknown }[]
}

export class FakeOpenRouter {
  /** The model behind it; script its replies. */
  readonly ai = new FakeAiBinding()
  /** The model, for the panel's title requests, which are not in `calls` (see titles.ts). */
  readonly titles = failingTitles()
  /** Keys OpenRouter accepts. */
  readonly keys = new Set<string>()
  /** What `/models` lists. */
  models: ListedModel[] = [...RECOMMENDED_LISTED]
  /** What the key endpoint says the key has left: null for a key with no limit of its own. */
  limitRemaining: number | null = null
  /** Whether OpenRouter can't be reached: every request fails as a fetch to a host that is down does. */
  unreachable = false
  /**
   * Turns model calls away, as OpenRouter does: for too many requests (429), for an account out of
   * credits (402), or for input the model's moderation flagged (403, with the reasons in `metadata`).
   */
  refuses?: 'rate_limited' | 'no_credits' | 'moderated'
  /** Holds the key endpoint's answers until it resolves, when set. */
  checks?: Promise<void>
  /** Every request, model list included, in order: its path and the key it carried. */
  readonly requests: { path: string; key: string | undefined }[] = []
  /** The names of the headers of ours (`x-cofun-*`) that any request carried: meant for our worker only. */
  readonly cofunHeaders: string[] = []
  /** The model calls that got through. */
  readonly calls: Call[] = []

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const key = request.headers.get('authorization')?.replace(/^Bearer /, '')
    this.requests.push({ path: url.pathname, key })
    for (const [name] of request.headers) if (name.startsWith('x-cofun-')) this.cofunHeaders.push(name)
    if (this.unreachable) throw new TypeError('Failed to fetch')
    if (request.method === 'GET' && url.pathname === '/api/v1/models') return Response.json({ data: this.models })
    if (request.method === 'GET' && url.pathname === '/api/v1/key') {
      await this.checks
      if (!key || !this.keys.has(key))
        return Response.json({ error: { message: 'User not found.', code: 401 } }, { status: 401 })
      const limit = this.limitRemaining === null ? null : this.limitRemaining + 1
      return Response.json({
        data: {
          label: 'sk-or-v1-tes...key',
          limit,
          limit_remaining: this.limitRemaining,
          usage: 1,
          is_free_tier: false,
        },
      })
    }
    if (request.method !== 'POST' || url.pathname !== '/api/v1/chat/completions')
      return Response.json({ error: { message: 'Not Found', code: 404 } }, { status: 404 })
    if (!key || !this.keys.has(key))
      return Response.json({ error: { message: 'User not found.', code: 401 } }, { status: 401 })
    if (this.refuses === 'rate_limited')
      return Response.json(
        { error: { message: 'Rate limit exceeded: free-models-per-min.', code: 429 } },
        { status: 429 },
      )
    if (this.refuses === 'no_credits')
      return Response.json(
        {
          error: {
            message:
              'This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 1200. To increase, visit https://openrouter.ai/settings/credits and add more credits',
            code: 402,
          },
        },
        { status: 402 },
      )
    if (this.refuses === 'moderated')
      return Response.json(
        {
          error: {
            message: 'openai/gpt-6.1-sol requires moderation on OpenRouter. Your input was flagged for "violence".',
            code: 403,
            metadata: {
              reasons: ['violence'],
              flagged_input: 'Hello?',
              provider_name: 'OpenAI',
              model_slug: 'openai/gpt-6.1-sol',
            },
          },
        },
        { status: 403 },
      )
    const body = (await request.json()) as Record<string, unknown>
    if (titleRequests(this, body) === this.titles) return answerTitle(this.titles, body)
    const model = String(body.model)
    this.calls.push({ key, model, messages: body.messages as Call['messages'] })
    const out = await this.ai.run(model, body)
    return new Response(out as ReadableStream, { headers: { 'content-type': 'text/event-stream' } })
  }
}
