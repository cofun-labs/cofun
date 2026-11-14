// Saved sessions, kept on this device in IndexedDB. They never go to the worker.
//
// What is read back is parsed, never taken on trust: an earlier version may have saved a session in
// another form. One that doesn't parse is unreadable. It is listed as such, so it can be deleted,
// and it is never opened: nothing of it reaches the chat or the model.
import { HistoryMessage } from './agent'
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
const DB_PREFIX = 'notion-copilot-sessions-'
// Two stores, so the list never loads conversations: they grow with every tool result.
const INFO = 'sessions'
const MESSAGES = 'messages'
const TITLE_LENGTH = 100

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
   */
  async save({ messages, ...info }: Session, loaded?: number): Promise<SessionInfo> {
    let saved = info
    let failure: unknown
    try {
      await this.run('readwrite', (infos, all) => {
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

  async delete(id: string): Promise<void> {
    await this.run('readwrite', (infos, all) => {
      infos.delete(id)
      all.delete(id)
      return () => undefined
    })
  }

  /** All saved sessions, most recently used first, and after them the ones that can't be read. */
  async list(): Promise<ListedSession[]> {
    const [keys, records] = await this.run('readonly', (infos) => {
      // Both in key order, so the n-th record is the n-th key's.
      const keys = infos.getAllKeys()
      const records: IDBRequest<unknown[]> = infos.getAll()
      return () => [keys.result, records.result]
    })
    const readable: SessionInfo[] = []
    const unreadable: UnreadableSession[] = []
    records.forEach((record, i) => {
      const parsed = SessionInfo.safeParse(record)
      if (parsed.success) readable.push(parsed.data)
      // Every version gave sessions string ids; a record under any other key is not one of ours.
      else if (typeof keys[i] === 'string') unreadable.push({ id: keys[i], unreadable: true })
    })
    return [...readable.sort((a, b) => b.updatedAt - a.updatedAt), ...unreadable]
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_PREFIX + this.userId, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(INFO, { keyPath: 'id' })
        req.result.createObjectStore(MESSAGES, { keyPath: 'id' })
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

  /** Runs one transaction over both stores; resolves with `fn`'s result once it has committed. */
  private async run<T>(
    mode: IDBTransactionMode,
    fn: (info: IDBObjectStore, messages: IDBObjectStore) => () => T,
  ): Promise<T> {
    const tx = (await this.open()).transaction([INFO, MESSAGES], mode)
    let result: () => T
    try {
      result = fn(tx.objectStore(INFO), tx.objectStore(MESSAGES))
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
