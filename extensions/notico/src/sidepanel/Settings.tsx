import { useAuth } from '@clerk/chrome-extension'
import { useEffect, useState } from 'react'
import { loadAnalyticsEnabled, saveAnalyticsEnabled } from '../analytics'
import { allowDuckDuckGo } from '../duckduckgo/search'
import { loadDuckDuckGoSearch, saveDuckDuckGoSearch } from '../search'
import { loadMenuShown, saveMenuShown, watchMenuShown } from '../selection'
import type { ModelSettings } from '../models'
import { Avatar, useAccount } from './Account'
import { Page } from './Header'
import { ModelCard, Switch } from './Model'

/**
 * The Settings page: everything that isn't money. The model providers and their models, the account
 * with Sign out, where web searches go, whether the right-click menu has "Ask Notico", and whether
 * usage data is sent.
 */
export function Settings({
  model,
  onModelChange,
  at,
  onClose,
}: {
  /** Which model answers; undefined while it loads. */
  model?: ModelSettings
  /** Saves what `update` makes of the model settings as they are when it is saved. */
  onModelChange: (update: (settings: ModelSettings) => ModelSettings) => void
  /** The section to put the focus on as the page opens; Back has it otherwise. */
  at?: 'providers'
  onClose: () => void
}) {
  const { signOut, userId } = useAuth()
  const account = useAccount()

  return (
    <Page id="settings" title="Settings" onBack={onClose}>
      <ModelCard settings={model} onChange={onModelChange} focus={at === 'providers'} />

      {userId && <WebSearch userId={userId} />}

      <ContextMenu />

      <UsageData />

      <section className="page-section" aria-labelledby="settings-account">
        <h2 id="settings-account">Account</h2>
        <div className="settings-account">
          <Avatar {...account} />
          <div className="grow">
            <p className="account-name">{account.name}</p>
            {account.email && account.email !== account.name && <p className="account-detail">{account.email}</p>}
          </div>
          <button type="button" className="secondary" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </section>
    </Page>
  )
}

/**
 * Whether the right-click menu has "Ask Notico" (see selection.ts): on until the user turns it off,
 * for their Chrome profile, on every device it syncs to.
 */
function ContextMenu() {
  // Not known until storage was read: no switch shows until then, so it never shows a state to take back.
  const [shown, setShown] = useState<boolean>()

  useEffect(() => {
    let closed = false
    loadMenuShown().then(
      (stored) => !closed && setShown(stored),
      (err: unknown) => console.error('Could not read the menu setting', err),
    )
    const stop = watchMenuShown((next) => setShown(next))
    return () => {
      closed = true
      stop()
    }
  }, [])

  function change(next: boolean) {
    setShown(next)
    saveMenuShown(next).catch((err: unknown) => console.error('Could not save the menu setting', err))
  }

  return (
    <section className="page-section" aria-labelledby="settings-menu">
      <h2 id="settings-menu">Right-click menu</h2>
      <div className="settings-account">
        <div className="grow">
          <p>Show “Ask Notico”</p>
          <p id="settings-menu-detail" className="account-detail">
            Ask about text you select on any page.
          </p>
        </div>
        {shown !== undefined && (
          <Switch label="Show “Ask Notico”" checked={shown} describedBy="settings-menu-detail" onChange={change} />
        )}
      </div>
    </section>
  )
}

/**
 * Whether web searches open DuckDuckGo in a background tab, free, instead of going to the worker (see
 * search.ts): off until the user turns it on, for this account on this device. Turning it on asks Chrome for access
 * to DuckDuckGo, in the click itself; declined, it stays off.
 */
function WebSearch({ userId }: { userId: string }) {
  // Not known until storage was read: no switch shows until then, so it never shows a state to take back.
  const [on, setOn] = useState<boolean>()

  useEffect(() => {
    let closed = false
    loadDuckDuckGoSearch(userId).then(
      (stored) => !closed && setOn(stored),
      (err: unknown) => console.error('Could not read the web search setting', err),
    )
    return () => void (closed = true)
  }, [userId])

  function change(next: boolean) {
    const save = (value: boolean) => {
      setOn(value)
      saveDuckDuckGoSearch(userId, value).catch((err: unknown) =>
        console.error('Could not save the web search setting', err),
      )
    }
    if (!next) return save(false)
    // Chrome asks only during the click: nothing is awaited before the request.
    allowDuckDuckGo().then(
      (granted) => granted && save(true),
      (err: unknown) => console.error('Could not ask for access to DuckDuckGo', err),
    )
  }

  return (
    <section className="page-section" aria-labelledby="settings-search">
      <h2 id="settings-search">Web search</h2>
      <div className="settings-account">
        <div className="grow">
          <p>Search with DuckDuckGo</p>
          <p id="settings-search-detail" className="account-detail">
            Free: each search opens DuckDuckGo in a background tab and reads its results, instead of costing credits. If
            DuckDuckGo asks you to confirm you're a person, answer it in that tab, or switch this off.
          </p>
        </div>
        {on !== undefined && (
          <Switch label="Search with DuckDuckGo" checked={on} describedBy="settings-search-detail" onChange={change} />
        )}
      </div>
    </section>
  )
}

/**
 * Whether usage data is sent (see analytics.ts): on until the user turns it off, for this device.
 * Turned off, nothing more is sent, from this panel at once.
 */
function UsageData() {
  // Not known until storage was read: no switch shows until then, so it never shows a state to take back.
  const [enabled, setEnabled] = useState<boolean>()

  useEffect(() => {
    let closed = false
    loadAnalyticsEnabled().then(
      (stored) => !closed && setEnabled(stored),
      (err: unknown) => console.error('Could not read the usage data setting', err),
    )
    return () => void (closed = true)
  }, [])

  function change(next: boolean) {
    setEnabled(next)
    saveAnalyticsEnabled(next).catch((err: unknown) => console.error('Could not save the usage data setting', err))
  }

  return (
    <section className="page-section" aria-labelledby="settings-privacy">
      <h2 id="settings-privacy">Privacy</h2>
      <div className="settings-account">
        <div className="grow">
          <p>Share usage data</p>
          <p id="settings-privacy-detail" className="account-detail">
            Which features you use and whether they worked, to help improve Notico. Never your messages, the replies, or
            anything from your pages.
          </p>
        </div>
        {enabled !== undefined && (
          <Switch label="Share usage data" checked={enabled} describedBy="settings-privacy-detail" onChange={change} />
        )}
      </div>
    </section>
  )
}
