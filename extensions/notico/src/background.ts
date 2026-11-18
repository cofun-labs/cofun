// Clicking the toolbar icon opens the side panel. The panel itself is the manifest's
// side_panel.default_path: one panel per window, on every tab, so it stays open with its
// conversation as the user switches tabs.
//
// The context menu's "Ask Notico" item, on text selected in any page, opens the panel too and hands
// it the selection, for the account signed in at the click (@cofun/tools/selection).
import { signedInAccount } from '@cofun/worker-client/account'
import { setupSelectionMenu } from '@cofun/tools/selection'

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err))

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string
const signInHost = import.meta.env.VITE_CLERK_SYNC_HOST as string

setupSelectionMenu({ product: 'Notico', readAccount: () => signedInAccount(publishableKey, signInHost) })
