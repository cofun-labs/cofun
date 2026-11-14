// The conversation as the model gets it: what stays of a question that failed, what of a long
// conversation is sent, and what a question used.
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ToolResultMessage } from '@earendil-works/pi-ai'
import { z } from '../zod'
import type { QuestionDetails, TokenUsage } from './types'

/**
 * What stays of a question that failed or was stopped (`tail`: its messages, starting with the
 * question): the question and each step's tool calls that ended, with their results, so every call
 * kept is still answered right after its message. A step's calls without a result are left out:
 * after a Stop, pi skips the calls that come after the one running. The reply that failed or was cut
 * off is left out with everything after it. Empty when the question used no tool.
 */
export function usedTools(tail: AgentMessage[]): AgentMessage[] {
  // The question, with anything pi put before it.
  const start = tail.findIndex((m) => m.role === 'user') + 1
  const question = tail.slice(0, start)
  const rest = tail.slice(start)
  const kept: AgentMessage[] = []
  for (let i = 0; i < rest.length;) {
    const reply = rest[i]
    if (reply.role !== 'assistant' || reply.stopReason === 'error' || reply.stopReason === 'aborted') break
    let next = i + 1
    while (next < rest.length && rest[next].role === 'toolResult') next++
    const results = rest.slice(i + 1, next) as ToolResultMessage[]
    const answered = new Set(results.map((r) => r.toolCallId))
    const content = reply.content.filter((block) => block.type !== 'toolCall' || answered.has(block.id))
    if (!content.some((block) => block.type === 'toolCall')) break
    kept.push({ ...reply, content }, ...results)
    i = next
  }
  return kept.length ? [...question, ...kept] : []
}

/**
 * The leading system messages plus the newest part of the conversation that fits the limits.
 * The character budget also pays for the system prompt and the tool definitions (`overhead`).
 * It starts at a user message, so a reply or tool result is never sent without what led to it.
 * The newest question is always kept; if it alone is too long, the worker says so.
 *
 * System messages in the part left out are kept too: pi records there which tools were added and
 * removed (a question in Read only offers fewer), and the tools offered now are worked out from all
 * of them. They carry no text of their own here, so they cost nothing to send.
 */
export function recent(
  messages: AgentMessage[],
  limits: { messages: number; chars: number },
  overhead: number,
): AgentMessage[] {
  let head = 0
  while (head < messages.length && messages[head].role === 'system') head++
  const rest = messages.slice(head)
  let start = rest.length
  let chars = overhead + messages.slice(0, head).reduce((n, m) => n + size(m), 0)
  for (let i = rest.length - 1; i >= 0 && rest.length - i <= limits.messages; i--) {
    chars += size(rest[i])
    if (chars > limits.chars) break
    if (rest[i].role === 'user') start = i
  }
  if (start === rest.length) {
    for (start = rest.length - 1; start > 0 && rest[start].role !== 'user'; start--);
  }
  const changes = rest.slice(0, start).filter((m) => m.role === 'system')
  return [...messages.slice(0, head), ...changes, ...rest.slice(start)]
}

/** Characters a message adds to a request: its text, tool calls, and tool results. */
function size(message: AgentMessage): number {
  if (!('content' in message)) return 0
  const { content } = message
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const block of content) {
    if (block.type === 'text') n += block.text.length
    else if (block.type === 'toolCall') n += block.name.length + JSON.stringify(block.arguments).length
  }
  return n
}

/** The parts of these details that are known, without keys for the others. */
export function detailsOf({ requests, tokens, model, cost }: QuestionDetails): QuestionDetails {
  return {
    ...(requests !== undefined && { requests }),
    ...(tokens && { tokens }),
    ...(model && { model }),
    ...(cost && { cost }),
  }
}

const tokenCount = z.number().int().nonnegative()

/**
 * The token counts pi read from a model reply. They come from the service (the worker, OpenRouter,
 * DeepSeek), so they are checked like any value from outside.
 */
const ReportedUsage = z.object({ input: tokenCount, output: tokenCount, cacheRead: tokenCount, cacheWrite: tokenCount })

/**
 * `total` with what one model reply used added. pi gives `input` without the cached part, and
 * leaves every count 0 for a reply that reported none; counts that don't check out add nothing.
 */
export function addUsage(total: TokenUsage | undefined, usage: unknown): TokenUsage | undefined {
  const reported = ReportedUsage.safeParse(usage)
  if (!reported.success) return total
  const { input, output, cacheRead, cacheWrite } = reported.data
  if (!input && !output && !cacheRead && !cacheWrite) return total
  const sum = total ?? { input: 0, output: 0, cached: 0 }
  return {
    input: sum.input + input + cacheRead + cacheWrite,
    output: sum.output + output,
    cached: sum.cached + cacheRead,
  }
}

/** The text of a message's content: a string, or text blocks among others. */
export function textOf(content: string | { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content
  return content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n')
}
