import type { AiBinding } from '../src/app'
import { consume, type QuotaCounter, type QuotaNamespace, type QuotaStorage } from '../src/quota'

type Call = { model: string; inputs: Record<string, unknown>; options?: Record<string, unknown> }

/**
 * Stands in for the Workers AI binding (env.AI) with the same `run` signature,
 * replying in the OpenAI chat-completion shape that current models use.
 */
export class FakeAiBinding implements AiBinding {
  calls: Call[] = []
  failWith?: Error
  /** When set, a streamed call returns this raw SSE text instead of the reply. */
  rawSse?: string

  constructor(private reply = 'Hello from Workers AI') {}

  async run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ model, inputs, options })
    if (this.failWith) throw this.failWith

    if (!inputs.stream) {
      return {
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: this.reply }, finish_reason: 'stop' }],
      }
    }

    if (this.rawSse !== undefined) return new Response(this.rawSse).body

    const lines = this.reply.split(' ').map((w) => ({ choices: [{ index: 0, delta: { content: w + ' ' } }] }))
    const sse = lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(sse).body
  }
}

/** In-memory storage with the same get/put shape as Durable Object storage. */
class MemoryStorage implements QuotaStorage {
  private data = new Map<string, unknown>()
  async get<T>(key: string) {
    return this.data.get(key) as T | undefined
  }
  async put<T>(key: string, value: T) {
    this.data.set(key, structuredClone(value))
  }
}

/**
 * Stands in for the UserQuota Durable Object namespace (env.QUOTA): one counter per name,
 * running the worker's real counting logic over in-memory storage.
 */
export class FakeQuotaNamespace implements QuotaNamespace {
  private storages = new Map<string, MemoryStorage>()
  /** When set, every counter call fails with this error, like an unavailable Durable Object. */
  failWith?: Error

  getByName(name: string): QuotaCounter {
    let storage = this.storages.get(name)
    if (!storage) this.storages.set(name, (storage = new MemoryStorage()))
    return {
      consume: async (day, limit) => {
        if (this.failWith) throw this.failWith
        return consume(storage, day, limit)
      },
    }
  }
}
