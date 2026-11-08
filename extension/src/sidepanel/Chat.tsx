import { useAuth } from '@clerk/chrome-extension'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { CopilotAgent, type AgentUpdate } from '../agent'
import { TOOLS } from '../tools'

const API_URL = import.meta.env.VITE_API_URL as string
const SYSTEM_PROMPT =
  'You are Notion Copilot, an AI assistant that helps the user read and edit their Notion pages. ' +
  'Use the tools when you need to know about the page or the browser. Be concise.'

/** A tool the agent ran for this reply. A placeholder until the proper display lands. */
type ShownTool = { id: string; name: string; status: 'running' | 'done' | 'failed' | 'skipped' }

// The agent keeps the conversation it sends to the model; this is only what the panel shows.
type Shown =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tools: ShownTool[]; error?: boolean; stopped?: boolean; note?: string }

const TOOL_MARK: Record<ShownTool['status'], string> = { running: '⋯', done: '✓', failed: '✗', skipped: '–' }

export function Chat() {
  const { getToken } = useAuth()
  const [messages, setMessages] = useState<Shown[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLElement>(null)
  // Bumped by "New chat" so updates still arriving for the old chat are dropped.
  const chatId = useRef(0)
  const tokenRef = useRef(getToken)
  tokenRef.current = getToken
  const agentRef = useRef<CopilotAgent | null>(null)
  agentRef.current ??= new CopilotAgent({
    apiUrl: API_URL,
    getToken: () => tokenRef.current(),
    systemPrompt: SYSTEM_PROMPT,
    tools: TOOLS,
  })
  const agent = agentRef.current

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  // The panel unmounts on sign-out; don't leave a question running tools in the background.
  useEffect(() => () => agentRef.current?.stop(), [])

  async function send() {
    const text = input.trim()
    if (!text || busy) return

    const id = chatId.current
    setInput('')
    setBusy(true)
    setMessages((ms) => [...ms, { role: 'user', content: text }, { role: 'assistant', content: '', tools: [] }])
    const updateReply = (fn: (m: Extract<Shown, { role: 'assistant' }>) => Shown) =>
      setMessages((ms) => {
        const last = ms.at(-1)
        if (chatId.current !== id || last?.role !== 'assistant') return ms
        return [...ms.slice(0, -1), fn(last)]
      })

    const onUpdate = (u: AgentUpdate) => {
      if (u.type === 'text') updateReply((m) => ({ ...m, content: m.content + u.delta }))
      else if (u.type === 'tool_start')
        updateReply((m) => ({ ...m, tools: [...m.tools, { id: u.id, name: u.name, status: 'running' }] }))
      else
        updateReply((m) => ({
          ...m,
          tools: m.tools.map((t) =>
            t.id === u.id ? { ...t, status: u.skipped ? 'skipped' : u.isError ? 'failed' : 'done' } : t,
          ),
        }))
    }

    try {
      const result = await agent.ask(text, onUpdate)
      if (result.status === 'stopped') updateReply((m) => ({ ...m, stopped: true }))
      else if (result.status === 'error') updateReply((m) => ({ ...m, content: result.message, error: true }))
      else if (result.status === 'step_limit')
        updateReply((m) => ({ ...m, note: `Stopped after ${result.steps} steps. Ask again to continue.` }))
    } finally {
      // After "New chat" too: the old question has settled, so the agent is free again.
      setBusy(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) agent.stop()
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
            chatId.current++
            void agent.reset()
            setMessages([])
          }}
        >
          New chat
        </button>
      </div>

      <main id="messages" ref={listRef}>
        {messages.length === 0 && <div className="empty">Ask anything to get started.</div>}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="msg user">
              {m.content}
            </div>
          ) : (
            <div key={i} className={`msg assistant${m.error ? ' error' : ''}`}>
              {m.tools.map((t) => (
                <div key={t.id} className={`tool ${t.status}`}>
                  {TOOL_MARK[t.status]} {t.name}
                </div>
              ))}
              {m.content || (!m.stopped && !m.note && !m.tools.length ? '…' : '')}
              {m.stopped && ' [stopped]'}
              {m.note && <div className="note">{m.note}</div>}
            </div>
          ),
        )}
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
          {busy ? 'Stop' : 'Send'}
        </button>
      </form>
    </>
  )
}
