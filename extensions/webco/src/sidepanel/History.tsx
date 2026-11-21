import { useEffect, useState } from 'react'
import type { PastGrant } from '@cofun/worker-client'
import { grantDatesText, grantLeftText, grantTitle, wholeCredits } from '@cofun/worker-client/credits'

/** How the history is read from the worker: every grant, at once. */
export type ReadGrants = () => Promise<PastGrant[]>

/**
 * The history of the user's credits: every grant they were given (free weekly credits, purchases,
 * credits granted by hand), newest first, each with its dates, what a purchase cost, and what is
 * left, went unspent, or was taken back. No usage: that is on the Credits page, for the last 30
 * days. Read when it opens, not with the credits; a read that fails says so here and touches
 * nothing else.
 */
export function History({ read }: { read: ReadGrants }) {
  const [given, setGiven] = useState<PastGrant[]>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    // A history that closed takes no answer. No Try again: opening the history reads it again.
    let open = true
    read().then(
      (grants) => open && setGiven(grants),
      () => open && setFailed(true),
    )
    return () => void (open = false)
  }, [])

  // One moment for the whole list: what has expired by now.
  const now = Date.now()

  return (
    <div className="history">
      {given && given.length > 0 && (
        <ul className="history-list" aria-label="Credits you were given">
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
        <p className="account-detail">No credits yet. Your free credits start with your next question.</p>
      )}
      {!given && !failed && <p className="account-detail">Loading…</p>}
      {failed && <p role="alert">Your credits could not be loaded.</p>}
    </div>
  )
}
