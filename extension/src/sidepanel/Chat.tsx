import { useAuth } from '@clerk/chrome-extension'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { streamChat, type ChatMessage } from '../llm'

const API_URL = import.meta.env.VITE_API_URL as string
const SYSTEM_PROMPT =
  'You are Copilot, an AI assistant that helps the user read and edit their Notion pages. Be concise.'

type Shown = ChatMessage & { error?: boolean }

export function Chat() {
  const { getToken } = useAuth()
  const [messages, setMessages] = useState<Shown[]>([])
  const [input, setInput] = useState('')
  const [controller, setController] = useState<AbortController | null>(null)
  const listRef = useRef<HTMLElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  async function send() {
    const text = input.trim()
    if (!text || controller) return

    const history = messages.filter((m) => !m.error)
    const user: ChatMessage = { role: 'user', content: text }
    setInput('')
    setMessages([...messages, user, { role: 'assistant', content: '' }])

    const ctrl = new AbortController()
    setController(ctrl)
    const updateLast = (fn: (m: Shown) => Shown) => setMessages((ms) => [...ms.slice(0, -1), fn(ms[ms.length - 1])])

    try {
      await streamChat(
        { apiUrl: API_URL, getToken: () => getToken() },
        [{ role: 'system', content: SYSTEM_PROMPT }, ...history, user],
        (delta) => updateLast((m) => ({ ...m, content: m.content + delta })),
        ctrl.signal,
      )
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        updateLast((m) => ({ ...m, content: m.content + ' [stopped]' }))
      } else {
        updateLast((m) => ({ ...m, content: (err as Error).message, error: true }))
      }
    } finally {
      setController(null)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (controller) controller.abort()
    else send()
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  return (
    <>
      <div className="toolbar">
        <button
          onClick={() => {
            controller?.abort()
            setMessages([])
          }}
        >
          New chat
        </button>
      </div>

      <main id="messages" ref={listRef}>
        {messages.length === 0 && <div className="empty">Ask anything to get started.</div>}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}${m.error ? ' error' : ''}`}>
            {m.content || (m.role === 'assistant' ? '…' : '')}
          </div>
        ))}
      </main>

      <form id="composer" onSubmit={onSubmit}>
        <textarea
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask something… (Enter to send, Shift+Enter for newline)"
        />
        <button className="primary" type="submit">
          {controller ? 'Stop' : 'Send'}
        </button>
      </form>
    </>
  )
}
