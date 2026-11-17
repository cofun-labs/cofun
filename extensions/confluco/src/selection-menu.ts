import { handOver, loadMenuShown, MENU_ITEM, watchMenuShown } from './selection'
import { selectedText } from './web/tab'

/** Registers the context menu and ties each selected excerpt to the active account. */
export function setupSelectionMenu(readAccount: () => Promise<string | undefined>): void {
  // Menu items stay from one start of the service worker to the next; they are made again when the
  // extension is installed or updated, shown unless the user turned them off in Settings. Only on web
  // pages and local files: on the extension's own pages (the side panel) there is no tab to read.
  chrome.runtime.onInstalled.addListener(() => {
    void loadMenuShown()
      .catch((err: unknown) => {
        console.error('Could not read the menu setting', err)
        return true
      })
      .then((visible) =>
        chrome.contextMenus.removeAll(() =>
          chrome.contextMenus.create({
            id: MENU_ITEM,
            title: 'Ask Confluco about “%s”',
            contexts: ['selection'],
            documentUrlPatterns: ['https://*/*', 'http://*/*', 'file:///*'],
            visible,
          }),
        ),
      )
  })

  // The Settings switch, changed on this device or synced from another one. It is read again as the
  // browser starts, for a change that synced while Chrome was closed.
  const showMenu = (visible: boolean) =>
    chrome.contextMenus.update(MENU_ITEM, { visible }).catch((err: unknown) => console.error(err))
  watchMenuShown(showMenu)
  chrome.runtime.onStartup.addListener(() => void loadMenuShown().then(showMenu, (err: unknown) => console.error(err)))

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ITEM || tab?.id === undefined) return
    // Before anything is awaited: Chrome opens the panel only while the click is being handled.
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => console.error(err))
    const { id, windowId } = tab
    void (async () => {
      const [userId, selected] = await Promise.all([readAccount(), selectedText(id, info.frameId ?? 0)])
      const text = selected || info.selectionText || ''
      if (!userId || !text.trim()) return
      await handOver(windowId, userId, text, info.pageUrl || tab.url || '', tab.title ?? '')
    })().catch(() => console.error('Could not attach the selected text'))
  })
}
