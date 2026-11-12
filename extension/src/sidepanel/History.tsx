import { useEffect, useRef, useState } from 'react'
import {
  creditsText,
  dayDateText,
  grantDatesText,
  sourceText,
  wholeCredits,
  type GrantsPage,
  type UsagePeriod,
} from '../credits'

/** How the history is read from the worker: a page of grants, and a period of usage, each from where the one before ended. */
export interface HistoryReads {
  grants: (before?: string) => Promise<GrantsPage>
  usage: (before?: string) => Promise<UsagePeriod>
}

/**
 * A list read a part at a time, each part from where the one before ended: what was read so far,
 * and whether a read is under way or failed. The first part is read when the list is first shown.
 * A read that fails keeps what was read before it, and `more` reads the same part again.
 */
function useParts<Part>(read: (before?: string) => Promise<Part>, nextOf: (part: Part) => string | null) {
  const [parts, setParts] = useState<Part[]>([])
  const [status, setStatus] = useState<'reading' | 'ready' | 'failed'>('reading')
  // Only the newest read counts, and none once the list is gone.
  const reads = useRef(0)
  const last = parts.at(-1)
  const next = last ? nextOf(last) : null

  async function more() {
    const mine = ++reads.current
    setStatus('reading')
    try {
      const part = await read(next ?? undefined)
      if (mine !== reads.current) return
      setParts((parts) => [...parts, part])
      setStatus('ready')
    } catch {
      if (mine === reads.current) setStatus('failed')
    }
  }

  useEffect(() => {
    void more()
    return () => void reads.current++
  }, [])

  return { parts, status, hasMore: next !== null, more: () => void more() }
}

/** What stands under a list: that it is being read, that the read failed with a way to try again, or a way to read on. */
function ReadOn({
  list: { status, hasMore, more },
  failed,
  label,
}: {
  list: { status: 'reading' | 'ready' | 'failed'; hasMore: boolean; more: () => void }
  failed: string
  label: string
}) {
  if (status === 'reading') {
    return (
      <p role="status" className="account-detail">
        Loading…
      </p>
    )
  }
  if (status === 'failed') {
    return (
      <>
        <p role="alert">{failed}</p>
        <button type="button" className="primary" onClick={more}>
          Try again
        </button>
      </>
    )
  }
  if (!hasMore) return null
  return (
    <button type="button" className="history-more" onClick={more}>
      {label}
    </button>
  )
}

/**
 * The history of the user's credits: every lot of credits they were given, newest first, and the
 * credits they used per day, further back than the settings page shows. Read when it opens, not
 * with the credits; a read that fails says so here and touches nothing else.
 */
export function History({ reads }: { reads: HistoryReads }) {
  const grants = useParts(reads.grants, (page) => page.next)
  const usage = useParts(reads.usage, (period) => period.earlier)
  const given = grants.parts.flatMap((page) => page.grants)
  const days = usage.parts.flatMap((period) => period.byDay)
  // The first day the periods read so far reach back to.
  const since = usage.parts.at(-1)?.from
  // One moment for the whole list: what has expired by now.
  const now = Date.now()

  return (
    <>
      <section className="card" aria-labelledby="history-grants">
        <h3 id="history-grants">Credits you were given</h3>
        {given.length > 0 && (
          <ul className="grants" aria-labelledby="history-grants">
            {given.map((grant, i) => (
              <li key={i}>
                <span className="history-grant">
                  <span>{sourceText(grant.source)}</span>
                  <span>{creditsText(grant.amount)}</span>
                </span>
                <span className="account-detail">{grantDatesText(grant, now)}</span>
              </li>
            ))}
          </ul>
        )}
        {given.length === 0 && grants.status === 'ready' && (
          <p className="account-detail">No credits yet. Your free credits start with your next question.</p>
        )}
        <ReadOn list={grants} failed="Your credits could not be loaded." label="Show older credits" />
      </section>

      <section className="card" aria-labelledby="history-usage">
        <h3 id="history-usage">Usage</h3>
        {days.length > 0 && since && (
          <table className="usage">
            <caption>Credits used per day since {dayDateText(since)}</caption>
            <tbody>
              {days.map(({ day, microCredits }) => (
                <tr key={day}>
                  <th scope="row">{dayDateText(day, true)}</th>
                  <td>{wholeCredits(microCredits, 'nearest')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {days.length === 0 && since && usage.status === 'ready' && (
          <p className="account-detail">
            {usage.hasMore ? `No credits used since ${dayDateText(since)}.` : 'No credits used yet.'}
          </p>
        )}
        <ReadOn list={usage} failed="Your usage could not be loaded." label="Show earlier usage" />
      </section>
    </>
  )
}
