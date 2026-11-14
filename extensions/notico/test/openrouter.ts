// Stands in for OpenRouter's API at the edge, for the side panel's UI tests: the public model list,
// and chat completions behind a key. Replies come from a FakeAiBinding, which streams the
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

/** The recommended models (src/models.ts), all offered. */
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
  /** Every request, model list included, in order: its path and the key it carried. */
  readonly requests: { path: string; key: string | undefined }[] = []
  /** The model calls that got through. */
  readonly calls: Call[] = []

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const key = request.headers.get('authorization')?.replace(/^Bearer /, '')
    this.requests.push({ path: url.pathname, key })
    if (request.method === 'GET' && url.pathname === '/api/v1/models') return Response.json({ data: this.models })
    if (request.method !== 'POST' || url.pathname !== '/api/v1/chat/completions')
      return Response.json({ error: { message: 'Not Found', code: 404 } }, { status: 404 })
    if (!key || !this.keys.has(key))
      return Response.json({ error: { message: 'User not found.', code: 401 } }, { status: 401 })
    const body = (await request.json()) as Record<string, unknown>
    if (titleRequests(this, body) === this.titles) return answerTitle(this.titles, body)
    const model = String(body.model)
    this.calls.push({ key, model, messages: body.messages as Call['messages'] })
    const out = await this.ai.run(model, body)
    return new Response(out as ReadableStream, { headers: { 'content-type': 'text/event-stream' } })
  }
}
