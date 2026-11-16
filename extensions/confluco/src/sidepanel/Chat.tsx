import { useAuth } from '@clerk/chrome-extension'
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { AccountMenu } from './Account'
import { ConfluenceConnection } from './ConfluenceConnection'
import { CreditsPage } from './Credits'
import { Header, Page } from './Header'
import { Markdown } from './Markdown'
import { Panel } from './panel'
import { ToolCall } from './ToolCall'
import type { ChatSession } from './chat-session'

export function Chat({ userId }: { userId: string }) {
  const { getToken } = useAuth()
  const token = useRef(getToken)
  token.current = getToken
  const [panel] = useState(() => new Panel(userId, () => token.current()))
  const { chat, credits } = useSyncExternalStore(panel.subscribe, panel.getSnapshot)
  const [page, setPage] = useState<'connection' | 'credits'>()
  const accountButton = useRef<HTMLButtonElement>(null)
  const connectionButton = useRef<HTMLButtonElement>(null)
  useEffect(() => panel.connect(), [panel])

  function back() {
    const button = page === 'connection' ? connectionButton : accountButton
    setPage(undefined)
    requestAnimationFrame(() => button.current?.focus())
  }

  return (
    <>
      <Header title="Confluco" inert={page !== undefined}>
        <button ref={connectionButton} className="secondary" onClick={() => setPage('connection')}>
          Connect Confluence
        </button>
        <button className="secondary" onClick={() => panel.newChat()}>
          New chat
        </button>
        <AccountMenu
          credits={credits}
          buttonRef={accountButton}
          onOpen={() => void panel.readCredits()}
          onCredits={() => {
            setPage('credits')
            void panel.readCredits()
          }}
        />
      </Header>
      <Conversation key={chat.id} chat={chat} hidden={page !== undefined} onCredits={() => setPage('credits')} />
      {page === 'connection' && (
        <Page id="confluence-connection" title="Connect Confluence" onBack={back}>
          <ConfluenceConnection userId={userId} onClose={back} />
        </Page>
      )}
      {page === 'credits' && (
        <CreditsPage
          credits={credits}
          onClose={back}
          grants={() => panel.creditGrants()}
          buying={{ packs: () => panel.creditPacks(), buy: (quantity) => panel.buyCredits(quantity) }}
        />
      )}
    </>
  )
}

function Conversation({ chat, hidden, onCredits }: { chat: ChatSession; hidden: boolean; onCredits: () => void }) {
  const { messages, status } = useSyncExternalStore(chat.subscribe, chat.getSnapshot)
  const [text, setText] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const busy = status !== 'ready'
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight
  }, [messages, hidden])

  function send(event: FormEvent) {
    event.preventDefault()
    if (busy || !text.trim()) return
    void chat.ask(text.trim())
    setText('')
  }

  return (
    <div className="chat" inert={hidden}>
      <div id="messages" ref={list} role="log" aria-label="Conversation">
        {messages.map((message, index) =>
          message.role === 'user' ? (
            <div key={index} className="msg user">
              <div className="question">{message.content}</div>
              {message.page && <div className="note">{message.page.title}</div>}
            </div>
          ) : (
            <div key={index} className="msg assistant reply">
              {message.parts.map((part, partIndex) =>
                part.type === 'text' ? (
                  <div className="text" key={partIndex}>
                    <Markdown text={part.text} />
                  </div>
                ) : (
                  <ToolCall key={partIndex} tool={part.tool} onAnswer={(allow) => chat.answer(part.tool.id, allow)} />
                ),
              )}
              {message.error && (
                <p role="alert" className="error">
                  {message.error}
                </p>
              )}
              {message.outOfCredits && (
                <button className="link" onClick={onCredits}>
                  See credits
                </button>
              )}
              {message.stopped && <p className="note">Stopped</p>}
              {message.note && <p className="note">{message.note}</p>}
              {message.details?.cost && (
                <p className="note">
                  {(message.details.cost.microCredits / 1_000_000).toLocaleString('en-US')} credits
                </p>
              )}
            </div>
          ),
        )}
      </div>
      <form id="composer" onSubmit={send}>
        <textarea
          aria-label="Message"
          placeholder="Ask about this Confluence page"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
        <div className="composer-actions">
          {busy ? (
            <button type="button" className="primary" disabled={status === 'stopping'} onClick={() => chat.stop()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary" disabled={!text.trim()}>
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
