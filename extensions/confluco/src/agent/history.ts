// The conversation as the model gets it: what stays of a question that failed, what of a long
// conversation is sent (and which of its tool results are left out), and what a question used.
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ToolResultMessage } from '@earendil-works/pi-ai'
import { z } from '../zod'
import { ToolDetails, type QuestionDetails, type TokenUsage } from './types'

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
 * What a long conversation keeps when it is cut: this share of the limits. The cut leaves room to grow,
 * so the part sent keeps the same start for many requests: the provider's prompt cache reuses the
 * start of a request that is the same as before, and a cut changes all of it after the tools.
 */
const KEPT_AFTER_CUT = 0.6

/**
 * The share of the characters the newest questions keep whole after a cut. The questions before them
 * are sent with their tool results left out (see `leftOut`): their questions and replies are short,
 * and the tool results are most of a long conversation, so many more questions fit than whole.
 */
const WHOLE_AFTER_CUT = 0.3

/** A tool result this short is sent whole even where results are left out: a note would save little. */
const SHORT_RESULT = 500

/**
 * Where the part of the conversation sent to the model starts (`from`), and where its tool results
 * start being sent whole (`whole`): each the index of a user message, `from` <= `whole`.
 */
export interface SentPart {
  from: number
  whole: number
}

/**
 * The part of the conversation to send: the leading system message (pi's, with the system prompt and
 * the tools), then everything from `part.from` (where the part sent last time started), with the tool
 * results before `part.whole` left out, while that fits the limits. Once it doesn't, the part is cut:
 * the newest questions that fit WHOLE_AFTER_CUT of the characters are sent whole, and before them, the
 * newest that fit KEPT_AFTER_CUT of the limits with their tool results left out. The character budget
 * also pays for the tool definitions (`overhead`). Both indexes are at a user message, so a reply or
 * tool result is never sent without what led to it. The newest question is always kept whole; if it
 * alone is too long, the worker says so.
 *
 * Between cuts the start of what is sent stays the same, so the prompt cache reuses it.
 *
 * pi would record a change of the tools in a later system message, which a cut could drop; the tools
 * never change (see `allTools` in agent.ts), so there is none.
 */
export function recent(
  messages: AgentMessage[],
  limits: { messages: number; chars: number },
  overhead: number,
  part: SentPart = { from: 0, whole: 0 },
): { sent: AgentMessage[] } & SentPart {
  let head = 0
  while (head < messages.length && messages[head].role === 'system') head++
  const fixed = overhead + messages.slice(0, head).reduce((n, m) => n + size(m), 0)
  const isQuestion = (i: number) => i >= head && messages[i]?.role === 'user'
  // An index that is no longer a question (the conversation lost the messages after a failed one) is
  // worked out again.
  let from = isQuestion(part.from) ? part.from : head
  let whole = isQuestion(part.whole) && part.whole >= from ? part.whole : from
  const sizes = (whole: number) => messages.map((m, i) => size(i < whole ? leftOut(m) : m))
  const fits =
    messages.length - from <= limits.messages &&
    sizes(whole)
      .slice(from)
      .reduce((n, s) => n + s, fixed) <= limits.chars
  if (!fits) {
    const count = limits.messages * KEPT_AFTER_CUT
    whole = newestThatFits(sizes(head), head, count, fixed, limits.chars * WHOLE_AFTER_CUT, messages)
    // At `whole` or before it: what comes from there is the same as above, within a smaller budget.
    from = newestThatFits(sizes(whole), head, count, fixed, limits.chars * KEPT_AFTER_CUT, messages)
  }
  const kept = messages.slice(from).map((m, i) => (from + i < whole ? leftOut(m) : m))
  return { sent: [...messages.slice(0, head), ...kept], from, whole }
}

/**
 * A message as it is sent before the part of a cut conversation sent whole: a tool result longer
 * than SHORT_RESULT is replaced by a note that says how to read it again; anything else is as it is.
 * The note depends only on the result, so the same result gives the same note in every request.
 */
function leftOut(message: AgentMessage): AgentMessage {
  if (message.role !== 'toolResult') return message
  const chars = size(message)
  if (chars <= SHORT_RESULT && message.content.every((block) => block.type === 'text')) return message
  const id = ToolDetails.safeParse(message.details).data?.result
  const again = id
    ? `It is kept as result ${id}: read it with read_result, or find text in it with search_result.`
    : 'If the question needs it, run the tool again.'
  const text = `[Left out to keep the conversation short: this result had ${chars.toLocaleString('en-US')} characters. ${again}]`
  return { ...message, content: [{ type: 'text', text }] }
}

/**
 * Where the newest part of the conversation after `head` that fits `count` messages and `chars`
 * characters (with `fixed` already counted, and each message counted at `sizes`) starts: at a user
 * message, the newest one when even that doesn't fit.
 */
function newestThatFits(
  sizes: number[],
  head: number,
  count: number,
  fixed: number,
  chars: number,
  messages: AgentMessage[],
): number {
  let start = -1
  let used = fixed
  for (let i = sizes.length - 1; i >= head; i--) {
    used += sizes[i]
    const over = sizes.length - i > count || used > chars
    if (messages[i].role !== 'user') continue
    if (start !== -1 && over) break
    start = i
  }
  return start === -1 ? head : start
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
 * The token counts pi read from a model reply. They come from the service (the worker, or
 * OpenRouter), so they are checked like any value from outside.
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
