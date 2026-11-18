// Clicking the toolbar icon opens the side panel. The panel itself is the manifest's
// side_panel.default_path: one panel per window, on every tab, so it stays open with its
// conversation as the user switches tabs.
//
// The context menu's "Ask Notico" item, on text selected in any page, opens the panel too and sends
// it the selection (src/selection.ts). The click gives the extension the tab for a moment
// (activeTab), which is how the selection is read there with its line breaks; where it can't be
// (a frame from another site, say), Chrome's own copy of it, on one line, is used. The clip items
// (src/clip.ts) do the same, and the panel writes the page or the selection to Notion.
import {
  CLIP_PAGE,
  CLIP_SELECTION,
  clipMenuVisible,
  handOverClip,
  loadClipSettings,
  watchClipSettings,
  type ClipSettings,
} from './clip'
import { handOver, loadMenuShown, MENU_ITEM, watchMenuShown } from './selection'
import { selectedText } from '@cofun/tools/tab'

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err))

/** Where the items show: web pages and local files. On the extension's own pages (the side panel) there is no tab to read. */
const PAGES = ['https://*/*', 'http://*/*', 'file:///*']

const readSettings = async () => {
  const [ask, clip] = await Promise.all([
    loadMenuShown().catch((err: unknown) => {
      console.error('Could not read the menu setting', err)
      return true
    }),
    loadClipSettings().catch((err: unknown): ClipSettings => {
      console.error('Could not read the clip settings', err)
      return { shown: false }
    }),
  ])
  return { ask, clip: clipMenuVisible(clip) }
}

// Menu items stay from one start of the service worker to the next; they are made again when the
// extension is installed or updated, shown as the user's settings say.
chrome.runtime.onInstalled.addListener(() => {
  void readSettings().then(({ ask, clip }) =>
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_ITEM,
        title: 'Ask Notico about “%s”',
        contexts: ['selection'],
        documentUrlPatterns: PAGES,
        visible: ask,
      })
      chrome.contextMenus.create({
        id: CLIP_PAGE,
        title: 'Clip page to Notion',
        contexts: ['page'],
        documentUrlPatterns: PAGES,
        visible: clip,
      })
      chrome.contextMenus.create({
        id: CLIP_SELECTION,
        title: 'Clip selection to Notion',
        contexts: ['selection'],
        documentUrlPatterns: PAGES,
        visible: clip,
      })
    }),
  )
})

// The Settings switches, changed on this device or synced from another one. They are read again as
// the browser starts, for a change that synced while Chrome was closed.
const show = (ids: string[], visible: boolean) => {
  for (const id of ids) chrome.contextMenus.update(id, { visible }).catch((err: unknown) => console.error(err))
}
const showAsk = (visible: boolean) => show([MENU_ITEM], visible)
const showClip = (settings: ClipSettings) => show([CLIP_PAGE, CLIP_SELECTION], clipMenuVisible(settings))
watchMenuShown(showAsk)
watchClipSettings(showClip)
chrome.runtime.onStartup.addListener(() => {
  void loadMenuShown().then(showAsk, (err: unknown) => console.error(err))
  void loadClipSettings().then(showClip, (err: unknown) => console.error(err))
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const item = info.menuItemId
  if ((item !== MENU_ITEM && item !== CLIP_PAGE && item !== CLIP_SELECTION) || tab?.id === undefined) return
  // Before anything is awaited: Chrome opens the panel only while the click is being handled.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => console.error(err))
  const { id, windowId } = tab
  const url = info.pageUrl || tab.url || ''
  const title = tab.title ?? ''
  void (async () => {
    // The side panel reads the page itself: turning it into Markdown takes a DOM, which a service worker lacks.
    if (item === CLIP_PAGE) return handOverClip(windowId, { tabId: id, url, title })
    const text = (await selectedText(id, info.frameId ?? 0)) || info.selectionText || ''
    if (!text.trim()) return
    if (item === CLIP_SELECTION) return handOverClip(windowId, { tabId: id, url, title, text })
    await handOver(windowId, text, url, title)
  })().catch((err) => console.error(err))
})
