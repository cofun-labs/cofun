import { useEffect, useRef } from 'react'
import { creditsText, dayText, daysText, when, wholeCredits, type Credits, type CreditsState } from '../credits'
import { Avatar, useAccount } from './Account'
import { Icon } from './icons'

/** The settings page: the account, the plan, the credits with their dates, and usage per day. */
export function Settings({
  credits,
  onRetry,
  onClose,
}: {
  credits: CreditsState
  /** Reads the credits again, after a read that failed. */
  onRetry: () => void
  onClose: () => void
}) {
  const account = useAccount()

  // Escape goes back to the chat, wherever the focus is. Not when something above the page took
  // the key for itself: the account menu, open over the page, closes on Escape and stops there.
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) close.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <section id="settings" aria-labelledby="settings-title">
      <div className="sheet-head">
        <button className="icon-button" aria-label="Back" title="Back" autoFocus onClick={onClose}>
          <Icon name="back" />
        </button>
        <h2 id="settings-title">Settings</h2>
      </div>

      <section className="card" aria-labelledby="settings-account">
        <h3 id="settings-account">Account</h3>
        <div className="settings-account">
          <Avatar {...account} />
          <div>
            <p className="account-name">{account.name}</p>
            {account.email && account.email !== account.name && <p className="account-detail">{account.email}</p>}
          </div>
        </div>
      </section>

      {/* The plan's actions (upgrading, managing a subscription) belong in this section. */}
      <section className="card" aria-labelledby="settings-plan">
        <h3 id="settings-plan">Plan</h3>
        <p className="settings-value">Free</p>
        <p className="account-detail">Free credits every week.</p>
      </section>

      <section className="card" aria-labelledby="settings-credits">
        <h3 id="settings-credits">Credits</h3>
        {credits.status === 'loading' && <p className="account-detail">Loading credits…</p>}
        {credits.status === 'unavailable' && (
          <>
            <p role="alert">Your credits could not be loaded. You can still ask questions.</p>
            <button className="primary" onClick={onRetry}>
              Try again
            </button>
          </>
        )}
        {credits.status === 'ready' && <Balance credits={credits.credits} />}
      </section>

      {credits.status === 'ready' && (
        <section className="card" aria-labelledby="settings-usage">
          <h3 id="settings-usage">Usage</h3>
          <Usage usage={credits.credits.usage} />
        </section>
      )}
    </section>
  )
}

/** What is left, each lot of credits with when it expires, and when the next free credits arrive. */
function Balance({ credits: { balance, free, grants } }: { credits: Credits }) {
  return (
    <>
      <p className="settings-value">{balance > 0 ? `${creditsText(balance)} left` : 'No credits left'}</p>
      {balance < 0 && (
        <p className="account-detail">
          {free.started
            ? `You overspent ${creditsText(-balance)}. They come out of the next credits you get.`
            : // The balance already counts the free credits to come: this is what they leave unpaid.
              `After your next free credits you still owe ${creditsText(-balance)}. They come out of the credits after those.`}
        </p>
      )}
      <ul className="grants" aria-label="Your credits">
        {grants.map((grant, i) => (
          <li key={i}>
            <span>{grant.source === 'free' ? 'Free weekly credits' : 'Added credits'}</span>
            <span className="account-detail">
              {grant.left > 0
                ? `${wholeCredits(grant.left)} left, expire ${when(grant.expiresAt)}`
                : `Used up, until ${when(grant.expiresAt)}`}
            </span>
          </li>
        ))}
        {!free.started && (
          <li>
            <span>Free weekly credits</span>
            <span className="account-detail">
              {free.toCome > 0
                ? `${wholeCredits(free.toCome)}, not started: valid for ${daysText(free.lastsMs)} from your next question`
                : 'Not started: they go to what you overspent'}
            </span>
          </li>
        )}
      </ul>
      <p className="account-detail">
        {free.started
          ? `Your next free credits arrive with your first question after ${when(free.until)}.`
          : 'Your free credits start with your next question.'}
      </p>
    </>
  )
}

/** Credits used on each day that used any, newest first. */
function Usage({ usage }: { usage: Credits['usage'] }) {
  if (usage.byDay.length === 0) return <p className="account-detail">No credits used in the last {usage.days} days.</p>
  return (
    <table className="usage">
      <caption>Credits used per day, last {usage.days} days</caption>
      <tbody>
        {usage.byDay.map(({ day, microCredits }) => (
          <tr key={day}>
            <th scope="row">{dayText(day)}</th>
            <td>{wholeCredits(microCredits, 'nearest')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
