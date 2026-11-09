import { useAuth } from '@clerk/chrome-extension'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { CopilotAgent, type AgentUpdate } from '../agent'
import { TOOLS } from '../tools'
import { ToolCall, type ShownTool } from './ToolCall'

const API_URL = import.meta.env.VITE_API_URL as string
// Promise only what the tools can do; widen this when page reading and editing tools land.
const SYSTEM_PROMPT =
  "You are Notion Copilot, an AI assistant that works next to the user's Notion pages. " +
  'Your tools can tell you which Notion page is open (its title and URL); you cannot read or change page content yet. ' +
  'Use the tools when you need to know about the page. Be concise.'

/** A reply in the order it happened: text the model wrote and the tools it ran in between. */
type Part = { type: 'text'; text: string } | { type: 'tool'; tool: ShownTool }

// The agent keeps the conversation it sends to the model; this is only what the panel shows.
type Shown =
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      parts: Part[]
      /** Why the question failed; shown below what the agent already did. */
      error?: string
      stopped?: boolean
      note?: string
    }

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
    setMessages((ms) => [...ms, { role: 'user', content: text }, { role: 'assistant', parts: [] }])
    const updateReply = (fn: (m: Extract<Shown, { role: 'assistant' }>) => Shown) =>
      setMessages((ms) => {
        const last = ms.at(-1)
        if (chatId.current !== id || last?.role !== 'assistant') return ms
        return [...ms.slice(0, -1), fn(last)]
      })

    const updateTools = (fn: (t: ShownTool) => ShownTool) =>
      updateReply((m) => ({ ...m, parts: m.parts.map((p) => (p.type === 'tool' ? { ...p, tool: fn(p.tool) } : p)) }))

    const onUpdate = (u: AgentUpdate) => {
      if (u.type === 'text')
        updateReply((m) => {
          const last = m.parts.at(-1)
          if (last?.type === 'text')
            return { ...m, parts: [...m.parts.slice(0, -1), { ...last, text: last.text + u.delta }] }
          return { ...m, parts: [...m.parts, { type: 'text', text: u.delta }] }
        })
      else if (u.type === 'tool_start')
        updateReply((m) => ({
          ...m,
          parts: [
            ...m.parts,
            { type: 'tool', tool: { id: u.id, name: u.name, args: u.args, status: 'running', result: '' } },
          ],
        }))
      else updateTools((t) => (t.id === u.id ? { ...t, status: u.status, result: u.result } : t))
    }

    try {
      const result = await agent.ask(text, onUpdate)
      if (result.status === 'stopped') {
        updateTools((t) => (t.status === 'running' ? { ...t, status: 'stopped' } : t))
        updateReply((m) => ({ ...m, stopped: true }))
      } else if (result.status === 'error') updateReply((m) => ({ ...m, error: result.message }))
      else if (result.status === 'step_limit')
        updateReply((m) => ({ ...m, note: `Stopped after ${result.steps} steps. Ask again to continue.` }))
    } finally {
      // "New chat" already unlocked the composer for the new conversation.
      if (chatId.current === id) setBusy(false)
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
            setBusy(false)
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
            <div key={i} className="msg assistant">
              {m.parts.map((p, j) =>
                // Models often send blank lines around a tool call; they would show as empty rows.
                p.type === 'text' ? (
                  p.text.trim() && (
                    <div key={j} className="text">
                      {p.text.trim()}
                    </div>
                  )
                ) : (
                  <ToolCall key={p.tool.id} tool={p.tool} />
                ),
              )}
              {m.error && <div className="error">{m.error}</div>}
              {busy && i === messages.length - 1 && waitingForModel(m.parts) && <div className="note">…</div>}
              {m.stopped && <div className="note">Stopped</div>}
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

/** The model is working with nothing to show yet: before its first words, or after its tools finished. */
function waitingForModel(parts: Part[]): boolean {
  const last = parts.at(-1)
  return !last || (last.type === 'tool' && last.tool.status !== 'running')
}
