import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { ChatMenu } from './Save'
import { filterSessions, type ListedSession, type SessionStore } from '../sessions'

/** How opening a session went: `gone` when it no longer exists, `unreadable` when it can't be read. */
export type OpenResult = 'opened' | 'gone' | 'unreadable'

const UNREADABLE = "This chat was saved by an earlier version of Notico and can't be opened. You can delete it."

/**
 * The list of saved sessions: search by title, open, save to Notion, and delete. One that can't be read
 * can only be deleted.
 */
export function Sessions({
  store,
  currentId,
  saved,
  onOpen,
  onClose,
  onDeleted,
  saveBlocked,
  onSave,
}: {
  store: SessionStore
  currentId?: string
  /** Changes whenever a session is saved, so the list stays current while it is open. */
  saved: number
  onOpen: (id: string) => Promise<OpenResult>
  onClose: () => void
  /** Called before the session is deleted. */
  onDeleted: (id: string) => void
  /** Why a chat can't be saved to Notion now, if it can't. */
  saveBlocked?: string
  /** Saves a chat to Notion as a new page, resolving with its link. */
  onSave: (id: string) => Promise<{ url: string }>
}) {
  const [sessions, setSessions] = useState<ListedSession[] | null>(null)
  // Sessions whose details read fine but whose conversation didn't, found when the user opened them.
  const [unopenable, setUnopenable] = useState<ReadonlySet<string>>(new Set())
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
      if (n === loads.current) setError(`Could not load chats: ${(err as Error).message}`)
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
      setError(`Could not delete the chat: ${(err as Error).message}`)
    }
  }

  async function openSession(id: string) {
    try {
      const result = await onOpen(id)
      if (result === 'opened') return
      if (result === 'unreadable') {
        setUnopenable((ids) => new Set(ids).add(id))
        return setError(UNREADABLE)
      }
      await load()
      setError('This chat no longer exists.')
    } catch (err) {
      setError(`Could not open the chat: ${(err as Error).message}`)
    }
  }

  const shown = sessions ? filterSessions(sessions, query) : []

  return (
    <section id="sessions" role="dialog" aria-label="Chats">
      <div className="sheet-head">
        <h2>Chats</h2>
        <button className="icon-button" aria-label="Close" title="Close" autoFocus onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <label className="session-search">
        <Icon name="search" />
        <input
          type="search"
          placeholder="Search chats"
          aria-label="Search chats"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {sessions && shown.length === 0 && (
        <div className="empty">{sessions.length === 0 ? 'No chats yet.' : 'No matching chats.'}</div>
      )}
      <ul className="session-list">
        {shown.map((s) => (
          <li key={s.id} className={s.id === currentId ? 'current' : undefined}>
            {'unreadable' in s || unopenable.has(s.id) ? (
              <div className="session-open unreadable">
                <span className="session-title">{'title' in s && s.title ? s.title : 'Unreadable chat'}</span>
                <span className="session-meta">Saved by an earlier version; it can't be opened</span>
              </div>
            ) : (
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
            )}
            {!('unreadable' in s || unopenable.has(s.id)) && (
              <ChatMenu blocked={saveBlocked} onSave={() => onSave(s.id)} />
            )}
            <button
              className={confirming === s.id ? 'session-delete confirming' : 'session-delete'}
              onClick={() => void remove(s.id)}
              onBlur={() => setConfirming(undefined)}
              title="Delete chat"
              aria-label={confirming === s.id ? undefined : 'Delete chat'}
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
