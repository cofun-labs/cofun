import {
  CopilotAgent,
  KEY_REJECTED,
  type AgentConfig,
  type AgentUpdate,
  type ConfirmTool,
  type HistoryMessage,
  type QuestionDetails,
  type QuestionPage,
  type QuestionSelection,
  type ToolDetails,
  type ToolStatus,
} from '../agent'
import { track } from '../analytics'
import type { Mode } from '../mode'
import { answering, type ModelSettings, type OwnSetup } from '../models'
import { titleFor, type Session, type SessionStore } from '../sessions'
import type { HomeSite } from '../product'
import type { ToolMemory } from '../tools'

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
  /** Set while `confirm` when the call is already running and asks this instead of whether to run. */
  question?: string
  /** With `question`: the origin the call asks to read, which the user's yes allows (see CardQuestion). */
  access?: string
}

/** How saving a reply or a chat to Notion is going: running, or done with a link to the page. */
export type SaveState = { status: 'saving' } | { status: 'saved'; url: string }

/** A reply in the order it happened: text the model wrote and the tools it ran in between. */
export type Part = { type: 'text'; text: string } | { type: 'tool'; tool: ShownTool }

// The agent keeps the conversation it sends to the model; this is only what the panel shows.
export type Shown =
  | { role: 'user'; content: string; pages?: QuestionPage[]; selections?: QuestionSelection[]; readOnly?: true }
  | {
      role: 'assistant'
      parts: Part[]
      /** Why the question failed; shown below what the agent already did. */
      error?: string
      /** The question was refused for lack of credits: the error leads to the Credits page. */
      outOfCredits?: boolean
      stopped?: boolean
      note?: string
      /** Another window continued the session too, so this conversation was saved as a new session. */
      copied?: boolean
      /** What the question used, once it ended. */
      details?: QuestionDetails
    }

export type Reply = Extract<Shown, { role: 'assistant' }>

/**
 * Where the chat's question is: `waiting` before the agent is asked (for a page search still out,
 * or the mode or the model still loading), `asking` while it answers, `stopping` once Stop was
 * pressed and the question is winding down, so nothing is pending any more.
 */
type ChatStatus = 'ready' | 'waiting' | 'asking' | 'stopping'

/** What a chat shows. A new object only when something changed. */
export interface ChatSnapshot {
  /**
   * Not set until the chat's first question is sent. Changes if a save finds that another window
   * continued the session: this one is saved as a new session.
   */
  readonly id?: string
  readonly messages: readonly Shown[]
  readonly status: ChatStatus
  /** The title the model wrote for the chat, once it has one. */
  readonly title?: string
  /** How saving each reply, or the whole chat, to Notion is going, by the key `saveToNotion` was given. */
  readonly saves: Readonly<Record<string, SaveState>>
}

/** What every chat of one side panel shares, given by the panel. */
export interface ChatPanel {
  store: SessionStore
  /** The site the product works on, if it has one: a new session records the page of it open as it starts. */
  site?: Pick<HomeSite, 'currentPage'>
  /** Each chat asks its own agent, made with this. */
  agent: AgentConfig
  /** Aborted when the panel unmounts: it cuts a title request short, which leaving the chat does not. */
  closed: AbortSignal
  /** Sessions deleted in this panel: a save still waiting to write must not bring one back. */
  deleted: ReadonlySet<string>
  /** Which model answers and the mode, as soon as they are read: a question sent before waits for them. */
  model: () => Promise<ModelSettings>
  mode: () => Promise<Mode>
  /** A question or a title request ended, and may have spent the user's credits. */
  spent: () => void
  /** A session was saved or given a title: the list of chats changed. */
  saved: () => void
  /** The provider turned the user's own key away. */
  keyRejected: (setup: OwnSetup) => void
  /** A save to Notion failed, with what to tell the user. */
  saveFailed: (message: string) => void
}

/**
 * The session a chat is saved as. One object for as long as the chat lives: a save updates `id` and
 * `updatedAt` in place, so the next save, which may already be waiting, starts from what the last
 * one stored.
 */
interface SavedAs {
  /** Changes if a save finds that another window continued the session: this one is saved as a new session. */
  id: string
  createdAt: number
  page: Promise<Session['page']>
  /** As this panel loaded or last saved it; not set until the first save. */
  updatedAt?: number
}

/** A question as the composer sends it. */
export interface Question {
  text: string
  /** The pages it goes with, as the composer showed them. */
  pages: QuestionPage[]
  /** The selections it has room for, as their chips show them. */
  selections: QuestionSelection[]
  /** The note on the pages it carries (see carryPages). */
  context: string
  /** The mode the composer showed; only right as the panel opens may it not be read yet. */
  mode?: Mode
  /** The current tab is on Notion (for usage data). */
  notionTab: boolean
  /** Settles once no page search is out, with what the user is told when Notion turned that one away. */
  searched: Promise<string | undefined>
}

/**
 * One chat of the side panel, new or saved: what it shows, its agent, its question, and its saves.
 * A chat's work only ever updates its own object, so a chat the user left goes on updating an object
 * nobody shows until its question has ended and is saved. Imports no React: the panel subscribes to
 * it (`subscribe`, `getSnapshot`).
 */
export class ChatSession {
  private snapshot: ChatSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly agent: CopilotAgent
  /** Aborted by leave(): the question stops, and one still waiting to be asked is not asked. */
  private readonly lifetime = new AbortController()
  /** The question being answered, if any: aborted by Stop. */
  private question?: AbortController
  /** Answers for tool calls waiting for the user's OK, by call id. */
  private readonly answers = new Map<string, (allow: boolean) => void>()
  /** The session the chat is saved as: a saved one's, or a new one made by the first question. */
  private session?: SavedAs
  /** The model was asked for a title already, by this panel or the one that saved it (see `title`). */
  private titled: boolean
  /** Settles once the question being answered has ended and its save, if it has one, is in `saving`. */
  private ending = Promise.resolve()
  /** The save in progress, if any; the next one waits for it. */
  private saving = Promise.resolve()

  /** A new chat, or `saved` to continue a saved session. */
  constructor(
    private readonly panel: ChatPanel,
    saved?: Session,
  ) {
    this.agent = new CopilotAgent(panel.agent, saved?.messages)
    this.titled = saved?.titledByModel ?? false
    this.snapshot = {
      id: saved?.id,
      messages: saved ? toShown(saved.messages) : [],
      status: 'ready',
      title: saved?.titledByModel ? saved.title : undefined,
      saves: {},
    }
    if (saved)
      this.session = {
        id: saved.id,
        createdAt: saved.createdAt,
        page: Promise.resolve(saved.page),
        updatedAt: saved.updatedAt,
      }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ChatSnapshot => this.snapshot

  get id(): string | undefined {
    return this.snapshot.id
  }

  /** The user left the chat (see leave). */
  get left(): boolean {
    return this.lifetime.signal.aborted
  }

  /**
   * What the chat's tools remember of its conversation, its agent's own: the composer sets in it what
   * each question carries (carryPages), and the page picker the workspaces it searched.
   */
  get memory(): ToolMemory {
    return this.agent.memory
  }

  /** The conversation so far, as the agent holds it. Read it between questions: while one runs, it is still changing. */
  conversation(): HistoryMessage[] {
    return this.agent.history()
  }

  /** Settles once the question being answered, if any, has ended and the saves it made have been written. */
  async settled(): Promise<void> {
    await this.ending
    await this.saving
  }

  /**
   * Asks a question and resolves once it has ended. The chat gets an id with its first question, and
   * is saved once a question is part of the conversation. Does nothing while a question is out, or
   * once the user left the chat.
   */
  async ask(q: Question): Promise<void> {
    if (this.snapshot.status !== 'ready' || this.left) return
    const session = (this.session ??= {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      page: this.panel.site ? this.panel.site.currentPage().catch(() => undefined) : Promise.resolve(undefined),
    })
    if (this.snapshot.id !== session.id) this.update({ id: session.id })
    // Where this question's reply goes in the list.
    const reply = this.snapshot.messages.length + 1
    this.update({
      status: 'waiting',
      messages: [
        ...this.snapshot.messages,
        {
          role: 'user',
          content: q.text,
          ...(q.pages.length && { pages: q.pages }),
          ...(q.selections.length && { selections: q.selections }),
          ...(q.mode === 'read_only' && { readOnly: true }),
        },
        { role: 'assistant', parts: [] },
      ],
    })
    const stop = new AbortController()
    this.question = stop
    const signal = AbortSignal.any([stop.signal, this.lifetime.signal])
    let ended!: () => void
    this.ending = new Promise<void>((resolve) => (ended = resolve))

    // Calls this question asked about, so their answers can be dropped when it ends.
    const asked = new Map<string, (allow: boolean) => void>()
    const confirm: ConfirmTool = (call) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve(false)
        // One answer per prompt: a double click, or Stop racing a click, must not touch a later
        // prompt that reuses this id.
        let answered = false
        const answer = (allow: boolean) => {
          if (answered) return
          answered = true
          this.answers.delete(call.id)
          // Running again until the agent reports how the call ended (done, or declined).
          this.setToolStatus(call.id, 'running')
          resolve(allow)
        }
        asked.set(call.id, answer)
        this.answers.set(call.id, answer)
        // Normally the call is already shown as running. If not, show it now: the agent must never
        // wait on a prompt nobody can see. Show the arguments the tool will run with.
        const { preview, question, access } = call
        this.updateReply((m) => {
          const j = newestOpenCall(m.parts, call.id)
          const parts = [...m.parts]
          const tool: ShownTool = {
            id: call.id,
            name: call.name,
            args: call.args,
            status: 'confirm',
            result: '',
            preview,
            question,
            access,
          }
          if (j < 0) parts.push({ type: 'tool', tool })
          else
            parts[j] = {
              type: 'tool',
              tool: {
                ...(parts[j] as Extract<Part, { type: 'tool' }>).tool,
                args: call.args,
                status: 'confirm',
                preview,
                question,
                access,
              },
            }
          return { ...m, parts }
        })
      })

    // Tool calls of this question that ended, however they did.
    let toolCalls = 0
    const onUpdate = (u: AgentUpdate) => {
      if (u.type === 'tool_end') {
        toolCalls++
        track({ event: 'tool_called', tool: u.name, ok: u.status === 'done', status: u.status, error_code: u.code })
      }
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

    // The conversation with this question in it, once it ended, if the question is part of it.
    let conversation: HistoryMessage[] | undefined
    let answered = false
    try {
      // A page search still out goes first: Notion is asked one thing at a time. If it was turned
      // away, so is the question, which sends nothing; and so it does when the user stopped it, or
      // left the chat, meanwhile.
      const turnedAway = await q.searched
      if (signal.aborted) {
        this.updateReply((m) => ({ ...m, stopped: true }))
        return
      }
      if (turnedAway) {
        this.updateReply((m) => ({ ...m, error: turnedAway }))
        return
      }
      const readOnly = (q.mode ?? (await this.panel.mode())) === 'read_only'
      if (readOnly && !q.mode)
        this.update({
          messages: this.snapshot.messages.map((m, i) =>
            i === reply - 1 && m.role === 'user' ? { ...m, readOnly: true } : m,
          ),
        })
      // The key the question goes with, if it goes to the user's own model: a 401 marks that key only.
      const askedWith = answering(await this.panel.model())
      // The service the question is asked of, as the agent reads it when the question starts.
      const provider = askedWith?.service ?? 'hosted'
      // The mode and the model may have been loading: a Stop, leaving the chat, or the panel closing
      // meanwhile stops the question too, before it counts as asked.
      if (signal.aborted) {
        this.updateReply((m) => ({ ...m, stopped: true }))
        return
      }
      this.update({ status: 'asking' })
      track({ event: 'question_asked', provider, notion_tab: q.notionTab })
      const result = await this.agent.ask(
        q.text,
        onUpdate,
        confirm,
        { context: q.context, pages: q.pages, selections: q.selections, readOnly, chat: session.id },
        { signal },
      )
      track({
        event: 'question_ended',
        provider,
        outcome: result.status,
        error_code: result.status === 'error' ? result.code : undefined,
        rounds: result.rounds,
        tool_calls: toolCalls,
      })
      answered = result.status === 'done'
      conversation = result.conversation
      const { requests, tokens, model, cost } = result
      this.updateReply((m) => ({ ...m, details: { requests, tokens, model, cost } }))
      if (result.status === 'stopped') {
        this.updateReply((m) => ({
          ...m,
          parts: m.parts.map((p) =>
            p.type === 'tool' && (p.tool.status === 'running' || p.tool.status === 'confirm')
              ? { ...p, tool: { ...p.tool, status: 'stopped' } }
              : p,
          ),
          stopped: true,
        }))
      } else if (result.status === 'error') {
        this.updateReply((m) => ({ ...m, error: result.message, outOfCredits: result.code === 'out_of_credits' }))
        // The provider turned the user's key away: Settings marks it, until a check passes or a new key is saved.
        const by = result.model
        if (result.code === KEY_REJECTED && by && by.service !== 'hosted' && askedWith?.service === by.service)
          this.panel.keyRejected(askedWith)
      } else if (result.status === 'step_limit')
        this.updateReply((m) => ({ ...m, note: `Stopped after ${result.steps} steps. Ask again to continue.` }))
    } finally {
      // A question can end without the user answering, e.g. when they left the chat.
      // Only this question's own answers: the next question may reuse an id.
      for (const [callId, answer] of asked) if (this.answers.get(callId) === answer) this.answers.delete(callId)
      if (this.question === stop) this.question = undefined
      this.panel.spent()
      this.update({ status: 'ready' })
      // A question that failed or was stopped before using a tool leaves the conversation as it
      // was; don't move the session to the top of the list for it. One that used tools keeps them:
      // leaving the chat stopped the question like Stop does, and what it already did must not be
      // done again when the session is continued.
      if (conversation) {
        const messages = conversation
        this.saving = this.saving.then(() => this.save(session, messages, reply))
        // Once, after the first question answered; not for a chat the user left meanwhile.
        if (answered && !this.titled && !this.left) {
          this.titled = true
          void this.title(session, messages)
        }
      }
      ended()
    }
  }

  /** Stops the question being answered, if any: every prompt is answered with no. */
  stop(): void {
    if (this.snapshot.status !== 'ready') this.update({ status: 'stopping' })
    this.declineAll()
    this.question?.abort()
  }

  /** Answers the prompt of the tool call `callId`, if it is still waiting for the user. */
  answer(callId: string, allow: boolean): void {
    this.answers.get(callId)?.(allow)
  }

  /**
   * The user left the chat, for another one or by closing the panel: its question stops, as Stop
   * stops it, and is saved to this chat once it has ended. Nothing more is asked in it.
   */
  leave(): void {
    this.declineAll()
    this.lifetime.abort()
  }

  /**
   * Saves a reply or the whole chat to Notion under `key`, which says what is saved: a save that is
   * running starts no other for its key. A failure leaves the key as it was before, so the save can
   * be tried again, and the panel tells the user why.
   */
  saveToNotion(key: string, save: () => Promise<{ url: string }>): void {
    // One click creates at most one page.
    if (this.snapshot.saves[key]?.status === 'saving') return
    const set = (state?: SaveState) => {
      const saves = { ...this.snapshot.saves }
      if (state) saves[key] = state
      else delete saves[key]
      this.update({ saves })
    }
    set({ status: 'saving' })
    save().then(
      ({ url }) => set({ status: 'saved', url }),
      (err: unknown) => {
        set(undefined)
        this.panel.saveFailed(err instanceof Error ? err.message : String(err))
      },
    )
  }

  private declineAll() {
    for (const answer of this.answers.values()) answer(false)
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

  private setToolStatus(id: string, status: ShownTool['status']) {
    this.updateTool(id, (tool) => ({ ...tool, status }))
  }

  /** Saves the session after a question; `reply` is the place of the question's reply in the list. Never rejects. */
  private async save(session: SavedAs, messages: HistoryMessage[], reply: number) {
    try {
      const page = await session.page
      const { id, createdAt, updatedAt: loaded } = session
      if (this.panel.deleted.has(id)) return
      const saved = await this.panel.store.save(
        {
          id,
          createdAt,
          page,
          title: titleFor(messages),
          // Always a new value, so another panel that loaded this session can tell it changed.
          updatedAt: Math.max(Date.now(), (loaded ?? 0) + 1),
          messages,
        },
        loaded,
      )
      session.id = saved.id
      session.updatedAt = saved.updatedAt
      if (saved.id !== id)
        this.update({
          id: saved.id,
          // On the reply that was saved; the user may have asked the next question already.
          messages: this.snapshot.messages.map((m, i) =>
            i === reply && m.role === 'assistant' ? { ...m, copied: true } : m,
          ),
        })
      // Also shows the session's new id, if it got one, to the list.
      this.panel.saved()
    } catch (err) {
      console.error('Could not save the session', err)
    }
  }

  /**
   * Asks the model for a short title once the session's first reply is in, and gives it to the
   * session when one comes. Until then, or if none comes, the session keeps its first question as its
   * title; nothing is shown either way. Never rejects.
   */
  private async title(session: SavedAs, messages: HistoryMessage[]) {
    // Not cut short by leaving the chat, which still gets the title; only by the panel unmounting.
    const written = await this.agent.title(messages, { chat: session.id, signal: this.panel.closed })
    // On the hosted model the request spent credits; the read after the question was too early for it.
    this.panel.spent()
    if (!written) return
    // After the save of the reply, which may give the session another id.
    this.saving = this.saving.then(async () => {
      try {
        if (this.panel.deleted.has(session.id)) return
        if (await this.panel.store.retitle(session.id, written)) {
          this.update({ title: written })
          this.panel.saved()
        }
      } catch (err) {
        console.error('Could not save the title', err)
      }
    })
  }
}

/** A saved conversation as the panel shows it: each question, then everything the agent did for it. */
function toShown(history: HistoryMessage[]): Shown[] {
  const shown: Shown[] = []
  // Of the latest question, shown under its reply.
  let details: QuestionDetails | undefined
  for (const m of history) {
    if (m.role === 'user') {
      shown.push({
        role: 'user',
        content: m.text,
        ...(m.pages?.length && { pages: m.pages }),
        ...(m.selections?.length && { selections: m.selections }),
        ...(m.readOnly && { readOnly: true }),
      })
      details = { requests: m.requests, tokens: m.tokens, model: m.model, cost: m.cost }
      continue
    }
    let reply = shown.at(-1)
    if (reply?.role !== 'assistant') shown.push((reply = { role: 'assistant', parts: [], details }))
    if (m.role === 'assistant') {
      for (const p of m.parts)
        reply.parts.push(
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'tool', tool: { id: p.id, name: p.name, args: p.args, status: 'running', result: '' } },
        )
    } else {
      // Like a live reply: the result belongs to the newest call with its id that has none yet.
      const part = reply.parts[newestOpenCall(reply.parts, m.id)]
      if (part?.type === 'tool') part.tool = { ...part.tool, status: m.status, result: m.result, details: m.details }
    }
  }
  // A call saved without its result is not running any more.
  for (const m of shown)
    if (m.role === 'assistant')
      for (const p of m.parts)
        if (p.type === 'tool' && p.tool.status === 'running') p.tool = { ...p.tool, status: 'stopped' }
  return shown
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
