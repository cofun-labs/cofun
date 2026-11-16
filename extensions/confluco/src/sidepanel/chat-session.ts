// Notico's subscribed per-chat state, wired to the Confluence tab and tool previews.
import {
  CopilotAgent,
  type AgentConfig,
  type AgentUpdate,
  type ConfirmTool,
  type QuestionDetails,
  type ToolDetails,
  type ToolStatus,
} from '../agent'
import { getInstance } from '../confluence/instance'
import { activeTab, openPageNote, tabPage } from '../confluence/page'
import { requestedPageEdit } from '../confluence/page-writes'
import { confluenceTab } from '../confluence/tab'
import { createTools, type WorkspaceQuestion } from '../tools'

/** A tool call as the panel shows it. */
export interface ShownTool {
  id: string
  name: string
  args: unknown
  /** `confirm`: waiting for the user to allow or deny it. */
  status: 'running' | 'confirm' | ToolStatus
  /** What the model got back, or the error. Empty while running. */
  result: string
  /** What the tool said about the call for the panel, once it ended (see ToolDetails). */
  details?: ToolDetails
  /** What the call changes, in words, as the tool saw things before it ran. */
  preview?: string
}

/** A reply in the order it happened: text the model wrote and the tools it ran in between. */
type Part = { type: 'text'; text: string } | { type: 'tool'; tool: ShownTool }

// The agent keeps the conversation it sends to the model; this is only what the panel shows.
type Shown =
  | { role: 'user'; content: string; page?: { title: string; url: string } }
  | {
      role: 'assistant'
      parts: Part[]
      /** Why the question failed; shown below what the agent already did. */
      error?: string
      /** The question was refused for lack of credits: the error leads to the Credits page. */
      outOfCredits?: boolean
      stopped?: boolean
      note?: string
      /** What the question used, once it ended. */
      details?: QuestionDetails
    }

export type Reply = Extract<Shown, { role: 'assistant' }>

interface ChatSnapshot {
  messages: readonly Shown[]
  status: 'ready' | 'asking' | 'stopping'
}

export class ChatSession {
  private snapshot: ChatSnapshot = { messages: [], status: 'ready' }
  private readonly listeners = new Set<() => void>()
  private readonly agent: CopilotAgent
  readonly id = crypto.randomUUID()
  private readonly answers = new Map<string, (allow: boolean) => void>()
  private question?: AbortController
  private workspace: WorkspaceQuestion = {}

  constructor(
    private readonly userId: string,
    config: Omit<AgentConfig, 'tools'>,
    private readonly spent: () => void,
  ) {
    this.agent = new CopilotAgent({ ...config, tools: createTools(userId, () => this.workspace) })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ChatSnapshot => this.snapshot

  async ask(text: string): Promise<void> {
    if (this.question) return
    const controller = new AbortController()
    this.question = controller
    const { signal } = controller
    this.update({
      status: 'asking',
      messages: [...this.snapshot.messages, { role: 'user', content: text }, { role: 'assistant', parts: [] }],
    })

    let approvedEdit = false
    const confirm: ConfirmTool = (call) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve(false)
        const tool: ShownTool = { ...call, status: 'confirm', result: '' }
        this.answers.set(call.id, (allow) => {
          if (allow && call.name === 'edit_page') approvedEdit = true
          this.answers.delete(call.id)
          this.updateTool(call.id, (pending) => ({ ...pending, status: 'running' }))
          resolve(allow)
        })
        this.updateReply((m) => {
          const index = newestOpenCall(m.parts, call.id)
          const part: Part = { type: 'tool', tool }
          if (index < 0) return { ...m, parts: [...m.parts, part] }
          return { ...m, parts: m.parts.map((previous, i) => (i === index ? part : previous)) }
        })
      })

    const onUpdate = (u: AgentUpdate) => {
      if (u.type === 'text')
        this.updateReply((m) => {
          const last = m.parts.at(-1)
          if (last?.type === 'text')
            return { ...m, parts: [...m.parts.slice(0, -1), { ...last, text: last.text + u.delta }] }
          return { ...m, parts: [...m.parts, { type: 'text', text: u.delta }] }
        })
      else if (u.type === 'tool_start')
        this.updateReply((m) => {
          // A prompt shown before the start event already stands for this call; don't show it twice.
          const j = newestOpenCall(m.parts, u.id)
          if (j >= 0 && (m.parts[j] as Extract<Part, { type: 'tool' }>).tool.status === 'confirm') return m
          const tool: ShownTool = { id: u.id, name: u.name, args: u.args, status: 'running', result: '' }
          return { ...m, parts: [...m.parts, { type: 'tool', tool }] }
        })
      else if (u.type === 'tool_ready') this.updateTool(u.id, (tool) => ({ ...tool, args: u.args, preview: u.preview }))
      else this.updateTool(u.id, (tool) => ({ ...tool, status: u.status, result: u.result, details: u.details }))
    }

    try {
      const [tab, instance] = await Promise.all([activeTab(), getInstance(this.userId)])
      if (signal.aborted) return
      const target = confluenceTab(tab, instance)
      const page = target ? tabPage(tab) : undefined
      this.workspace = { tab: target, edit: requestedPageEdit(text) }
      if (page) {
        const question = this.snapshot.messages.length - 2
        this.update({
          messages: this.snapshot.messages.map((m, i) => (i === question && m.role === 'user' ? { ...m, page } : m)),
        })
      }
      const result = await this.agent.ask(
        text,
        onUpdate,
        confirm,
        { context: openPageNote(page), chat: this.id },
        { signal },
      )
      const { tokens, model, cost } = result
      this.updateReply((m) => ({ ...m, details: { tokens, model, cost } }))
      if (result.status === 'stopped') this.showStopped(approvedEdit)
      else if (result.status === 'error')
        this.updateReply((m) => ({ ...m, error: result.message, outOfCredits: result.code === 'out_of_credits' }))
      else if (result.status === 'step_limit')
        this.updateReply((m) => ({ ...m, note: `Stopped after ${result.steps} steps. Ask again to continue.` }))
    } catch {
      this.updateReply((m) => ({
        ...m,
        error: 'Could not prepare the Confluence question. Check the active tab and try again.',
      }))
    } finally {
      if (signal.aborted) this.showStopped(approvedEdit)
      this.answers.clear()
      this.question = undefined
      this.workspace = {}
      this.update({ status: 'ready' })
      this.spent()
    }
  }

  stop(): void {
    if (!this.question) return
    this.update({ status: 'stopping' })
    this.question.abort()
    for (const answer of this.answers.values()) answer(false)
  }

  answer(id: string, allow: boolean): void {
    if (!this.question?.signal.aborted) this.answers.get(id)?.(allow)
  }

  private showStopped(approvedEdit: boolean): void {
    this.updateReply((m) => ({
      ...m,
      parts: m.parts.map((p) =>
        p.type === 'tool' && (p.tool.status === 'running' || p.tool.status === 'confirm')
          ? { ...p, tool: { ...p.tool, status: 'stopped' } }
          : p,
      ),
      stopped: true,
      ...(approvedEdit && {
        note: 'The edit may already have been applied. Check the Confluence page before asking again.',
      }),
    }))
  }

  private update(change: Partial<ChatSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change }
    for (const listener of this.listeners) listener()
  }

  /** Changes the reply being written, the last message; `fn` returns it as it was to change nothing. */
  private updateReply(fn: (m: Reply) => Reply) {
    const messages = this.snapshot.messages
    const last = messages.at(-1)
    if (last?.role !== 'assistant') return
    const next = fn(last)
    if (next !== last) this.update({ messages: [...messages.slice(0, -1), next] })
  }

  /** Changes the newest call with this id that has not ended, if there is one. */
  private updateTool(id: string, fn: (tool: ShownTool) => ShownTool) {
    this.updateReply((m) => {
      const j = newestOpenCall(m.parts, id)
      if (j < 0) return m
      const part = m.parts[j] as Extract<Part, { type: 'tool' }>
      const parts = [...m.parts]
      parts[j] = { ...part, tool: fn(part.tool) }
      return { ...m, parts }
    })
  }
}

function newestOpenCall(parts: Part[], id: string): number {
  let j = parts.length - 1
  while (j >= 0) {
    const p = parts[j]
    if (p.type === 'tool' && p.tool.id === id && (p.tool.status === 'running' || p.tool.status === 'confirm')) break
    j--
  }
  return j
}
