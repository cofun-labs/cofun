import { useAuth } from '@clerk/chrome-extension'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { CopilotAgent, type AgentUpdate, type ConfirmTool } from '../agent'
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
  // Stop was pressed; the question is still winding down, so nothing is pending any more.
  const [stopping, setStopping] = useState(false)
  const listRef = useRef<HTMLElement>(null)
  // Answers for tool calls waiting for the user's OK, by call id.
  const pending = useRef(new Map<string, (allow: boolean) => void>())
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
    setStopping(false)
    setMessages((ms) => [...ms, { role: 'user', content: text }, { role: 'assistant', parts: [] }])
    const updateReply = (fn: (m: Extract<Shown, { role: 'assistant' }>) => Shown) =>
      setMessages((ms) => {
        const last = ms.at(-1)
        if (chatId.current !== id || last?.role !== 'assistant') return ms
        return [...ms.slice(0, -1), fn(last)]
      })

    const updateTools = (fn: (t: ShownTool) => ShownTool) =>
      updateReply((m) => ({ ...m, parts: m.parts.map((p) => (p.type === 'tool' ? { ...p, tool: fn(p.tool) } : p)) }))

    const setToolStatus = (toolId: string, status: ShownTool['status']) =>
      updateReply((m) => {
        const j = newestOpenCall(m.parts, toolId)
        if (j < 0) return m
        const part = m.parts[j] as Extract<Part, { type: 'tool' }>
        const parts = [...m.parts]
        parts[j] = { ...part, tool: { ...part.tool, status } }
        return { ...m, parts }
      })

    // Calls this question asked about, so their answers can be dropped when it ends.
    const asked = new Map<string, (allow: boolean) => void>()
    const confirm: ConfirmTool = (call) =>
      new Promise((resolve) => {
        if (chatId.current !== id) return resolve(false)
        const answer = (allow: boolean) => {
          pending.current.delete(call.id)
          // Running again until the agent reports how the call ended (done, or declined).
          setToolStatus(call.id, 'running')
          resolve(allow)
        }
        asked.set(call.id, answer)
        pending.current.set(call.id, answer)
        // Normally the call is already shown as running. If not, show it now: the agent must never
        // wait on a prompt nobody can see. Show the arguments the tool will run with.
        updateReply((m) => {
          const j = newestOpenCall(m.parts, call.id)
          const parts = [...m.parts]
          const tool: ShownTool = { id: call.id, name: call.name, args: call.args, status: 'confirm', result: '' }
          if (j < 0) parts.push({ type: 'tool', tool })
          else
            parts[j] = {
              type: 'tool',
              tool: { ...(parts[j] as Extract<Part, { type: 'tool' }>).tool, args: call.args, status: 'confirm' },
            }
          return { ...m, parts }
        })
      })

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
      else
        updateReply((m) => {
          const j = newestOpenCall(m.parts, u.id)
          if (j < 0) return m
          const part = m.parts[j] as Extract<Part, { type: 'tool' }>
          const parts = [...m.parts]
          parts[j] = { ...part, tool: { ...part.tool, status: u.status, result: u.result } }
          return { ...m, parts }
        })
    }

    try {
      const result = await agent.ask(text, onUpdate, confirm)
      if (result.status === 'stopped') {
        updateTools((t) => (t.status === 'running' || t.status === 'confirm' ? { ...t, status: 'stopped' } : t))
        updateReply((m) => ({ ...m, stopped: true }))
      } else if (result.status === 'error') updateReply((m) => ({ ...m, error: result.message }))
      else if (result.status === 'step_limit')
        updateReply((m) => ({ ...m, note: `Stopped after ${result.steps} steps. Ask again to continue.` }))
    } finally {
      // A question can end without the panel answering, e.g. on unmount.
      // Only this question's own answers: after a New chat, the next question may reuse an id.
      for (const [callId, answer] of asked) if (pending.current.get(callId) === answer) pending.current.delete(callId)
      // "New chat" already unlocked the composer for the new conversation.
      if (chatId.current === id) setBusy(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) {
      setStopping(true)
      declineAll()
      agent.stop()
    } else send()
  }

  /** Stop or a new chat answers every open question with no. */
  function declineAll() {
    for (const answer of [...pending.current.values()]) answer(false)
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
            declineAll()
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
                  // Parts are only appended, so the index is a stable key; tool ids may repeat.
                  <ToolCall
                    key={j}
                    tool={p.tool}
                    onAnswer={p.tool.status === 'confirm' ? pending.current.get(p.tool.id) : undefined}
                  />
                ),
              )}
              {m.error && <div className="error">{m.error}</div>}
              {busy && !stopping && i === messages.length - 1 && waitingForModel(m.parts) && (
                <div className="note">…</div>
              )}
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
  // Blank text is not shown, so it does not count as something on screen.
  let k = parts.length - 1
  while (k >= 0 && parts[k].type === 'text' && !(parts[k] as { text: string }).text.trim()) k--
  const last = parts[k]
  // A running tool shows its own mark, and one waiting for the user shows its prompt.
  return !last || (last.type === 'tool' && last.tool.status !== 'running' && last.tool.status !== 'confirm')
}

/**
 * The index of the newest call with this id that has not ended, or -1. Ids are unique only within
 * one model reply, so a later step may reuse one.
 */
function newestOpenCall(parts: Part[], id: string): number {
  let j = parts.length - 1
  while (j >= 0) {
    const p = parts[j]
    if (p.type === 'tool' && p.tool.id === id && (p.tool.status === 'running' || p.tool.status === 'confirm')) break
    j--
  }
  return j
}
