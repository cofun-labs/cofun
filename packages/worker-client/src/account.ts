// The account signed in now, as an extension's service worker finds it when the user acts outside
// the side panel (a context menu click): the Clerk user id of the Sync Host's current session.
// Imported as @cofun/worker-client/account, apart from ./clerk, which a build loads in Node.
import { createClerkClient } from '@clerk/chrome-extension/client'
import { clerkSyncHost } from './clerk'

/**
 * The Clerk user id of the account signed in on the sign-in page now, if any. It is read from the
 * Sync Host's current client, never from one cached earlier: a cached client could still name an
 * account that signed out on the web since. The signed-in panel keeps its own cache.
 */
export async function signedInAccount(publishableKey: string, signInHost: string): Promise<string | undefined> {
  const clerk = await createClerkClient({
    publishableKey,
    syncHost: clerkSyncHost(publishableKey, signInHost),
    background: true,
    storageCache: {
      createKey: (...parts) => parts.join('|'),
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
    },
  })
  return clerk.session?.user?.id
}
