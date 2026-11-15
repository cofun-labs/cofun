// What the extension reads out of Clerk's publishable key. The build (manifest.ts) and the side
// panel both use it, so the hosts the manifest allows are the hosts the panel talks to. Also the
// session token the side panel sends the worker.
import { z } from './zod'

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

/** Clerk's `getToken`, as `useAuth` gives it. */
type GetToken = (options?: { skipCache?: boolean }) => Promise<string | null>

/** The one claim read here; the worker verifies the token and all of its claims. */
const Claims = z.object({ azp: z.string().optional() })

/** Whether a session token names the origin it was issued to (`azp`). */
function namesOrigin(token: string): boolean {
  const payload = token.split('.')[1]
  if (!payload) return false
  try {
    const json: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return Claims.safeParse(json).data?.azp !== undefined
  } catch {
    return false
  }
}

/**
 * A session token for the worker, which refuses one that names no origin. The first token Clerk
 * gives a panel that just loaded is the one its client came with (the session's last active
 * token), and with this instance's session minter that one names no origin; until Clerk refreshes
 * it, a minute later, every request would be refused. Such a token is swapped for a new one, which
 * Clerk asks for from the extension's origin and keeps for the next calls.
 */
export async function sessionToken(getToken: GetToken): Promise<string | null> {
  const token = await getToken()
  if (!token || namesOrigin(token)) return token
  return getToken({ skipCache: true })
}
