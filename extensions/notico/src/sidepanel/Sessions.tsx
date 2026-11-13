import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { filterSessions, type SessionInfo, type SessionStore } from '../sessions'

/** The list of saved sessions: search by title, open, and delete. */
export function Sessions({
  store,
  currentId,
  saved,
  onOpen,
  onClose,
  onDeleted,
}: {
  store: SessionStore
  currentId?: string
  /** Changes whenever a session is saved, so the list stays current while it is open. */
  saved: number
  /** Resolves false when the session no longer exists. */
  onOpen: (id: string) => Promise<boolean>
  onClose: () => void
  /** Called before the session is deleted. */
  onDeleted: (id: string) => void
}) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  // Deleting takes a second click on the same row, so a stray click loses nothing.
  const [confirming, setConfirming] = useState<string>()

  // Loads can overlap (a save lands during a delete); only the newest one may update the list.
  const loads = useRef(0)

  async function load() {
    const n = ++loads.current
    try {
      const list = await store.list()
      if (n !== loads.current) return
      setSessions(list)
      setError(undefined)
    } catch (err) {
      if (n === loads.current) setError(`Could not load sessions: ${(err as Error).message}`)
    }
  }

  useEffect(() => {
    void load()
  }, [saved])

  // Escape closes the list wherever the focus is: deleting a session leaves it on nothing.
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Not when something above the list took the key for itself: the account menu, open over the
      // list, closes on Escape and stops there. In the search box, Escape first clears what was typed.
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (!(e.target instanceof HTMLInputElement && e.target.value)) close.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  async function remove(id: string) {
    if (confirming !== id) return setConfirming(id)
    setConfirming(undefined)
    try {
      // First, so a reply still coming in for the open session stops and can't save it back.
      onDeleted(id)
      await store.delete(id)
      await load()
    } catch (err) {
      setError(`Could not delete the session: ${(err as Error).message}`)
    }
  }

  async function openSession(id: string) {
    try {
      if (await onOpen(id)) return
      await load()
      setError('This session no longer exists.')
    } catch (err) {
      setError(`Could not open the session: ${(err as Error).message}`)
    }
  }

  const shown = sessions ? filterSessions(sessions, query) : []

  return (
    <section id="sessions" role="dialog" aria-label="Sessions">
      <div className="sheet-head">
        <h2>Sessions</h2>
        <button className="icon-button" aria-label="Close" title="Close" autoFocus onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <label className="session-search">
        <Icon name="search" />
        <input
          type="search"
          placeholder="Search sessions"
          aria-label="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {error && <div className="error">{error}</div>}
      {sessions && shown.length === 0 && (
        <div className="empty">{sessions.length === 0 ? 'No sessions yet.' : 'No matching sessions.'}</div>
      )}
      <ul className="session-list">
        {shown.map((s) => (
          <li key={s.id} className={s.id === currentId ? 'current' : undefined}>
            <button
              className="session-open"
              aria-current={s.id === currentId || undefined}
              onClick={() => void openSession(s.id)}
            >
              <span className="session-title">{s.title || 'Untitled'}</span>
              <span className="session-meta">
                {s.page && <>{s.page.title || 'Untitled page'} · </>}
                {formatTime(s.updatedAt)}
              </span>
            </button>
            <button
              className={confirming === s.id ? 'session-delete confirming' : 'session-delete'}
              onClick={() => void remove(s.id)}
              onBlur={() => setConfirming(undefined)}
              title="Delete session"
              aria-label={confirming === s.id ? undefined : 'Delete session'}
            >
              {confirming === s.id ? 'Delete?' : <Icon name="trash" />}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function formatTime(time: number): string {
  const date = new Date(time)
  const today = new Date().toDateString() === date.toDateString()
  return today
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
