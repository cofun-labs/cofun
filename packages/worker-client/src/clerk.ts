// Clerk sign-in, as every extension uses it: what it reads out of Clerk's publishable key, and the
// watch on the sign-in page's session. The build (an extension's manifest.ts) and the extension both
// use the key's hosts, so the hosts the manifest allows are the hosts the extension talks to. This
// module imports nothing, so a build can load it in Node.

/**
 * Clerk's Frontend API host, which the publishable key encodes: `pk_test_` (a development
 * instance) or `pk_live_` (a production instance), then base64 of the host and a `$`. Clerk
 * leaves the base64 padding out. Undefined when the key names no host.
 */
export function clerkFrontendApi(publishableKey: string): string | undefined {
  const encoded = publishableKey.split('_')[2]
  if (!encoded) return undefined
  let decoded: string
  try {
    decoded = atob(encoded)
  } catch {
    return undefined
  }
  return decoded.endsWith('$') && decoded.length > 1 ? decoded.slice(0, -1) : undefined
}

/**
 * The host Clerk's Sync Host reads the signed-in client from. A production instance keeps its
 * client cookie on its Frontend API host (`clerk.<domain>`); a development instance keeps it on
 * the page that signed in, which is the sign-in page.
 */
export function clerkSyncHost(publishableKey: string, signInHost: string): string {
  if (!publishableKey.startsWith('pk_live_')) return signInHost
  const frontendApi = clerkFrontendApi(publishableKey)
  if (!frontendApi) throw new Error('The Clerk publishable key names no Frontend API host.')
  return `https://${frontendApi}`
}

// Clerk's __client_uat_<suffix> cookie is "0" when signed out and a timestamp when signed in. It
// lives on the sign-in page's parent domain, which other Clerk apps may share, so only the name
// suffixed for this publishable key is watched, and it is read by URL so parent-domain cookies are
// included.
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

/**
 * Calls `changed` each time the sign-in page at `signInHost` signs in or out, once it settled. Clerk
 * doesn't fully sync the session into an open side panel, which reloads then. Only a change in
 * signed-in state counts: other session cookies are rewritten on every token refresh, and reloading
 * then would wipe the conversation. Needs the `cookies` permission for the sign-in page's host;
 * rejects when the watch could not start.
 */
export async function watchSignIn(publishableKey: string, signInHost: string, changed: () => void): Promise<void> {
  const name = await uatCookieName(publishableKey)
  let signedIn = await readSignedIn(signInHost, name)
  let settling: ReturnType<typeof setTimeout> | undefined
  chrome.cookies.onChanged.addListener(({ cookie }) => {
    if (cookie.name !== name) return
    clearTimeout(settling)
    settling = setTimeout(async () => {
      const now = await readSignedIn(signInHost, name)
      if (now !== signedIn) changed()
      signedIn = now
    }, 500)
  })
}
