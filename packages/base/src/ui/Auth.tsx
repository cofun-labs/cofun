import { ClerkProvider } from '@clerk/chrome-extension'
import type { ReactNode } from 'react'
import { clerkSyncHost } from '../clerk'

/** The shared Clerk session for a side panel. The extension supplies its own panel and sign-in URLs. */
export function CofunAuth({
  publishableKey,
  signInHost,
  panelUrl,
  children,
}: {
  publishableKey: string
  signInHost: string
  panelUrl: string
  children: ReactNode
}) {
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      syncHost={clerkSyncHost(publishableKey, signInHost)}
      // Disable Clerk's own development telemetry so the panel contacts only its declared hosts.
      telemetry={false}
      afterSignOutUrl={panelUrl}
      signInFallbackRedirectUrl={panelUrl}
      signUpFallbackRedirectUrl={panelUrl}
    >
      {children}
    </ClerkProvider>
  )
}

/** Opens the Cofun sign-in page in a normal tab, where Clerk can complete its redirects. */
export function openSignIn(signInHost: string): void {
  void chrome.tabs.create({ url: `${signInHost}/login` })
}

// Clerk doesn't fully sync auth state into an open side panel, so reload the
// panel when the sign-in page signs in or out. Only react to a change in
// signed-in state: other session cookies are rewritten on every token refresh,
// and reloading then would wipe the conversation.
//
// Clerk's __client_uat_<suffix> cookie is "0" when signed out and a timestamp
// when signed in. It lives on the sign-in page's parent domain, which other
// Clerk apps may share, so watch only the name suffixed for this publishable
// key, and read it by URL so parent-domain cookies are included.
async function uatCookieName(publishableKey: string): Promise<string> {
  // Same as Clerk's getCookieSuffix: first 8 chars of base64url(SHA-1(publishable key)).
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(publishableKey))
  const suffix = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .slice(0, 8)
  return `__client_uat_${suffix}`
}

// Reading by URL can return both a host-only and a parent-domain cookie with this name, in no
// fixed order. A stale "0" left on one of them must not hide a live session on the other.
async function readSignedIn(signInHost: string, name: string): Promise<boolean> {
  const cookies = await chrome.cookies.getAll({ url: signInHost, name })
  return cookies.some((cookie) => cookie.value !== '' && cookie.value !== '0')
}

/** Reloads an open panel when the account signs in or out on the Cofun sign-in page. */
export function watchSignIn(publishableKey: string, signInHost: string): void {
  uatCookieName(publishableKey)
    .then(async (name) => {
      let signedIn = await readSignedIn(signInHost, name)
      let reloadTimer: number | undefined
      chrome.cookies.onChanged.addListener(({ cookie }) => {
        if (cookie.name !== name) return
        clearTimeout(reloadTimer)
        reloadTimer = window.setTimeout(async () => {
          const now = await readSignedIn(signInHost, name)
          if (now !== signedIn) location.reload()
          signedIn = now
        }, 500)
      })
    })
    .catch(console.error)
}
