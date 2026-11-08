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
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error(`Unexpected response from the server: ${(await res.text()).slice(0, 300)}`)
  }

  let full = ''
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    let event: { error?: { message?: string } | string; choices?: { delta?: { content?: unknown } }[] }
    try {
      event = JSON.parse(data)
    } catch {
      return // Not JSON; skip it.
    }
    if (event.error) {
      throw new Error(typeof event.error === 'string' ? event.error : (event.error.message ?? 'The model failed.'))
    }
    const delta = event.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta) {
      full += delta
      onDelta(delta)
    }
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach(handle)
    }
    handle(buffer) // The stream may end without a trailing newline.
    return full
  } catch (err) {
    // Stop reading so the server stops generating.
    await reader.cancel().catch(() => {})
    throw err
  }
}
