// Clicking the toolbar icon opens the side panel. The panel itself is the manifest's
// side_panel.default_path: one panel per window, on every tab, so it stays open with its
// conversation as the user switches tabs.
//
// The context menu's "Ask Notico" item, on text selected in any page, opens the panel too and hands
// it the selection (@cofun/tools/selection). The clip items (src/clip.ts) do the same with the page
// or the selection, and the panel writes it to Notion.
import { selectedText } from '@cofun/tools/tab'
import { MENU_PAGES, setupSelectionMenu } from '@cofun/tools/selection'
import {
  CLIP_PAGE,
  CLIP_SELECTION,
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
  moreItems: async () => {
    const visible = clipMenuVisible(await loadClipSettings())
    return [
      { id: CLIP_PAGE, title: 'Clip page to Notion', contexts: ['page'], documentUrlPatterns: MENU_PAGES, visible },
      {
        id: CLIP_SELECTION,
        title: 'Clip selection to Notion',
        contexts: ['selection'],
        documentUrlPatterns: MENU_PAGES,
        visible,
      },
    ]
  },
})

// The clip settings, changed on this device or synced from another one. They are read again as the
// browser starts, for a change that synced while Chrome was closed.
const showClip = (settings: ClipSettings) => {
  for (const id of [CLIP_PAGE, CLIP_SELECTION])
    chrome.contextMenus.update(id, { visible: clipMenuVisible(settings) }).catch((err: unknown) => console.error(err))
}
watchClipSettings(showClip)
chrome.runtime.onStartup.addListener(() => void loadClipSettings().then(showClip, (err: unknown) => console.error(err)))

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const item = info.menuItemId
  if ((item !== CLIP_PAGE && item !== CLIP_SELECTION) || tab?.id === undefined) return
  // Before anything is awaited: Chrome opens the panel only while the click is being handled.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => console.error(err))
  const { id, windowId } = tab
  const url = info.pageUrl || tab.url || ''
  const title = tab.title ?? ''
  void (async () => {
    // The side panel reads the page itself: turning it into Markdown takes a DOM, which a service worker lacks.
    if (item === CLIP_PAGE) return handOverClip(windowId, { tabId: id, url, title })
    const text = (await selectedText(id, info.frameId ?? 0)) || info.selectionText || ''
    if (text.trim()) await handOverClip(windowId, { tabId: id, url, title, text })
  })().catch((err: unknown) => console.error('Could not hand the clip to the side panel', err))
})
