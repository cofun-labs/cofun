import { useEffect, useState } from 'react'
import { filterSessions, sessionPages, type SessionInfo, type SessionStore } from '../sessions'

/** The list of saved sessions: search, filter by page, open, and delete. */
export function Sessions({
  store,
  currentId,
  saved,
  onOpen,
  onDeleted,
}: {
  store: SessionStore
  currentId?: string
  /** Changes whenever a session is saved, so the list stays current while it is open. */
  saved: number
  onOpen: (id: string) => void
  onDeleted: (id: string) => void
}) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState('')
  // Deleting takes a second click on the same row, so a stray click loses nothing.
  const [confirming, setConfirming] = useState<string>()

  async function load() {
    try {
      setSessions(await store.list())
    } catch (err) {
      setError(`Could not load sessions: ${(err as Error).message}`)
    }
  }

  useEffect(() => {
    void load()
  }, [saved])

  async function remove(id: string) {
    if (confirming !== id) return setConfirming(id)
    setConfirming(undefined)
    try {
      await store.delete(id)
      onDeleted(id)
      await load()
    } catch (err) {
      setError(`Could not delete the session: ${(err as Error).message}`)
    }
  }

  const pages = sessions ? sessionPages(sessions) : []
  // Deleting the last session on the chosen page removes that choice; show every page again.
  const activePage = pages.some((p) => p.key === page) ? page : ''
  const shown = sessions ? filterSessions(sessions, { query, page: activePage }) : []

  return (
    <main id="sessions">
      <div className="session-filters">
        <input type="search" placeholder="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
        {pages.length > 0 && (
          <select value={activePage} onChange={(e) => setPage(e.target.value)} aria-label="Notion page">
            <option value="">All pages</option>
            {pages.map((p) => (
              <option key={p.key} value={p.key}>
                {p.title || p.key}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {sessions && shown.length === 0 && (
        <div className="empty">{sessions.length === 0 ? 'No sessions yet.' : 'No matching sessions.'}</div>
      )}
      <ul className="session-list">
        {shown.map((s) => (
          <li key={s.id} className={s.id === currentId ? 'current' : undefined}>
            <button className="session-open" onClick={() => onOpen(s.id)}>
              <span className="session-title">{s.title || 'Untitled'}</span>
              <span className="session-meta">
                {s.page && <>{s.page.title || 'Untitled page'} · </>}
                {formatTime(s.updatedAt)}
              </span>
            </button>
            <button
              className="session-delete"
              onClick={() => void remove(s.id)}
              onBlur={() => setConfirming(undefined)}
              title="Delete session"
            >
              {confirming === s.id ? 'Delete?' : '×'}
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}

function formatTime(time: number): string {
  const date = new Date(time)
  const today = new Date().toDateString() === date.toDateString()
  return today
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
