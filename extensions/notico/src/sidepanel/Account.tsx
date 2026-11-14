import { useAuth, useUser } from '@clerk/chrome-extension'
import { useState, type Ref } from 'react'
import { creditsSummary, type CreditsState } from '../credits'
import { useMenu } from './menu'

/** Who is signed in, as Clerk knows them. Notico only shows it: there is nothing here to change the account. */
export function useAccount(): { name: string; email: string; imageUrl: string } {
  const { user } = useUser()
  const email = user?.primaryEmailAddress?.emailAddress ?? ''
  return { name: user?.fullName || email || 'Signed in', email, imageUrl: user?.imageUrl ?? '' }
}

/** The account's picture, or its initial when there is none or it does not load. */
export function Avatar({ name, imageUrl }: { name: string; imageUrl: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className="account-avatar" aria-hidden="true">
      {imageUrl && !failed ? (
        <img src={imageUrl} alt="" onError={() => setFailed(true)} />
      ) : (
        name.trim().charAt(0).toUpperCase()
      )}
    </span>
  )
}

/** The credits in the account menu: what is left, and the date that matters next. */
function CreditsLines({ state }: { state: CreditsState }) {
  if (state.status === 'loading') return <p className="account-detail">Loading credits…</p>
  if (state.status === 'unavailable') return <p className="account-detail">Credits unavailable</p>
  const { left, detail } = creditsSummary(state.credits)
  return (
    <>
      <p className="account-credits">{left}</p>
      {detail && <p className="account-detail">{detail}</p>}
    </>
  )
}

/**
 * The avatar in the header and the menu it opens: who is signed in, their credits, "Settings", and
 * "Sign out". The panel's own, in place of Clerk's user menu: Notico offers no account management.
 */
export function AccountMenu({
  credits,
  onOpen,
  onSettings,
  buttonRef,
}: {
  credits: CreditsState
  /** Called each time the menu opens, so the credits in it can be read again. */
  onOpen: () => void
  onSettings: () => void
  /** The avatar button, so whoever closes the settings page can put the focus back on it. */
  buttonRef: Ref<HTMLButtonElement>
}) {
  const { signOut } = useAuth()
  const account = useAccount()
  // Escape and Tab, the arrow keys, and a press elsewhere, as every menu of the panel does.
  const { open, setOpen, rootRef, menuRef, onKeyDown } = useMenu()

  return (
    <div className="account" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        className="account-button tip-below"
        aria-label="Account"
        data-tip="Account"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen()
          setOpen(!open)
        }}
      >
        <Avatar {...account} />
      </button>
      {open && (
        <div className="account-popover">
          <div className="account-who" id="account-who">
            <p className="account-name">{account.name}</p>
            {account.email && account.email !== account.name && <p className="account-detail">{account.email}</p>}
          </div>
          <div className="account-balance" id="account-balance">
            <CreditsLines state={credits} />
          </div>
          {/* Opening moves the focus to the first item: the description tells a screen reader who is signed in and the credits above it. */}
          <div ref={menuRef} role="menu" aria-label="Account" aria-describedby="account-who account-balance">
            <button
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setOpen(false)
                onSettings()
              }}
            >
              Settings
            </button>
            <button role="menuitem" tabIndex={-1} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
