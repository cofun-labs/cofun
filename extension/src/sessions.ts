// Saved sessions, kept on this device in IndexedDB. They never go to the worker.
import type { HistoryMessage } from './agent'

export interface Session {
  id: string
  /** The session's first question, for now. */
  title: string
  /** The Notion page open when the session started, if there was one. */
  page?: { title: string; url: string }
  createdAt: number
  updatedAt: number
  messages: HistoryMessage[]
}

const DB_NAME = 'notion-copilot'
const STORE = 'sessions'
const TITLE_LENGTH = 100

let db: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }).catch((err) => {
    // Let the next call try again instead of failing forever.
    db = undefined
    throw err
  })
  return db
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const tx = (await open()).transaction(STORE, mode)
  const req = fn(tx.objectStore(STORE))
  return new Promise<T>((resolve, reject) => {
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function saveSession(session: Session): Promise<void> {
  await run('readwrite', (s) => s.put(session))
}

export async function getSession(id: string): Promise<Session | undefined> {
  return run('readonly', (s) => s.get(id) as IDBRequest<Session | undefined>)
}

export async function deleteSession(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id))
}

/** All saved sessions, most recently used first. */
export async function listSessions(): Promise<Session[]> {
  const all = await run('readonly', (s) => s.getAll() as IDBRequest<Session[]>)
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
export function sessionPages(sessions: Session[]): { key: string; title: string }[] {
  const pages = new Map<string, string>()
  for (const s of sessions) if (s.page && !pages.has(pageKey(s.page.url))) pages.set(pageKey(s.page.url), s.page.title)
  return [...pages].map(([key, title]) => ({ key, title }))
}

/** Sessions whose title contains `query` (ignoring case) and, if `page` is set, that started on that page. */
export function filterSessions(sessions: Session[], filter: { query?: string; page?: string }): Session[] {
  const query = filter.query?.trim().toLowerCase()
  return sessions.filter(
    (s) =>
      (!query || s.title.toLowerCase().includes(query)) &&
      (!filter.page || (s.page !== undefined && pageKey(s.page.url) === filter.page)),
  )
}
