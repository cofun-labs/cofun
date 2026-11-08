import { ClerkProvider, Show, UserButton } from '@clerk/chrome-extension'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Chat } from './Chat'
import './style.css'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string
// Web page where users sign in. Its Clerk session is synced into the extension.
const SYNC_HOST = import.meta.env.VITE_CLERK_SYNC_HOST as string
const PANEL_URL = chrome.runtime.getURL('sidepanel.html')

// Clerk doesn't fully sync auth state into an open side panel, so reload the
// panel when the sign-in page signs in or out. Only react to a change in
// signed-in state: other session cookies are rewritten on every token refresh,
// and reloading then would wipe the conversation.
// __client_uat is "0" (or missing) when signed out and a timestamp when signed in.
const syncDomain = new URL(SYNC_HOST).hostname
const isUatCookie = (c: chrome.cookies.Cookie) =>
  /^__client_uat(_[A-Za-z0-9-]{8})?$/.test(c.name) &&
  (syncDomain === c.domain.replace(/^\./, '') ||
    syncDomain.endsWith(c.domain.startsWith('.') ? c.domain : `.${c.domain}`))
const uatSignedIn = (c: chrome.cookies.Cookie | undefined) => !!c && c.value !== '' && c.value !== '0'

let signedIn: boolean | undefined
chrome.cookies.getAll({ domain: syncDomain }).then((cookies) => {
  signedIn = cookies.filter(isUatCookie).some(uatSignedIn)
})
let reloadTimer: number | undefined
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (!isUatCookie(cookie)) return
  clearTimeout(reloadTimer)
  reloadTimer = window.setTimeout(async () => {
    const now = (await chrome.cookies.getAll({ domain: syncDomain })).filter(isUatCookie).some(uatSignedIn)
    if (signedIn !== undefined && now !== signedIn) location.reload()
    signedIn = now
  }, 500)
})

function openSignIn() {
  chrome.tabs.create({ url: `${SYNC_HOST}/login` })
}

function App() {
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      syncHost={SYNC_HOST}
      afterSignOutUrl={PANEL_URL}
      signInFallbackRedirectUrl={PANEL_URL}
      signUpFallbackRedirectUrl={PANEL_URL}
    >
      <header>
        <span className="title">Copilot for Notion</span>
        <Show when="signed-in">
          <UserButton />
        </Show>
      </header>

      <Show when="signed-out">
        <div className="signed-out">
          <p>Sign in to use Copilot for Notion.</p>
          <button className="primary" onClick={openSignIn}>
            Sign in
          </button>
        </div>
      </Show>

      <Show when="signed-in">
        <Chat />
      </Show>
    </ClerkProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
