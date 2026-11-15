// Clicking the toolbar icon opens the side panel. The panel itself is the manifest's
// side_panel.default_path: one panel per window, on every tab, so it stays open with its
// conversation as the user switches tabs.
//
// The context menu's "Ask Notico" item, on text selected in any page, opens the panel too and sends
// it the selection (src/selection.ts). The click gives the extension the tab for a moment
// (activeTab), which is how the selection is read there with its line breaks; where it can't be
// (a frame from another site, say), Chrome's own copy of it, on one line, is used.
import { handOver, MENU_ITEM } from './selection'
import { selectedText } from './web/tab'

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err))

// Menu items stay from one start of the service worker to the next; they are made again when the
// extension is installed or updated.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() =>
    chrome.contextMenus.create({ id: MENU_ITEM, title: 'Ask Notico about “%s”', contexts: ['selection'] }),
  )
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ITEM || tab?.id === undefined) return
  // Before anything is awaited: Chrome opens the panel only while the click is being handled.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => console.error(err))
  const { id, windowId } = tab
  void (async () => {
    const text = (await selectedText(id, info.frameId ?? 0)) || info.selectionText || ''
    if (!text.trim()) return
    await handOver(windowId, text, info.pageUrl || tab.url || '', tab.title ?? '')
  })().catch((err) => console.error(err))
})
