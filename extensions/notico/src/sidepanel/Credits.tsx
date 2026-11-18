import type { Credits, Pack, Packs } from '@cofun/worker-client'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { track } from '../analytics'
import {
  dayText,
  daysText,
  leftFrom,
  sourceLeftText,
  lastDays,
  usdText,
  when,
  wholeCredits,
  type CreditsState,
} from '../credits'
import { Page } from './Header'
import { History, type ReadGrants } from './History'
import { Icon } from './icons'

/** Buying credits, as the Credits page needs it. */
export interface Buying {
  /** Reads the packs on offer. */
  packs: () => Promise<Packs>
  /** Opens Checkout for the pack of `quantity` in a new tab. Throws when it can't. */
  buy: (quantity: number) => Promise<void>
}

/**
 * The Credits page: what is valid now and the last 30 days. The balance by source, the packs to
 * buy, and the credits used per day. The credit history opens from the balance, in place of the
 * page, and leads back to it.
 */
export function CreditsPage({
  credits,
  grants,
  buying,
  onClose,
}: {
  credits: CreditsState
  /** Reads the history of the credits, when the user opens it. */
  grants: ReadGrants
  buying: Buying
  onClose: () => void
}) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const backRef = useRef<HTMLButtonElement>(null)
  const historyRef = useRef<HTMLButtonElement>(null)

  // The focus follows: to Back when the history opens, and to what opened it when it closes.
  const shown = useRef(historyOpen)
  useEffect(() => {
    if (shown.current === historyOpen) return
    shown.current = historyOpen
    ;(historyOpen ? backRef : historyRef).current?.focus()
  }, [historyOpen])

  return (
    <Page
      id="credits"
      title={historyOpen ? 'Credit history' : 'Credits'}
      backRef={backRef}
      onBack={historyOpen ? () => setHistoryOpen(false) : onClose}
    >
      {historyOpen ? (
        <History read={grants} />
      ) : (
        <>
          <section className="page-section" aria-labelledby="credits-balance">
            <h2 id="credits-balance">Balance</h2>
            {credits.status === 'loading' && <p className="account-detail">Loading credits…</p>}
            {/* No Try again: opening the page reads the credits again. */}
            {credits.status === 'unavailable' && (
              <p role="alert">Your credits could not be loaded. You can still ask questions.</p>
            )}
            {credits.status === 'ready' && <Balance credits={credits.credits} />}
            {/* Read only when it is opened, so it is there to open whether or not the credits could be read. */}
            <button
              ref={historyRef}
              type="button"
              className="row-link"
              onClick={() => {
                track({ event: 'credits_history_opened' })
                setHistoryOpen(true)
              }}
            >
              <span className="grow">Credit history</span>
              <Icon name="forward" />
            </button>
          </section>

          <BuyCredits buying={buying} />

          {credits.status === 'ready' && (
            <section className="page-section" aria-labelledby="credits-usage">
              <h2 id="credits-usage">Usage</h2>
              <Usage usage={credits.credits.usage} />
            </section>
          )}
        </>
      )}
    </Page>
  )
}

/** The balance as one number, then one line per source: the free weekly credits, bought credits, and any granted by hand. */
function Balance({ credits }: { credits: Credits }) {
  const { balance, free } = credits
  const added = leftFrom(credits, 'manual')
  // A source a newer worker names, which the panel does not know.
  const other = credits.grants
    .filter((grant) => !['free', 'purchase', 'manual'].includes(grant.source))
    .reduce((sum, grant) => sum + grant.left, 0)
  return (
    <>
      <p className="balance">
        <span className="balance-value">{wholeCredits(balance)}</span> <span className="account-detail">credits</span>
      </p>
      <ul className="balance-lines" aria-label="Credits by source">
        <li>
          <span>Free this week</span>
          <span className="account-detail">
            {free.started
              ? `${wholeCredits(leftFrom(credits, 'free'))} · renew after ${when(free.until)}`
              : `${wholeCredits(free.toCome)} · valid for ${daysText(free.lastsMs)} from your next question`}
          </span>
        </li>
        <li>
          <span>Bought</span>
          <span className="account-detail">{sourceLeftText(credits, 'purchase')}</span>
        </li>
        {added > 0 && (
          <li>
            <span>From Cofun</span>
            <span className="account-detail">{sourceLeftText(credits, 'manual')}</span>
          </li>
        )}
        {other > 0 && (
          <li>
            <span>Other</span>
            <span className="account-detail">{wholeCredits(other)}</span>
          </li>
        )}
      </ul>
    </>
  )
}

/**
 * The packs of credits on offer, read when the page opens, one row each with its price and a Buy
 * button, and the rules in one line under them. Buy opens Stripe's Checkout in a new tab; the
 * credits arrive once the payment goes through, and the panel reads them again when the user comes
 * back to it.
 */
function BuyCredits({ buying }: { buying: Buying }) {
  const [packs, setPacks] = useState<{ status: 'loading' } | { status: 'ready'; packs: Pack[] } | { status: 'failed' }>(
    { status: 'loading' },
  )
  const [checkout, setCheckout] = useState<'idle' | 'opening' | 'opened' | 'failed'>('idle')

  useEffect(() => {
    // A page that closed takes no answer.
    let open = true
    buying.packs().then(
      ({ packs }) => open && setPacks({ status: 'ready', packs }),
      () => open && setPacks({ status: 'failed' }),
    )
    return () => void (open = false)
  }, [])

  async function buy(quantity: number) {
    setCheckout('opening')
    try {
      await buying.buy(quantity)
      setCheckout('opened')
    } catch {
      setCheckout('failed')
    }
  }

  return (
    <section className="page-section" aria-labelledby="credits-buy">
      <h2 id="credits-buy">Buy credits</h2>
      {packs.status === 'loading' && <p className="account-detail">Loading…</p>}
      {/* No Try again: opening the page reads the packs again. */}
      {packs.status === 'failed' && <p role="alert">Buying credits is unavailable right now.</p>}
      {packs.status === 'ready' && (
        <>
          <ul className="packs" aria-label="Packs of credits">
            {packs.packs.map(({ quantity, credits, usdCents }) => {
              const amount = wholeCredits(credits * 1_000_000)
              return (
                <li key={quantity}>
                  <span className="grow">{amount} credits</span>
                  <span className="account-detail">{usdText(usdCents)}</span>
                  <button
                    type="button"
                    className="pack-buy"
                    aria-label={`Buy ${amount} credits for ${usdText(usdCents)}`}
                    disabled={checkout === 'opening'}
                    onClick={() => void buy(quantity)}
                  >
                    Buy
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="fine">
            One-time purchase, not a subscription, valid for a year, spent after your free credits. Questions answered
            with your own key (OpenRouter) spend credits only on pages rendered and web searches made for them. Tax may
            be added at checkout.
          </p>
          {checkout === 'opened' && (
            <p role="status" className="account-detail">
              Checkout opened in a new tab. Your credits show here once the payment goes through.
            </p>
          )}
          {checkout === 'failed' && <p role="alert">Checkout could not be opened. Try again in a moment.</p>}
        </>
      )}
    </section>
  )
}

/**
 * Credits used per day over the last days the worker reports, as a bar chart: the total and today's
 * count above it, and the day under the pointer or the keyboard's choice in place of them. The
 * arrow keys move between days. A table of the days that used any stays for screen readers.
 */
function Usage({ usage }: { usage: Credits['usage'] }) {
  const days = lastDays(Date.now(), usage.days)
  const used = new Map(usage.byDay.map(({ day, microCredits }) => [day, microCredits]))
  // Only the days the chart shows, so the total and the bars agree even if the worker's day is not the panel's.
  const total = days.reduce((sum, day) => sum + (used.get(day) ?? 0), 0)
  const most = Math.max(...days.map((day) => used.get(day) ?? 0))
  const [picked, setPicked] = useState<number>()
  const pickedDay = picked === undefined ? undefined : days[picked]

  function onKeyDown(e: KeyboardEvent) {
    const last = days.length - 1
    const at = picked ?? last
    const to = { ArrowLeft: Math.max(at - 1, 0), ArrowRight: Math.min(at + 1, last), Home: 0, End: last }[e.key]
    if (to === undefined) return
    e.preventDefault()
    setPicked(to)
  }

  return (
    <div className="usage-chart">
      {/* Says the day the pointer or the keyboard is on, as it moves. */}
      <p className="usage-sum" role="status">
        {pickedDay === undefined ? (
          <>
            <span>
              <strong>{wholeCredits(total, 'nearest')}</strong> credits in the last {usage.days} days
            </span>
            <span className="account-detail">Today {wholeCredits(used.get(days.at(-1)!) ?? 0, 'nearest')}</span>
          </>
        ) : (
          <>
            <span>{dayText(pickedDay)}</span>
            <span className="account-detail">{wholeCredits(used.get(pickedDay) ?? 0, 'nearest')} credits</span>
          </>
        )}
      </p>
      {/* The table under it says the same to a screen reader, all at once. */}
      <div
        className="usage-bars"
        role="group"
        aria-label="Credits used per day: use the arrow keys to see each day"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => setPicked((at) => at ?? days.length - 1)}
        onBlur={() => setPicked(undefined)}
        onMouseLeave={() => setPicked(undefined)}
      >
        {days.map((day, i) => {
          const micro = used.get(day) ?? 0
          return (
            <span
              key={day}
              className={i === picked ? 'usage-bar picked' : micro > 0 ? 'usage-bar used' : 'usage-bar'}
              style={{ height: most > 0 && micro > 0 ? `${Math.max((micro / most) * 100, 6)}%` : undefined }}
              onMouseEnter={() => setPicked(i)}
            />
          )
        })}
      </div>
      <p className="usage-axis" aria-hidden="true">
        <span>{dayText(days[0], true)}</span>
        <span>{dayText(days.at(-1)!, true)}</span>
      </p>
      {usage.byDay.length === 0 ? (
        <p className="sr-only">No credits used in the last {usage.days} days.</p>
      ) : (
        <table className="sr-only">
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
      )}
    </div>
  )
}
