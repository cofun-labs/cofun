import { memo, useCallback, useEffect, useId, useState, useSyncExternalStore, type RefObject } from 'react'
import type { QuestionCost, QuestionDetails } from '../agent'
import { track } from '../analytics'
import { chatTitle, replyTitle, savePage, touchedBy, webTouchedBy, type SavedTurn } from '../tools'
import type { ChatSession, ChatSnapshot, Part, Reply, SaveState, Shown, ShownTool } from './chat-session'
import { Icon } from './icons'
import { Markdown } from './Markdown'
import { useMenu } from './menu'
import { HOSTED } from './Model'
import { SentPages } from './Pages'
import { SaveButton } from './Save'
import { ToolCall } from './ToolCall'

/**
 * The open chat's questions and replies. The one part of the panel a streamed reply draws again:
 * it subscribes to the chat, and the rest of the panel only to what it shows of it.
 */
export const MessageList = memo(function MessageList({
  chat,
  saveBlocked,
  onBuyCredits,
  scrollRef,
}: {
  chat: ChatSession
  /** Why a reply can't be saved to Notion now, if it can't. */
  saveBlocked?: string
  onBuyCredits: () => void
  /** The element the list scrolls in. */
  scrollRef: RefObject<HTMLElement | null>
}) {
  const { messages, status, saves } = useSyncExternalStore(chat.subscribe, chat.getSnapshot)
  const busy = status !== 'ready'
  const stopping = status === 'stopping'
  // Only when the conversation changes: closing the session list leaves the chat where the user had scrolled it.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])
  // One function for the chat's life, so a reply that hasn't changed is not drawn again.
  const onSave = useCallback((what: number) => saveToNotion(chat, what), [chat])

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
          <ReplyFoot
            reply={m}
            ended={!(busy && i === messages.length - 1)}
            index={i}
            saveBlocked={saveBlocked}
            replySave={saves[String(i)]}
            onSave={onSave}
          />
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

/** The chat as a save takes it: without a reply still coming in. */
function endedMessages({ messages, status }: ChatSnapshot): readonly Shown[] {
  return status !== 'ready'
    ? messages.slice(
        0,
        messages.findLastIndex((m) => m.role === 'user'),
      )
    : messages
}

/** The questions of the chat that have been answered (or ended otherwise). */
export function askedIn(chat: ChatSnapshot): number {
  return endedMessages(chat).filter((m) => m.role === 'user').length
}

/**
 * Saves of a reply, or of the whole chat, to Notion are the chat's own, by the reply's place in it.
 * The chat's save is also by how many questions it held, so once another question is answered the
 * chat can be saved again, with it.
 */
export function chatSaveKey(chat: ChatSnapshot): string {
  return `chat:${askedIn(chat)}`
}

/**
 * Saves the reply at `what` as a page titled with the chat's title and its question, or with
 * 'chat', the chat so far as a page titled with the chat's title. A reply still coming in is left out.
 */
export function saveToNotion(chat: ChatSession, what: number | 'chat') {
  const now = chat.getSnapshot()
  const heading = chatHeading(now) ?? ''
  if (what === 'chat') {
    const turns = shownTurns(endedMessages(now))
    chat.saveToNotion(chatSaveKey(now), () => savePage(chatTitle(heading), turns))
    return
  }
  const turn = shownTurns(now.messages.slice(0, what + 1)).at(-1)
  if (!turn) return
  chat.saveToNotion(String(what), () => savePage(replyTitle(heading, turn.question), [turn]))
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

/**
 * The row under a reply that has ended: a button to copy what it wrote, what it touched in Notion,
 * and a button for its details. Memoized: a reply that hasn't changed keeps its object, so its calls
 * aren't read again on every render.
 */
const ReplyFoot = memo(function ReplyFoot({
  reply,
  ended,
  index,
  saveBlocked,
  replySave,
  onSave,
}: {
  reply: Reply
  ended: boolean
  index: number
  saveBlocked?: string
  /** How saving this reply to Notion is going. */
  replySave?: SaveState
  onSave: (what: number) => void
}) {
  if (!ended) return null
  const text = replyMarkdown(reply.parts)
  // What it touched in Notion and on the web leads its details, in the "…", so the row stays quiet.
  const details = [...touched(reply).map((text) => ({ text })), ...detailRows(reply.details)]
  const cost = reply.details?.cost
  if (!text && !details.length && !cost) return null
  return (
    <div className="reply-foot">
      {text && <CopyButton text={text} />}
      {text && (
        <SaveButton
          what="reply"
          className="reply-action"
          state={replySave}
          blocked={saveBlocked}
          onSave={() => onSave(index)}
        />
      )}
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

/**
 * What a question touched, one row each, by its calls that worked: in Notion, the distinct pages and
 * databases its tools read and changed; on the web, the pages it read (each read counts), how many
 * of them were rendered, and its searches. A part that is zero is left out; none when it touched nothing.
 */
function touched(reply: Reply): string[] {
  const calls = doneCalls(reply)
  const { read, changed } = touchedBy(calls)
  const { read: web, rendered, searches } = webTouchedBy(calls)
  const rows = [
    [read && `Read ${counted(read, 'Notion page')}`, changed.length && `Changed ${counted(changed.length, 'page')}`],
    [
      web && `Read ${counted(web, 'web page')}${rendered ? ` (${rendered} rendered)` : ''}`,
      searches && `Searched the web ${searches === 1 ? 'once' : `${searches} times`}`,
    ],
  ]
  return rows.map((row) => row.filter(Boolean).join(' · ')).filter(Boolean)
}

/** The questions of `shown` with what their replies wrote and touched, as a saved page holds them. */
function shownTurns(shown: readonly Shown[]): SavedTurn[] {
  const turns: SavedTurn[] = []
  for (const m of shown) {
    if (m.role === 'user') turns.push({ question: m.content, markdown: '', read: 0, changed: [] })
    else if (turns.length) {
      const { question } = turns.pop()!
      turns.push({ question, markdown: replyMarkdown(m.parts), ...touchedBy(doneCalls(m)) })
    }
  }
  return turns
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
  const { requests, tokens: used, model, cost } = details
  return [
    ...(cost && (cost.renders || cost.searches) ? [{ label: 'Credits', text: costSplit(cost) }] : []),
    ...(requests ? [{ text: `Sent ${counted(requests, 'Notion request')}` }] : []),
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
