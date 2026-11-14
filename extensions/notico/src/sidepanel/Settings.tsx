import { useAuth } from '@clerk/chrome-extension'
import type { ModelSettings } from '../models'
import { Avatar, useAccount } from './Account'
import { Page } from './Header'
import { ModelCard } from './Model'

/** The Settings page: everything that isn't money. The model providers and their models, and the account with Sign out. */
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
