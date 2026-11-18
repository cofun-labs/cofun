import { ClerkProvider, Show, useAuth } from '@clerk/chrome-extension'
import { clerkSyncHost, watchSignIn } from '@cofun/worker-client/clerk'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { identify, track } from '../analytics'
import { Chat } from './Chat'
import { Header } from './Header'
import { Mark } from './icons'
import './style.css'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string
// Web page where users sign in. The Clerk session it starts is synced into the extension.
const SIGN_IN_HOST = import.meta.env.VITE_CLERK_SYNC_HOST as string
const PANEL_URL = chrome.runtime.getURL('sidepanel.html')

// Clerk doesn't fully sync auth state into an open side panel, so the panel reloads when the
// sign-in page signs in or out.
watchSignIn(PUBLISHABLE_KEY, SIGN_IN_HOST, () => location.reload()).catch(console.error)

function openSignIn() {
  track({ event: 'sign_in_opened' })
  chrome.tabs.create({ url: `${SIGN_IN_HOST}/login` })
}

// Each account gets its own chat and sessions; keyed so a change of account starts over.
function SignedInChat() {
  const { userId } = useAuth()
  return userId ? <Chat key={userId} userId={userId} /> : <Header />
}

// Until Clerk knows whether anyone is signed in, neither screen shows; the panel is not left blank.
function WhileLoading() {
  const { isLoaded } = useAuth()
  return isLoaded ? null : <Header />
}

/** Tells analytics who is signed in, once Clerk knows: usage is counted per account, and per device before sign-in. */
function Identity() {
  const { isLoaded, userId } = useAuth()
  useEffect(() => {
    if (isLoaded) identify(userId ?? null)
  }, [isLoaded, userId])
  return null
}

function App() {
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      syncHost={clerkSyncHost(PUBLISHABLE_KEY, SIGN_IN_HOST)}
      // Clerk's SDK reports its own usage to clerk-telemetry.com when the instance is a
      // development one. The extension contacts only the hosts PRIVACY.md lists, so it is off
      // whatever the instance.
      telemetry={false}
      afterSignOutUrl={PANEL_URL}
      signInFallbackRedirectUrl={PANEL_URL}
      signUpFallbackRedirectUrl={PANEL_URL}
    >
      <WhileLoading />
      <Identity />

      <Show when="signed-out">
        <Header />
        <div className="signed-out">
          <Mark className="hero-mark" />
          <p>Sign in to use Notico.</p>
          <button className="primary" onClick={openSignIn}>
            Sign in
          </button>
        </div>
      </Show>

      <Show when="signed-in">
        <SignedInChat />
      </Show>
    </ClerkProvider>
  )
}

track({ event: 'panel_opened' })
const root = createRoot(document.getElementById('root')!)
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
)
// Closing the panel ends its work: a question still running stops with the chat (see Chat).
// Not when the page is only kept for later (`persisted`): it would come back with nothing in it.
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) root.unmount()
})
