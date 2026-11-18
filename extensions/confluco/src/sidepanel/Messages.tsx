import { memo, useEffect, useId, useState, useSyncExternalStore, type RefObject } from 'react'
import type { QuestionCost, QuestionDetails } from '@cofun/agent'
import { track } from '../analytics'
import { webTouchedBy } from '../tools'
import type { ChatSession, ChatSnapshot, Part, Reply, ShownTool } from './chat-session'
import { Icon } from './icons'
import { Markdown } from './Markdown'
import { useMenu } from './menu'
import { HOSTED } from './Model'
import { SentPages } from './Pages'
import { ToolCall } from './ToolCall'

/**
 * The open chat's questions and replies. The one part of the panel a streamed reply draws again:
 * it subscribes to the chat, and the rest of the panel only to what it shows of it.
 */
export const MessageList = memo(function MessageList({
  chat,
  onBuyCredits,
  scrollRef,
}: {
  chat: ChatSession
  onBuyCredits: () => void
  /** The element the list scrolls in. */
  scrollRef: RefObject<HTMLElement | null>
}) {
  const { messages, status } = useSyncExternalStore(chat.subscribe, chat.getSnapshot)
  const busy = status !== 'ready'
  const stopping = status === 'stopping'
  // Only when the conversation changes: closing the session list leaves the chat where the user had scrolled it.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  return messages.map((m, i) =>
    m.role === 'user' ? (
      <div key={i} className="msg user">
        {m.content}
        <SentPages pages={m.pages} selections={m.selections} />
        {m.readOnly && (
          <p className="question-mode">
            <Icon name="eye" />
            Read only
          </p>
        )}
      </div>
    ) : (
      <div key={i} className="msg assistant">
        <div className="reply">
          {m.parts.map((p, j) =>
            // Models often send blank lines around a tool call; they would show as empty rows.
            p.type === 'text' ? (
              p.text.trim() && (
                <div key={j} className="text">
                  <Markdown text={p.text.trim()} />
                </div>
              )
            ) : (
              // Parts are only appended, so the index is a stable key; tool ids may repeat.
              <ToolCall
                key={j}
                tool={p.tool}
                onAnswer={p.tool.status === 'confirm' ? (allow) => chat.answer(p.tool.id, allow) : undefined}
              />
            ),
          )}
          {m.error && (
            <div className="error">
              {m.error}
              {m.outOfCredits && (
                <>
                  {' '}
                  <button type="button" className="link" onClick={onBuyCredits}>
                    Buy credits
                  </button>
                </>
              )}
            </div>
          )}
          {busy && !stopping && i === messages.length - 1 && waitingForModel(m.parts) && (
            <div className="note working">…</div>
          )}
          {m.stopped && <div className="note">Stopped</div>}
          {m.note && <div className="note">{m.note}</div>}
          {m.copied && (
            <div className="note">
              This chat was also continued in another window, so this one is saved as a separate chat.
            </div>
          )}
          <ReplyFoot reply={m} ended={!(busy && i === messages.length - 1)} />
        </div>
      </div>
    ),
  )
})

/** The model's title for the chat, or until it has one its first question, on one line. */
export function chatHeading({ title, messages }: ChatSnapshot): string | undefined {
  return (
    title ??
    messages
      .find((m) => m.role === 'user')
      ?.content.replace(/\s+/g, ' ')
      .trim()
  )
}

/** The model is working with nothing to show yet: before its first words, or after its tools finished. */
function waitingForModel(parts: Part[]): boolean {
  // Blank text is not shown, so it does not count as something on screen.
  let k = parts.length - 1
  while (k >= 0 && parts[k].type === 'text' && !(parts[k] as { text: string }).text.trim()) k--
  const last = parts[k]
  // A running tool shows its own mark, and one waiting for the user shows its prompt.
  return !last || (last.type === 'tool' && last.tool.status !== 'running' && last.tool.status !== 'confirm')
}

/** What a reply wrote, as the Markdown the model sent: its text parts, without the tools run between them. */
function replyMarkdown(parts: Part[]): string {
  return parts.flatMap((p) => (p.type === 'text' && p.text.trim() ? [p.text.trim()] : [])).join('\n\n')
}

/** The row under an ended reply, with copy, cost, and details. */
const ReplyFoot = memo(function ReplyFoot({ reply, ended }: { reply: Reply; ended: boolean }) {
  if (!ended) return null
  const text = replyMarkdown(reply.parts)
  const details = [...touched(reply).map((text) => ({ text })), ...detailRows(reply.details)]
  const cost = reply.details?.cost
  if (!text && !details.length && !cost) return null
  return (
    <div className="reply-foot">
      {text && <CopyButton text={text} />}
      {cost && <CostNote cost={cost} />}
      {details.length > 0 && <ReplyDetails rows={details} />}
    </div>
  )
})

/** Copies `text` to the clipboard, and says for a moment whether it worked. */
function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [state])

  const label = state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : 'Copy reply'
  return (
    <>
      <button
        type="button"
        className="reply-action"
        aria-label={label}
        data-tip={label}
        onClick={() =>
          navigator.clipboard.writeText(text).then(
            () => {
              track({ event: 'reply_copied' })
              setState('copied')
            },
            () => setState('failed'),
          )
        }
      >
        <Icon name={state === 'copied' ? 'check' : 'copy'} />
      </button>
      {/* Read out when it changes: the button's own name is not announced again while it has focus. */}
      <span className="sr-only" role="status">
        {state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy the reply" : ''}
      </span>
    </>
  )
}

const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/**
 * Micro-credits as credits, short: to two significant digits below one credit ("0.48") and one
 * decimal above.
 */
function creditsOf(microCredits: number): string {
  const credits = microCredits / 1_000_000
  const digits = credits < 1 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 1 }
  return credits.toLocaleString('en-US', digits)
}

/** What a reply cost in credits, as the worker charged it (see creditsOf). */
function CostNote({ cost }: { cost: QuestionCost }) {
  const shown = creditsOf(cost.microCredits)
  return (
    <span className="note reply-cost" data-tip="What this reply cost">
      {shown} {shown === '1' ? 'credit' : 'credits'}
    </span>
  )
}

/** What the completed tools read or searched on the web. */
function touched(reply: Reply): string[] {
  const { read, rendered, searches } = webTouchedBy(doneCalls(reply))
  const row = [
    read && `Read ${counted(read, 'web page')}${rendered ? ` (${rendered} rendered)` : ''}`,
    searches && `Searched the web ${searches === 1 ? 'once' : `${searches} times`}`,
  ]
    .filter(Boolean)
    .join(' · ')
  return row ? [row] : []
}

/** A reply's tool calls that worked. */
function doneCalls(reply: Reply): ShownTool[] {
  return reply.parts.flatMap((p) => (p.type === 'tool' && p.tool.status === 'done' ? [p.tool] : []))
}

/** A count of tokens, short: 196, 12.4k, 1.2M. */
function amount(n: number): string {
  const short = (value: number, unit: string) => `${Number(value.toFixed(1))}${unit}`
  return n < 1000 ? String(n) : n < 999_950 ? short(n / 1000, 'k') : short(n / 1_000_000, 'M')
}

/** A reply's details, one row each, with what is unknown (or none) left out. */
function detailRows(details: QuestionDetails = {}): { label?: string; text: string }[] {
  const { tokens: used, model, cost } = details
  return [
    ...(cost && (cost.renders || cost.searches) ? [{ label: 'Credits', text: costSplit(cost) }] : []),
    // The model that answered, next to the tokens it used.
    ...(model ? [{ label: 'Model', text: model.service === 'hosted' ? HOSTED : model.name }] : []),
    ...(used
      ? [
          {
            label: 'Tokens',
            text:
              `${amount(used.input)} in` +
              (used.cached ? ` (${amount(used.cached)} cached)` : '') +
              ` · ${amount(used.output)} out`,
          },
        ]
      : []),
  ]
}

/**
 * What a reply's credits went to, when some went to renders or searches: the model (what is left;
 * none for a user's own model), then those, each one left out when it is zero.
 */
function costSplit({ microCredits, renders = 0, searches = 0 }: QuestionCost): string {
  const model = microCredits - renders - searches
  return [
    model > 0 && `model ${creditsOf(model)}`,
    renders && `renders ${creditsOf(renders)}`,
    searches && `searches ${creditsOf(searches)}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The "…" button at the end of a reply's row, and the popover with its details it opens and closes. */
function ReplyDetails({ rows }: { rows: { label?: string; text: string }[] }) {
  const { open, setOpen, rootRef, onKeyDown } = useMenu()
  const id = useId()
  return (
    <div className="reply-details" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="reply-action"
        aria-label="Reply details"
        data-tip="Reply details"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name="dots" />
      </button>
      {open && (
        <div id={id} className="reply-popover" role="dialog" aria-label="Reply details">
          <div className="reply-facts">
            {rows.map(({ label, text }) => (
              <p key={label ?? text}>
                {label && <span className="detail-label">{label}: </span>}
                {text}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
