import { useAuth } from '@clerk/chrome-extension'
import { useEffect, useState } from 'react'
import { loadAnalyticsEnabled, saveAnalyticsEnabled } from '../analytics'
import type { ModelSettings } from '../models'
import { Avatar, useAccount } from './Account'
import { Page } from './Header'
import { ModelCard, Switch } from './Model'

/**
 * The Settings page: everything that isn't money. The model providers and their models, the account
 * with Sign out, and whether usage data is sent.
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
  const { signOut } = useAuth()
  const account = useAccount()

  return (
    <Page id="settings" title="Settings" onBack={onClose}>
      <ModelCard settings={model} onChange={onModelChange} focus={at === 'providers'} />

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
