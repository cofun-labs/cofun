import { ClerkProvider, Show, SignInButton, UserButton } from '@clerk/chrome-extension'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Chat } from './Chat'
import './style.css'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string
const PANEL_URL = chrome.runtime.getURL('sidepanel.html')

function App() {
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      afterSignOutUrl={PANEL_URL}
      signInFallbackRedirectUrl={PANEL_URL}
      signUpFallbackRedirectUrl={PANEL_URL}
    >
      <header>
        <span className="title">Notion Kit</span>
        <Show when="signed-in">
          <UserButton />
        </Show>
      </header>

      <Show when="signed-out">
        <div className="signed-out">
          <p>Sign in to use Notion Kit.</p>
          <SignInButton mode="modal">
            <button className="primary">Sign in</button>
          </SignInButton>
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
