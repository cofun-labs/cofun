// Clicking the toolbar icon opens the side panel. The panel itself is the manifest's
// side_panel.default_path: one panel per window, on every tab, so it stays open with its
// conversation as the user switches tabs.
//
// The context menu's "Ask Confluco" item, on text selected in any page, opens the panel too and sends
// it the selection (src/selection.ts). The click gives the extension the tab for a moment
// (activeTab), which is how the selection is read there with its line breaks; where it can't be
// (a frame from another site, say), Chrome's own copy of it, on one line, is used.
import { createClerkClient } from '@clerk/chrome-extension/client'
import { clerkSyncHost } from '@cofun/worker-client/clerk'
import { setupSelectionMenu } from './selection-menu'

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err))

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string
const signInHost = import.meta.env.VITE_CLERK_SYNC_HOST as string

setupSelectionMenu(async () => {
  const clerk = await createClerkClient({
    publishableKey,
    syncHost: clerkSyncHost(publishableKey, signInHost),
    background: true,
    // Resolve against the current Sync Host client. A previously cached client must not identify
    // a selection after web sign-out. The signed-in panel owns its own persistent Clerk cache.
    storageCache: {
      createKey: (...parts) => parts.join('|'),
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
    },
  })
  return clerk.session?.user?.id
})
