// Talks to the notion-copilot worker's OpenAI-compatible API.

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export interface ApiConfig {
  /** Base URL including /v1. */
  apiUrl: string
  /** Returns a fresh Clerk session token. */
  getToken: () => Promise<string | null>
}

async function authHeaders(config: ApiConfig): Promise<Record<string, string>> {
  const token = await config.getToken()
  if (!token) throw new Error('Please sign in first.')
  return { authorization: `Bearer ${token}` }
}

function url(config: ApiConfig, path: string): string {
  return config.apiUrl.replace(/\/+$/, '') + path
}

async function errorFrom(res: Response): Promise<Error> {
  const body = await res.text()
  try {
    const msg = JSON.parse(body).error?.message
    if (msg) return new Error(msg)
  } catch {}
  return new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`)
}

/** Streams a chat completion. Calls onDelta for each chunk and resolves with the full reply. */
export async function streamChat(
  config: ApiConfig,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(url(config, '/chat/completions'), {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', ...(await authHeaders(config)) },
    body: JSON.stringify({ messages, stream: true }),
  })
  if (!res.ok || !res.body) throw await errorFrom(res)

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let full = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += value

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const delta: unknown = JSON.parse(data).choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta) {
          full += delta
          onDelta(delta)
        }
      } catch {
        // Ignore partial or non-JSON lines.
      }
    }
  }
  return full
}
