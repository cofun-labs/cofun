// Saved sessions, kept on this device in IndexedDB, and the long tool results they refer to (see
// `KeptResult`). They never go to the worker.
//
// What is read back is parsed, never taken on trust: an earlier version may have saved a session in
// another form. One that doesn't parse is unreadable. It is listed as such, so it can be deleted,
// and it is never opened: nothing of it reaches the chat or the model.
import { Compaction, HistoryMessage, KeptResult, type ResultToKeep } from '@cofun/agent'
import { z } from './zod'

/** What the session list shows; the conversation itself is loaded only when a session opens. */
const SessionInfo = z.object({
  id: z.string(),
  /** The short title the model wrote after the first reply; until then, the first question (see `titleFor`). */
  title: z.string(),
  /** `title` is the model's; it is written once, and saving the session again keeps it. */
  titledByModel: z.literal(true).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type SessionInfo = z.infer<typeof SessionInfo>

/** The key every stored record has, whatever else it holds. */
const StoredId = z.object({ id: z.string() })

/** A session's conversation, as the second store keeps it. */
const StoredMessages = z.object({
  messages: z.array(HistoryMessage),
  compaction: Compaction.optional().catch(undefined),
})

export interface Session extends SessionInfo {
  messages: HistoryMessage[]
  compaction?: Compaction
}

/** A saved session whose details don't parse: all the list can do with it is delete it. */
interface UnreadableSession {
  id: string
  unreadable: true
}

export type ListedSession = SessionInfo | UnreadableSession

// One database per account, so another account signed in on this browser never sees these sessions.
const DB_PREFIX = 'webco-chats-'
const DB_VERSION = 1
// Two stores, so the list never loads conversations: they grow with every tool result.
const INFO = 'sessions'
const MESSAGES = 'messages'
/**
 * The full text of long tool results (see KeptResult), by id. Sessions name them, but a result does
 * not know which: it is kept for KEPT_MS whatever happens to them, and swept by when it was kept.
 */
const RESULTS = 'results'
const KEPT_AT = 'keptAt'
/** How long a kept result stays: a session continued later than this reads the page again. */
const KEPT_MS = 7 * 24 * 60 * 60 * 1000
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
  async save({ messages, compaction, ...info }: Session, loaded?: number): Promise<SessionInfo> {
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
            all.put({ id: saved.id, messages, ...(compaction && { compaction }) })
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
    return { ...details.data, ...conversation.data }
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

  /** Deletes a session. The results it kept stay until they are swept (see `sweep`). */
  async delete(id: string): Promise<void> {
    await this.run('readwrite', (infos, all) => {
      infos.delete(id)
      all.delete(id)
      return () => undefined
    })
  }

  /** Keeps the full text of a long tool result for KEPT_MS, and resolves with its id. */
  async keep(result: ResultToKeep): Promise<string> {
    const id = `r_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
    const record: KeptResult = { ...result, id, keptAt: Date.now() }
    await this.run('readwrite', (_infos, _all, results) => {
      results.add(record)
      return () => undefined
    })
    return id
  }

  /**
   * Deletes the results kept more than KEPT_MS ago. By the index, so their texts are never loaded.
   * The side panel calls it as it starts.
   */
  async sweep(): Promise<void> {
    await this.run('readwrite', (_infos, _all, results) => {
      const old = results.index(KEPT_AT).openKeyCursor(IDBKeyRange.upperBound(Date.now() - KEPT_MS))
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
      req.onupgradeneeded = () => {
        const db = req.result
        db.createObjectStore(INFO, { keyPath: 'id' })
        db.createObjectStore(MESSAGES, { keyPath: 'id' })
        db.createObjectStore(RESULTS, { keyPath: 'id' }).createIndex(KEPT_AT, KEPT_AT)
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
