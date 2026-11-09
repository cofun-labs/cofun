// Saved sessions, kept on this device in IndexedDB. They never go to the worker.
import type { HistoryMessage } from './agent'

/** What the session list shows; the conversation itself is loaded only when a session opens. */
export interface SessionInfo {
  id: string
  /** The session's first question, for now. */
  title: string
  /** The Notion page open when the session started, if there was one. */
  page?: { title: string; url: string }
  createdAt: number
  updatedAt: number
}

export interface Session extends SessionInfo {
  messages: HistoryMessage[]
}

const DB_NAME = 'notion-copilot'
// Two stores, so the list never loads conversations: they grow with every tool result.
const INFO = 'sessions'
const MESSAGES = 'messages'
const TITLE_LENGTH = 100

let db: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(INFO, { keyPath: 'id' })
      req.result.createObjectStore(MESSAGES, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }).catch((err) => {
    // Let the next call try again instead of failing forever.
    db = undefined
    throw err
  })
  return db
}

/** Runs one transaction over both stores; resolves with `fn`'s result once it has committed. */
async function run<T>(
  mode: IDBTransactionMode,
  fn: (info: IDBObjectStore, messages: IDBObjectStore) => () => T,
): Promise<T> {
  const tx = (await open()).transaction([INFO, MESSAGES], mode)
  const result = fn(tx.objectStore(INFO), tx.objectStore(MESSAGES))
  return new Promise<T>((resolve, reject) => {
    tx.oncomplete = () => resolve(result())
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function saveSession({ messages, ...info }: Session): Promise<void> {
  await run('readwrite', (infos, all) => {
    infos.put(info)
    all.put({ id: info.id, messages })
    return () => undefined
  })
}

export async function getSession(id: string): Promise<Session | undefined> {
  return run('readonly', (infos, all) => {
    const info = infos.get(id) as IDBRequest<SessionInfo | undefined>
    const stored = all.get(id) as IDBRequest<{ messages: HistoryMessage[] } | undefined>
    return () => info.result && { ...info.result, messages: stored.result?.messages ?? [] }
  })
}

export async function deleteSession(id: string): Promise<void> {
  await run('readwrite', (infos, all) => {
    infos.delete(id)
    all.delete(id)
    return () => undefined
  })
}

/** All saved sessions, most recently used first. */
export async function listSessions(): Promise<SessionInfo[]> {
  const all = await run('readonly', (infos) => {
    const req = infos.getAll() as IDBRequest<SessionInfo[]>
    return () => req.result
  })
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** A session's title: its first question, on one line and cut to a readable length. */
export function titleFor(messages: HistoryMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  const line = (first?.text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line
}

/** Identifies a Notion page by its URL without the query or fragment, which change as the user browses. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url
  }
}

/** The pages sessions started on, once each, with the newest title seen for each. */
export function sessionPages(sessions: SessionInfo[]): { key: string; title: string }[] {
  const pages = new Map<string, string>()
  for (const s of sessions) if (s.page && !pages.has(pageKey(s.page.url))) pages.set(pageKey(s.page.url), s.page.title)
  return [...pages].map(([key, title]) => ({ key, title }))
}

/** Sessions whose title contains `query` (ignoring case) and, if `page` is set, that started on that page. */
export function filterSessions<T extends SessionInfo>(sessions: T[], filter: { query?: string; page?: string }): T[] {
  const query = filter.query?.trim().toLowerCase()
  return sessions.filter(
    (s) =>
      (!query || s.title.toLowerCase().includes(query)) &&
      (!filter.page || (s.page !== undefined && pageKey(s.page.url) === filter.page)),
  )
}
