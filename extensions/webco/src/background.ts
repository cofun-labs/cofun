// Clicking the toolbar icon opens the side panel. The panel itself is the manifest's
// side_panel.default_path: one panel per window, on every tab, so it stays open with its
// conversation as the user switches tabs.
//
// The context menu's "Ask Webco" item, on text selected in any page, opens the panel too and hands
// it the selection (@cofun/tools/selection).
import { setupSelectionMenu } from '@cofun/tools/selection'

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err))

setupSelectionMenu({ product: 'Webco' })
