import { CofunAuth, openSignIn, watchSignIn, Header, Mark } from '@cofun/base/ui'
import { Show, useAuth } from '@clerk/chrome-extension'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { identify, track } from '../analytics'
import { Chat } from './Chat'
import '@cofun/base/style.css'
import './style.css'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string
// Web page where users sign in. The Clerk session it starts is synced into the extension.
const SIGN_IN_HOST = import.meta.env.VITE_CLERK_SYNC_HOST as string
const PANEL_URL = chrome.runtime.getURL('sidepanel.html')

watchSignIn(PUBLISHABLE_KEY, SIGN_IN_HOST)

function signIn() {
  track({ event: 'sign_in_opened' })
  openSignIn(SIGN_IN_HOST)
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
    <CofunAuth publishableKey={PUBLISHABLE_KEY} signInHost={SIGN_IN_HOST} panelUrl={PANEL_URL}>
      <WhileLoading />
      <Identity />

      <Show when="signed-out">
        <Header />
        <div className="signed-out">
          <Mark className="hero-mark" />
          <p>Sign in to use Notico.</p>
          <button className="primary" onClick={signIn}>
            Sign in
          </button>
        </div>
      </Show>

      <Show when="signed-in">
        <SignedInChat />
      </Show>
    </CofunAuth>
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
