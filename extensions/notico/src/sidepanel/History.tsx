import { useEffect, useRef, useState } from 'react'
import { grantDatesText, grantLeftText, grantTitle, wholeCredits, type GrantsPage } from '../credits'

/** How the history is read from the worker: a page of grants, from where the one before ended. */
export type ReadGrants = (before?: string) => Promise<GrantsPage>

/**
 * The history of the user's credits: every grant they were given (free weekly credits, purchases,
 * credits granted by hand), newest first, each with its dates, what a purchase cost, and what is
 * left, went unspent, or was taken back. No usage: that is on the Credits page, for the last 30
 * days. Read a page at a time, when it opens, not with the credits; a read that fails keeps what
 * was read before it, says so here, and touches nothing else.
 */
export function History({ read }: { read: ReadGrants }) {
  const [pages, setPages] = useState<GrantsPage[]>([])
  const [reading, setReading] = useState(true)
  // Whether the last read failed: it then offers to try again, also while trying again.
  const [failed, setFailed] = useState(false)
  // Only the newest read counts, and none once the history is gone.
  const reads = useRef(0)
  const next = pages.at(-1)?.next ?? null
  // Where the focus goes when a read the button asked for ends and takes the button away: the first
  // row it added, or the note that there are none. It stays focusable, or the focus would fall off it.
  const [focusFrom, setFocusFrom] = useState<number>()
  const focusRef = useRef<HTMLElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  async function more() {
    const mine = ++reads.current
    // The button stays, so the focus stays on it; it only does nothing until the read ends.
    const asked = document.activeElement !== null && document.activeElement === buttonRef.current
    setReading(true)
    try {
      const page = await read(next ?? undefined)
      if (mine !== reads.current) return
      if (asked && page.next === null) setFocusFrom(pages.reduce((sum, page) => sum + page.grants.length, 0))
      setPages((pages) => [...pages, page])
      setFailed(false)
    } catch {
      if (mine !== reads.current) return
      setFailed(true)
    }
    setReading(false)
  }

  useEffect(() => {
    void more()
    return () => void reads.current++
  }, [])

  useEffect(() => {
    if (focusFrom !== undefined) focusRef.current?.focus()
  }, [focusFrom])

  const given = pages.flatMap((page) => page.grants)
  // One moment for the whole list: what has expired by now.
  const now = Date.now()

  return (
    <div className="history">
      {given.length > 0 && (
        <ul className="history-list" aria-label="Credits you were given">
          {given.map((grant, i) => {
            const left = grantLeftText(grant, now)
            return (
              <li
                key={i}
                ref={i === focusFrom ? (li) => void (focusRef.current = li) : undefined}
                tabIndex={i === focusFrom ? -1 : undefined}
              >
                <span className="grow">
                  <span className="history-title">{grantTitle(grant)}</span>
                  <span className="account-detail">{grantDatesText(grant, now)}</span>
                </span>
                <span className="history-amount">
                  <span className={grant.revoked === undefined ? 'history-plus' : 'history-plus muted'}>
                    +{wholeCredits(grant.amount)}
                  </span>
                  <span className={left.taken ? 'account-detail taken' : 'account-detail'}>{left.text}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {given.length === 0 && pages.length > 0 && !reading && (
        <p
          className="account-detail"
          ref={focusFrom === 0 ? (p) => void (focusRef.current = p) : undefined}
          tabIndex={focusFrom === 0 ? -1 : undefined}
        >
          No credits yet. Your free credits start with your next question.
        </p>
      )}
      {/* Always there, so a screen reader hears each read start. */}
      <p role="status" className="account-detail history-status">
        {reading ? 'Loading…' : ''}
      </p>
      {failed && !reading && <p role="alert">Your credits could not be loaded.</p>}
      {(failed || next !== null) && (
        <button
          ref={buttonRef}
          type="button"
          className={failed ? 'primary' : 'history-more'}
          aria-disabled={reading || undefined}
          onClick={() => void (reading || more())}
        >
          {failed ? 'Try again' : 'Show earlier'}
        </button>
      )}
    </div>
  )
}
