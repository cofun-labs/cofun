// Clicking the toolbar icon opens the side panel. The panel itself is the manifest's
// side_panel.default_path: one panel per window, on every tab, so it stays open with its
// conversation as the user switches tabs.
//
// The context menu's "Ask Notico" item, on text selected in any page, opens the panel too and hands
// it the selection (@cofun/tools/selection). The clip item (src/clip.ts), on any page, opens the panel
// with the page, which the panel writes to Notion. Only one item shows on selected text, so Chrome
// keeps it at the menu's top level instead of folding the extension's items into a submenu.
import { MENU_PAGES, setupSelectionMenu } from '@cofun/tools/selection'
import {
  CLIP_PAGE,
  clipMenuVisible,
  handOverClip,
  loadClipSettings,
  watchClipSettings,
  type ClipSettings,
} from './clip'

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err))

setupSelectionMenu({
  product: 'Notico',
  // Made with "Ask Notico", each time the menu is made again, shown as the clip settings say.
  moreItems: async () => [
    {
      id: CLIP_PAGE,
      title: 'Clip page to Notion',
      contexts: ['page'],
      documentUrlPatterns: MENU_PAGES,
      visible: clipMenuVisible(await loadClipSettings()),
    },
  ],
})

// The clip settings, changed on this device or synced from another one. They are read again as the
// browser starts, for a change that synced while Chrome was closed.
const showClip = (settings: ClipSettings) => {
  chrome.contextMenus
    .update(CLIP_PAGE, { visible: clipMenuVisible(settings) })
    .catch((err: unknown) => console.error(err))
}
watchClipSettings(showClip)
chrome.runtime.onStartup.addListener(() => void loadClipSettings().then(showClip, (err: unknown) => console.error(err)))

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CLIP_PAGE || tab?.id === undefined) return
  // Before anything is awaited: Chrome opens the panel only while the click is being handled.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => console.error(err))
  // The side panel reads the page itself: turning it into Markdown takes a DOM, which a service worker lacks.
  handOverClip(tab.windowId, { tabId: tab.id, url: info.pageUrl || tab.url || '', title: tab.title ?? '' }).catch(
    (err: unknown) => console.error('Could not hand the clip to the side panel', err),
  )
})
