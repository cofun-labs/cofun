import { useAuth, useUser } from '@clerk/chrome-extension'
import { useEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { creditsSummary, type CreditsState } from '../credits'

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
  onSettings,
  buttonRef,
}: {
  credits: CreditsState
  onSettings: () => void
  /** The avatar button, so whoever closes the settings page can put the focus back on it. */
  buttonRef: Ref<HTMLButtonElement>
}) {
  const { signOut } = useAuth()
  const account = useAccount()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]

  // Opening puts the focus on the first item, so the arrow keys work at once.
  useEffect(() => {
    if (open) items()[0]?.focus()
  }, [open])

  // A press anywhere else closes the menu.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function close() {
    setOpen(false)
    rootRef.current?.querySelector('button')?.focus()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      return close()
    }
    // Tab moves on, out of the menu, which then closes.
    if (e.key === 'Tab') return setOpen(false)
    const all = items()
    const at = all.findIndex((item) => item === document.activeElement)
    const to = {
      ArrowDown: (at + 1) % all.length,
      ArrowUp: (at <= 0 ? all.length : at) - 1,
      Home: 0,
      End: all.length - 1,
    }[e.key]
    if (to === undefined) return
    e.preventDefault()
    all[to]?.focus()
  }

  return (
    <div className="account" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        className="account-button"
        aria-label="Account"
        title="Account"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Avatar {...account} />
      </button>
      {open && (
        <div className="account-popover">
          <div className="account-who">
            <p className="account-name">{account.name}</p>
            {account.email && account.email !== account.name && <p className="account-detail">{account.email}</p>}
          </div>
          <div className="account-balance">
            <CreditsLines state={credits} />
          </div>
          <div ref={menuRef} role="menu" aria-label="Account">
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
