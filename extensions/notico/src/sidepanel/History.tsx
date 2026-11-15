import { useEffect, useRef, useState } from 'react'
import { grantDatesText, grantLeftText, grantTitle, wholeCredits, type PastGrant } from '../credits'

/** How the history is read from the worker: every grant, at once. */
export type ReadGrants = () => Promise<PastGrant[]>

/**
 * The history of the user's credits: every grant they were given (free weekly credits, purchases,
 * credits granted by hand), newest first, each with its dates, what a purchase cost, and what is
 * left, went unspent, or was taken back. No usage: that is on the Credits page, for the last 30
 * days. Read when it opens, not with the credits; a read that fails says so here, offers to try
 * again, and touches nothing else.
 */
export function History({ read }: { read: ReadGrants }) {
  const [given, setGiven] = useState<PastGrant[]>()
  const [reading, setReading] = useState(true)
  // Whether the last read failed: it then offers to try again, also while trying again.
  const [failed, setFailed] = useState(false)
  // Only the newest read counts, and none once the history is gone.
  const reads = useRef(0)
  // Where the focus goes when Try again succeeds and takes the button away: what the read showed.
  const [moveFocus, setMoveFocus] = useState(false)
  const shownRef = useRef<HTMLElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  async function load() {
    const mine = ++reads.current
    // The button stays, so the focus stays on it; it only does nothing until the read ends.
    const asked = document.activeElement !== null && document.activeElement === buttonRef.current
    setReading(true)
    try {
      const grants = await read()
      if (mine !== reads.current) return
      setGiven(grants)
      setFailed(false)
      setMoveFocus(asked)
    } catch {
      if (mine !== reads.current) return
      setFailed(true)
    }
    setReading(false)
  }

  useEffect(() => {
    void load()
    return () => void reads.current++
  }, [])

  useEffect(() => {
    if (moveFocus) shownRef.current?.focus()
  }, [moveFocus])

  // One moment for the whole list: what has expired by now.
  const now = Date.now()
  // Focusable only to take the focus from the button that went away.
  const focusable = moveFocus ? -1 : undefined

  return (
    <div className="history">
      {given && given.length > 0 && (
        <ul
          className="history-list"
          aria-label="Credits you were given"
          ref={(ul) => void (shownRef.current = ul)}
          tabIndex={focusable}
        >
          {given.map((grant, i) => {
            const left = grantLeftText(grant, now)
            return (
              <li key={i}>
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
      {given && given.length === 0 && (
        <p className="account-detail" ref={(p) => void (shownRef.current = p)} tabIndex={focusable}>
          No credits yet. Your free credits start with your next question.
        </p>
      )}
      {/* Always there, so a screen reader hears each read start. */}
      <p role="status" className="account-detail history-status">
        {reading ? 'Loading…' : ''}
      </p>
      {failed && !reading && <p role="alert">Your credits could not be loaded.</p>}
      {failed && (
        <button
          ref={buttonRef}
          type="button"
          className="primary"
          aria-disabled={reading || undefined}
          onClick={() => void (reading || load())}
        >
          Try again
        </button>
      )}
    </div>
  )
}
