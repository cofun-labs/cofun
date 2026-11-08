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
// panel when the sign-in page's session cookies change.
const SESSION_COOKIES = new Set(['__client', '__client_uat', '__session', '__clerk_db_jwt'])
const syncDomain = new URL(SYNC_HOST).hostname
let reloadTimer: number | undefined
chrome.cookies.onChanged.addListener(({ cookie }) => {
  const name = cookie.name.replace(/_[A-Za-z0-9-]{8}$/, '') // Clerk may suffix cookie names
  if (!SESSION_COOKIES.has(name) || !syncDomain.endsWith(cookie.domain.replace(/^\./, ''))) return
  clearTimeout(reloadTimer)
  reloadTimer = window.setTimeout(() => location.reload(), 500)
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
