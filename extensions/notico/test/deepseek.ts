// Stands in for DeepSeek's API at the edge, for the side panel's UI tests: chat completions behind a
// key, refused as DeepSeek refuses them. Replies come from a FakeAiBinding, which streams the
// OpenAI-style events DeepSeek sends too.
import { FakeAiBinding } from '../../../worker/test/fakes'

export const DEEPSEEK = 'https://api.deepseek.com'

/** A model call that reached DeepSeek: the key it carried and what it asked. */
interface Call {
  key: string | undefined
  model: string
  messages: { role: string; content?: unknown }[]
  /** Whether the model was asked to think first, as DeepSeek reads it. */
  thinking: unknown
}

/** An error as DeepSeek's API sends it. */
const refusal = (status: number, message: string, type: string) =>
  Response.json({ error: { message, type, param: null, code: 'invalid_request_error' } }, { status })

export class FakeDeepSeek {
  /** The model behind it; script its replies. */
  readonly ai = new FakeAiBinding()
  /** Keys DeepSeek accepts. */
  readonly keys = new Set<string>()
  /** Whether the account behind the keys has run out of balance. */
  outOfBalance = false
  /** Whether DeepSeek is turning the account's requests away for too many of them. */
  rateLimited = false
  /** Every request, in order: its path and the key it carried. */
  readonly requests: { path: string; key: string | undefined }[] = []
  /** The model calls that got through. */
  readonly calls: Call[] = []

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const key = request.headers.get('authorization')?.replace(/^Bearer /, '')
    this.requests.push({ path: url.pathname, key })
    if (request.method !== 'POST' || url.pathname !== '/chat/completions')
      return refusal(404, 'Not Found', 'invalid_request_error')
    if (!key || !this.keys.has(key))
      return refusal(401, 'Authentication Fails, Your api key is invalid', 'authentication_error')
    if (this.outOfBalance) return refusal(402, 'Insufficient Balance', 'unknown_error')
    if (this.rateLimited) return refusal(429, 'Rate limit reached for requests', 'rate_limit_error')
    const body = (await request.json()) as Record<string, unknown>
    const model = String(body.model)
    this.calls.push({ key, model, messages: body.messages as Call['messages'], thinking: body.thinking })
    const out = await this.ai.run(model, body)
    return new Response(out as ReadableStream, { headers: { 'content-type': 'text/event-stream' } })
  }
}
