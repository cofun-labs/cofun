// Saved sessions, kept on this device in IndexedDB, and the long tool results they refer to (see
// `KeptResult`). They never go to the worker.
//
// What is read back is parsed, never taken on trust: an earlier version may have saved a session in
// another form. One that doesn't parse is unreadable. It is listed as such, so it can be deleted,
// and it is never opened: nothing of it reaches the chat or the model.
import { HistoryMessage, KeptResult, type ResultToKeep } from './agent'
import { z } from './zod'

/** What the session list shows; the conversation itself is loaded only when a session opens. */
const SessionInfo = z.object({
  id: z.string(),
  /** The short title the model wrote after the first reply; until then, the first question (see `titleFor`). */
  title: z.string(),
  /** `title` is the model's; it is written once, and saving the session again keeps it. */
  titledByModel: z.literal(true).optional(),
  /** The Notion page open when the session started, if there was one. */
  page: z.object({ title: z.string(), url: z.string() }).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type SessionInfo = z.infer<typeof SessionInfo>

/** The key every stored record has, whatever else it holds. */
const StoredId = z.object({ id: z.string() })

/** A session's conversation, as the second store keeps it. */
const StoredMessages = z.object({ messages: z.array(HistoryMessage) })

export interface Session extends SessionInfo {
  messages: HistoryMessage[]
}

/** A saved session whose details don't parse: all the list can do with it is delete it. */
interface UnreadableSession {
  id: string
  unreadable: true
}

export type ListedSession = SessionInfo | UnreadableSession

// One database per account, so another account signed in on this browser never sees these sessions.
const DB_PREFIX = 'notico-sessions-'
/** Version 2 added the results store; the sessions and messages stores are as version 1 made them. */
const DB_VERSION = 2
// Two stores, so the list never loads conversations: they grow with every tool result.
const INFO = 'sessions'
const MESSAGES = 'messages'
/**
 * The full text of long tool results (see KeptResult). `chats` lists the saved sessions whose
 * messages name a result, indexed one entry per session; `unnamedAt` is set while none does yet.
 */
const RESULTS = 'results'
const BY_CHAT = 'chats'
const UNNAMED = 'unnamedAt'
/**
 * How long a result no saved session names is kept: one kept for a question whose session was never
 * saved (the save failed, or the session was deleted while the question ran) is swept after this.
 */
const UNNAMED_MS = 24 * 60 * 60 * 1000
const TITLE_LENGTH = 100

/** The ids of the kept results a conversation's tool results name (see ToolDetails.result). */
function resultsIn(messages: HistoryMessage[]): string[] {
  return [...new Set(messages.flatMap((m) => (m.role === 'tool' && m.details?.result ? [m.details.result] : [])))]
}

/** The saved sessions of one signed-in user. */
export class SessionStore {
  private db?: Promise<IDBDatabase>

  constructor(private readonly userId: string) {}

  /**
   * Saves a session and resolves with its details as stored. `loaded` is the `updatedAt` the caller
   * loaded or last saved the session with; leave it out for a session that was never saved.
   *
   * Another panel may have saved the session since. Its conversation is then not overwritten:
   * this one is saved as a new session, under the new id in the result. The check and the write
   * are one transaction, so of two panels saving at once only one keeps the id.
   *
   * A title the model wrote (see `retitle`) is kept, whatever title the caller gives.
   *
   * The kept results the conversation names are marked as named by the session it is saved as, in
   * the same transaction, so they stay as long as one session names them (see `delete`).
   */
  async save({ messages, ...info }: Session, loaded?: number): Promise<SessionInfo> {
    let saved = info
    let failure: unknown
    try {
      await this.run('readwrite', (infos, all, results) => {
        const stored: IDBRequest<unknown> = infos.get(info.id)
        stored.onsuccess = () => {
          try {
            // A session that is gone (deleted elsewhere) has nothing to overwrite; one that can't be
            // read is not overwritten either, since it can't be told apart from another panel's.
            const prior = stored.result === undefined ? undefined : SessionInfo.safeParse(stored.result).data
            if (stored.result !== undefined && (!prior || prior.updatedAt !== loaded))
              saved = { ...info, id: crypto.randomUUID() }
            if (prior?.titledByModel) saved = { ...saved, title: prior.title, titledByModel: true }
            infos.put(saved)
            all.put({ id: saved.id, messages })
            linkResults(results, saved.id, resultsIn(messages))
          } catch (err) {
            // A write that throws (e.g. data that can't be cloned) must not leave the other one committed.
            failure = err
            infos.transaction.abort()
          }
        }
        return () => undefined
      })
    } catch (err) {
      throw failure ?? err
    }
    return saved
  }

  /** A saved session with its conversation; `'unreadable'` when either doesn't parse, `undefined` when it is gone. */
  async get(id: string): Promise<Session | 'unreadable' | undefined> {
    const [info, stored] = await this.run('readonly', (infos, all) => {
      const info: IDBRequest<unknown> = infos.get(id)
      const stored: IDBRequest<unknown> = all.get(id)
      return () => [info.result, stored.result]
    })
    if (info === undefined) return undefined
    const details = SessionInfo.safeParse(info)
    // Both stores are written in one transaction, so a session has its conversation; without one it is empty.
    const conversation =
      stored === undefined ? { success: true, data: { messages: [] } } : StoredMessages.safeParse(stored)
    if (!details.success || !conversation.success) return 'unreadable'
    return { ...details.data, messages: conversation.data.messages }
  }

  /**
   * Gives a session the title the model wrote for it, once: resolves false, changing nothing, when
   * the session is gone or already has one. It does not count as using the session, so it neither
   * moves the session in the list nor makes another panel's next save a separate session.
   */
  async retitle(id: string, title: string): Promise<boolean> {
    let done = false
    await this.run('readwrite', (infos) => {
      const stored: IDBRequest<unknown> = infos.get(id)
      stored.onsuccess = () => {
        // A session that can't be read is left as it is.
        const record = SessionInfo.safeParse(stored.result).data
        if (!record || record.titledByModel) return
        infos.put({ ...record, title, titledByModel: true })
        done = true
      }
      return () => done
    })
    return done
  }

  /** Deletes a session, and the kept results no other session names. */
  async delete(id: string): Promise<void> {
    await this.run('readwrite', (infos, all, results) => {
      infos.delete(id)
      all.delete(id)
      const named: IDBRequest<unknown[]> = results.index(BY_CHAT).getAll(id)
      named.onsuccess = () => {
        for (const record of named.result) {
          const kept = KeptResult.safeParse(record).data
          // One that can't be read can't be told apart from another session's either: it is left.
          if (!kept) continue
          const chats = kept.chats.filter((chat) => chat !== id)
          if (chats.length) results.put({ ...kept, chats })
          else results.delete(kept.id)
        }
      }
      return () => undefined
    })
  }

  /**
   * Keeps the full text of a long tool result, and resolves with its id. No saved session names it
   * yet: the save after the question does (see `save`), and until then it is swept after UNNAMED_MS.
   */
  async keep(result: ResultToKeep): Promise<string> {
    const id = `r_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
    const now = Date.now()
    const record: KeptResult = { ...result, id, chats: [], createdAt: now, unnamedAt: now }
    await this.run('readwrite', (_infos, _all, results) => {
      results.add(record)
      return () => undefined
    })
    return id
  }

  /**
   * Deletes the kept results that no saved session named within UNNAMED_MS of being kept. By the
   * index, so their texts are never loaded. The side panel calls it as it starts.
   */
  async sweep(): Promise<void> {
    await this.run('readwrite', (_infos, _all, results) => {
      const old = results.index(UNNAMED).openKeyCursor(IDBKeyRange.upperBound(Date.now() - UNNAMED_MS))
      old.onsuccess = () => {
        const cursor = old.result
        if (!cursor) return
        results.delete(cursor.primaryKey)
        cursor.continue()
      }
      return () => undefined
    })
  }

  /** A kept result; `undefined` when it is gone or can't be read. */
  async result(id: string): Promise<KeptResult | undefined> {
    const record = await this.run('readonly', (_infos, _all, results) => {
      const record: IDBRequest<unknown> = results.get(id)
      return () => record.result
    })
    return KeptResult.safeParse(record).data
  }

  /** All saved sessions, most recently used first, and after them the ones that can't be read. */
  async list(): Promise<ListedSession[]> {
    const records = await this.run('readonly', (infos) => {
      const records: IDBRequest<unknown[]> = infos.getAll()
      return () => records.result
    })
    const readable: SessionInfo[] = []
    const unreadable: UnreadableSession[] = []
    for (const record of records) {
      const parsed = SessionInfo.safeParse(record)
      if (parsed.success) readable.push(parsed.data)
      else {
        // The store's key is the record's `id`, so every record has one; every version made it a string.
        const key = StoredId.safeParse(record)
        if (key.success) unreadable.push({ id: key.data.id, unreadable: true })
      }
    }
    return [...readable.sort((a, b) => b.updatedAt - a.updatedAt), ...unreadable]
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_PREFIX + this.userId, DB_VERSION)
      req.onupgradeneeded = ({ oldVersion }) => {
        const db = req.result
        if (oldVersion < 1) {
          db.createObjectStore(INFO, { keyPath: 'id' })
          db.createObjectStore(MESSAGES, { keyPath: 'id' })
        }
        if (oldVersion < 2) {
          const results = db.createObjectStore(RESULTS, { keyPath: 'id' })
          results.createIndex(BY_CHAT, 'chats', { multiEntry: true })
          results.createIndex(UNNAMED, UNNAMED)
        }
      }
      req.onsuccess = () => {
        const db = req.result
        // Let a newer schema (another panel, or a later version) upgrade the database; reopen on next use.
        db.onversionchange = () => {
          db.close()
          this.db = undefined
        }
        // Closed by the browser (e.g. site data cleared): reopen on next use instead of failing.
        db.onclose = () => {
          this.db = undefined
        }
        resolve(db)
      }
      req.onerror = () => reject(req.error)
    }).catch((err) => {
      // Let the next call try again instead of failing forever.
      this.db = undefined
      throw err
    })
    return this.db
  }

  /** Runs one transaction over the three stores; resolves with `fn`'s result once it has committed. */
  private async run<T>(
    mode: IDBTransactionMode,
    fn: (info: IDBObjectStore, messages: IDBObjectStore, results: IDBObjectStore) => () => T,
  ): Promise<T> {
    const tx = (await this.open()).transaction([INFO, MESSAGES, RESULTS], mode)
    let result: () => T
    try {
      result = fn(tx.objectStore(INFO), tx.objectStore(MESSAGES), tx.objectStore(RESULTS))
    } catch (err) {
      // A write that throws (e.g. data that can't be cloned) must not leave the other one committed.
      tx.abort()
      throw err
    }
    return new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(result())
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }
}

/**
 * Marks the kept results `ids` as named by the session `chat`, within the transaction `results`
 * belongs to. Only those it does not name yet are read: a session saved again after each question
 * names most of them already. A result that is gone (site data cleared) stays gone.
 */
function linkResults(results: IDBObjectStore, chat: string, ids: string[]): void {
  if (!ids.length) return
  const named: IDBRequest<IDBValidKey[]> = results.index(BY_CHAT).getAllKeys(chat)
  named.onsuccess = () => {
    const linked = new Set(named.result)
    for (const id of ids) {
      if (linked.has(id)) continue
      const stored: IDBRequest<unknown> = results.get(id)
      stored.onsuccess = () => {
        const kept = KeptResult.safeParse(stored.result).data
        if (!kept) return
        // Without `unnamedAt`, the sweep no longer finds it.
        const { unnamedAt: _, ...rest } = kept
        results.put({ ...rest, chats: [...rest.chats, chat] })
      }
    }
  }
}

/** A session's title until the model writes one: its first question, on one line and cut to a readable length. */
export function titleFor(messages: HistoryMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  // By characters, not UTF-16 units, so an emoji is never cut in half.
  const chars = Array.from((first?.text ?? '').replace(/\s+/g, ' ').trim())
  return chars.length > TITLE_LENGTH ? `${chars.slice(0, TITLE_LENGTH - 1).join('')}…` : chars.join('')
}

/** Sessions whose title contains `query`, ignoring case; one that can't be read has no title to match. */
export function filterSessions(sessions: ListedSession[], query: string): ListedSession[] {
  const q = query.trim().toLowerCase()
  return q ? sessions.filter((s) => 'title' in s && s.title.toLowerCase().includes(q)) : sessions
}
