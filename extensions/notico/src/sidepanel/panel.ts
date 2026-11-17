import { CopilotAgent, type AgentConfig, type QuestionPage } from '../agent'
import { track } from '../analytics'
import type { CreditsState } from '../credits'
import { loadMode, saveMode, watchMode, type Mode } from '../mode'
import {
  answering,
  HOSTED_ONLY,
  keyRejected,
  loadModelSettings,
  saveModelSettings,
  watchModelSettings,
  type ModelSettings,
} from '../models'
import { countNotionRequests } from '../notion/tab'
import type { Product } from '../product'
import { SessionStore, type Session } from '../sessions'
import { pagesIn } from '../tools'
import { ChatSession, type Question } from './chat-session'

const API_URL = import.meta.env.VITE_API_URL as string
/** Saved sessions, besides the open one, whose pages the page picker offers as recent. */
const RECENT_SESSIONS = 5

/** What the panel shows besides the open chat's own snapshot. A new object only when something changed. */
export interface PanelSnapshot {
  /** The open chat. Opening the panel starts a new one; it gets an id when its first question is sent. */
  readonly chat: ChatSession
  readonly credits: CreditsState
  /** Changes whenever a session is saved or given a title, so the list of chats stays current while it is open. */
  readonly saved: number
  /** Which model answers, once its settings are read. */
  readonly model?: ModelSettings
  /** Whether the agent may change pages, once it is read. */
  readonly mode?: Mode
  /** Why the latest save to Notion failed; a new failure has a new key, even with the same words. */
  readonly saveFailure?: { message: string; key: number }
}

/**
 * How opening a saved chat went: `switched` to it, already `shown` as the open chat, `overtaken` by
 * a newer open, a new chat, or a question sent meanwhile, `gone` when it no longer exists, or
 * `unreadable` when it can't be read.
 */
export type Opening = 'switched' | 'shown' | 'overtaken' | 'gone' | 'unreadable'

/**
 * One side panel of one signed-in user: the open chat, the saved sessions, the credits, the model
 * and the mode, and what crosses chats. Every chat's own work stays in its ChatSession; the panel
 * only switches which one is open. Imports no React: the side panel subscribes to it (`subscribe`,
 * `getSnapshot`), and mounts it with `connect`.
 */
export class Panel {
  readonly store: SessionStore
  private snapshot: PanelSnapshot
  private readonly listeners = new Set<() => void>()
  /** What every chat's agent is made with. */
  private readonly agent: AgentConfig
  /** Reads the credits and starts a purchase; it asks nothing: each chat has an agent of its own. */
  private readonly account: CopilotAgent
  // Read once for this account, then changed here or by another window's panel. Each question reads
  // the model as it starts, and takes the mode as it is sent, so a change applies from the next one on.
  private readonly modelLoad: Promise<ModelSettings>
  private readonly modeLoad: Promise<Mode>
  /**
   * Aborted once the panel is disconnected (it unmounted): a question still waiting to be asked is
   * not asked, and a read of the credits or a title request is cut short.
   */
  private lifetime = new AbortController()
  /** The newest read of the credits: reads can overlap (a question ends while the Credits page loads), and a newer one aborts the one before. */
  private creditRead?: AbortController
  /**
   * Bumped by every open() and every question sent: a session still loading when either happens is
   * not opened. The one check of which work is newest left, because a wait on IndexedDB can't be cut short.
   */
  private opening = 0
  /** Sessions deleted in this panel: a save still waiting to write must not bring one back. */
  private readonly deleted = new Set<string>()
  /**
   * Chats the user left whose question has not ended, or has not been saved yet: a question of a chat
   * the user left was stopped then, and ends on its own time (a Notion request already sent is not
   * cut short). Reopening its session waits for it (see `open`).
   */
  private readonly leaving = new Set<ChatSession>()
  /** Stripe's Checkout was opened: each return to the panel reads the credits again. */
  private checkoutOpened = false

  constructor(
    private readonly userId: string,
    getToken: () => Promise<string | null>,
    product: Product,
  ) {
    this.store = new SessionStore(userId)
    this.modelLoad = loadModelSettings(userId).catch((err: unknown) => {
      console.error('Could not read the model settings', err)
      return HOSTED_ONLY
    })
    this.modeLoad = loadMode(userId).catch((err: unknown): Mode => {
      console.error('Could not read the mode', err)
      return 'edit'
    })
    this.agent = {
      apiUrl: API_URL,
      getToken,
      client: `${product.id}/${chrome.runtime.getManifest().version}`,
      names: { product: product.name, site: product.site },
      model: this.readModel,
      systemPrompt: product.prompt,
      tools: product.tools,
      meter: countNotionRequests,
      results: this.store,
    }
    this.account = new CopilotAgent(this.agent)
    this.snapshot = { chat: this.newSession(), credits: { status: 'loading' }, saved: 0 }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): PanelSnapshot => this.snapshot

  /**
   * Starts what the panel follows while it is mounted, and returns what ends it: the open chat is left
   * then, which stops its question (the panel unmounts on sign-out and when it closes). Connecting
   * again after that (StrictMode mounts, unmounts, and mounts again) starts a new chat.
   */
  connect(): () => void {
    if (this.lifetime.signal.aborted) {
      this.lifetime = new AbortController()
      this.update({ chat: this.newSession() })
    }
    const lifetime = this.lifetime
    // Long results go 7 days after they were kept; also opens the database, which the first time
    // makes the results store in it.
    this.store.sweep().catch((err: unknown) => console.error('Could not sweep the kept results', err))
    void this.modelLoad.then((settings) => {
      if (!this.snapshot.model) this.update({ model: settings })
    })
    void this.modeLoad.then((mode) => {
      if (!this.snapshot.mode) this.update({ mode })
    })
    // What another window's panel saves, such as a key it removed or the mode, applies here too.
    const unwatchModel = watchModelSettings(this.userId, (model) => this.update({ model }))
    const unwatchMode = watchMode(this.userId, (mode) => this.update({ mode }))
    void this.readCredits()
    // After Checkout was opened, the user pays in another tab and comes back to the panel: each time
    // the panel gets the focus again, it reads the credits, so a purchase shows without a reload. The
    // payment may take a moment to go through, so every return reads them, not only the first.
    const onFocus = () => {
      if (this.checkoutOpened) void this.readCredits()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      unwatchModel()
      unwatchMode()
      window.removeEventListener('focus', onFocus)
      lifetime.abort()
      this.snapshot.chat.leave()
    }
  }

  /** Asks the open chat a question; a session still loading to be opened is then not opened. */
  ask(q: Question): void {
    this.opening++
    void this.snapshot.chat.ask(q)
  }

  /** Leaves the open chat for a new one. */
  newChat(): void {
    track({ event: 'chat_created' })
    this.switchTo()
  }

  /**
   * Opens a saved session, unless it no longer exists or can't be read. The newest open wins: a
   * session still loading when the user opens another, starts a new chat, or asks something is not
   * opened.
   */
  async open(id: string): Promise<Opening> {
    // The open session is already on screen, maybe with a reply still coming in.
    const was = this.snapshot.chat
    if (id === was.id) return 'shown'
    const token = ++this.opening
    const lifetime = this.lifetime
    const overtaken = () => this.snapshot.chat !== was || this.opening !== token || lifetime.signal.aborted
    // First see whether it can be opened at all: one that can't leaves the open chat, and a reply
    // still coming in for it, as they are. Nothing of it reaches the chat.
    const found = await this.store.get(id)
    if (overtaken()) return 'overtaken'
    if (!found) return 'gone'
    if (found === 'unreadable') return 'unreadable'
    // Stop the reply now, not once the session has loaded again: it must not finish in the meantime.
    was.stop()
    // A question asked in this very session may still be ending (the user left it for a new chat, and
    // comes back): it is saved to the session once it has, so wait for it and its saves. They would
    // otherwise look like another window's later, and the session would open without the question.
    // A chat of any other session is not waited for.
    await Promise.all([...this.leaving].filter((c) => c.id === id).map((c) => c.settled()))
    const session = await this.store.get(id)
    if (overtaken()) return 'overtaken'
    if (!session) return 'gone'
    if (session === 'unreadable') return 'unreadable'
    this.switchTo(session)
    track({ event: 'chat_opened' })
    return 'switched'
  }

  /**
   * Deletes a saved session. Deleting the open one stops its reply and starts a new chat, and no save
   * still waiting brings the session back.
   */
  async delete(id: string): Promise<void> {
    track({ event: 'chat_deleted' })
    // First, so a reply still coming in for the open session stops and can't save it back.
    this.deleted.add(id)
    if (id === this.snapshot.chat.id) this.switchTo()
    await this.store.delete(id)
  }

  /**
   * Pages recent chats went with, newest first, from what is saved on the device: the open chat's,
   * then those of the latest saved sessions, each with the page it started on. Links are made on `origin`.
   */
  async recentPages(origin: string): Promise<QuestionPage[]> {
    const chat = this.snapshot.chat
    // A session that can't be read has no pages to offer.
    const infos = (await this.store.list())
      .filter((s) => s.id !== chat.id && !('unreadable' in s))
      .slice(0, RECENT_SESSIONS)
    const saved = await Promise.all(infos.map((info) => this.store.get(info.id).catch(() => undefined)))
    return [
      ...pagesIn(chat.conversation(), origin),
      ...infos.flatMap((info, i) => {
        const session = saved[i]
        const messages = session && session !== 'unreadable' ? session.messages : []
        return [...pagesIn(messages, origin), ...('page' in info && info.page ? [info.page] : [])]
      }),
    ]
  }

  /**
   * Reads the user's credits from the worker: when the panel loads, after each question, and when
   * the account menu or the Credits page opens. The read after a question keeps the menu current
   * without a wait; the one on opening catches what that read can miss: a reply the user stopped is
   * charged after the panel has gone on, and another window may have spent credits. A read that
   * fails never touches the chat: the menu and the Credits page say the credits are unavailable.
   */
  async readCredits(): Promise<void> {
    if (this.lifetime.signal.aborted) return
    this.creditRead?.abort()
    const read = new AbortController()
    this.creditRead = read
    const signal = AbortSignal.any([read.signal, this.lifetime.signal])
    let next: CreditsState
    try {
      next = { status: 'ready', credits: await this.account.credits({ signal }) }
    } catch {
      next = { status: 'unavailable' }
    }
    if (!signal.aborted) this.update({ credits: next })
  }

  /** Every grant the user was given, for the Credits page. */
  creditGrants() {
    return this.account.creditGrants()
  }

  /** The packs of credits on sale, for the Credits page. */
  creditPacks() {
    return this.account.creditPacks()
  }

  /** Opens Stripe's Checkout for the pack of `quantity` in a new tab. */
  async buyCredits(quantity: number): Promise<void> {
    track({ event: 'credits_buy_clicked', pack: quantity })
    const url = await this.account.checkout(quantity)
    this.checkoutOpened = true
    await chrome.tabs.create({ url })
  }

  changeMode(mode: Mode): void {
    this.update({ mode })
    saveMode(this.userId, mode).catch((err: unknown) => console.error('Could not save the mode', err))
  }

  /** Saves what `change` makes of the model settings as they are now, here or saved by another window. */
  changeModel(change: (settings: ModelSettings) => ModelSettings): void {
    const before = this.snapshot.model ?? HOSTED_ONLY
    const model = change(before)
    // Which service answers now, and a key that was just saved: never the key or the model's name.
    const provider = answering(model)?.service ?? 'hosted'
    if (provider !== (answering(before)?.service ?? 'hosted')) track({ event: 'model_switched', provider })
    if (model.openRouter && model.openRouter.key !== before.openRouter?.key)
      track({ event: 'own_key_saved', provider: 'openrouter' })
    this.update({ model })
    saveModelSettings(this.userId, model).catch((err: unknown) =>
      console.error('Could not save the model settings', err),
    )
  }

  /** The user closed the message of a failed save. */
  dismissSaveFailure(): void {
    this.update({ saveFailure: undefined })
  }

  /** Which model answers, once its settings are read: a question sent before waits for them. */
  private readModel = async (): Promise<ModelSettings> => this.snapshot.model ?? (await this.modelLoad)

  /**
   * Switches to a new session, or to a saved one. The chat left behind stops its question, as Stop
   * stops it, and saves it to its session when it has ended (see ChatSession.leave).
   */
  private switchTo(session?: Session) {
    const was = this.snapshot.chat
    was.leave()
    this.leaving.add(was)
    void was.settled().then(() => this.leaving.delete(was))
    // A failed save's message belongs to the chat it was for.
    this.update({ chat: this.newSession(session), saveFailure: undefined })
  }

  /** A new chat, or `saved` to continue a saved session. */
  private newSession(saved?: Session): ChatSession {
    return new ChatSession(
      {
        store: this.store,
        agent: this.agent,
        closed: this.lifetime.signal,
        deleted: this.deleted,
        model: this.readModel,
        mode: () => this.modeLoad,
        spent: () => void this.readCredits(),
        saved: () => this.update({ saved: this.snapshot.saved + 1 }),
        keyRejected: ({ service, key }) => this.changeModel((now) => keyRejected(now, service, key, Date.now())),
        saveFailed: (message) =>
          this.update({ saveFailure: { message, key: (this.snapshot.saveFailure?.key ?? 0) + 1 } }),
      },
      saved,
    )
  }

  private update(change: Partial<PanelSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change }
    for (const listener of this.listeners) listener()
  }
}
