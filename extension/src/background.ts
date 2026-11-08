// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err))

const NOTION_HOSTS = ['www.notion.so', 'app.notion.com']

function isNotion(url?: string): boolean {
  if (!url) return false
  try {
    return NOTION_HOSTS.includes(new URL(url).hostname)
  } catch {
    return false
  }
}

// A tab can close between an event and our call; that's not an error.
function ignoreClosedTab(err: unknown) {
  if (!String(err).includes('No tab with id')) console.error(err)
}

// Only enable the panel on Notion tabs.
async function updatePanel(tabId: number, url?: string) {
  await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: isNotion(url) })
}

// Off by default, so tabs we haven't seen yet don't get the panel. Tabs that
// were already open when the extension started get their state set here.
async function init() {
  await chrome.sidePanel.setOptions({ enabled: false })
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined) await updatePanel(tab.id, tab.url).catch(ignoreClosedTab)
  }
}
// Per-tab options last for the browser session, so set them up on install,
// update, and browser start, not on every service worker wake-up.
chrome.runtime.onInstalled.addListener(() => void init().catch(console.error))
chrome.runtime.onStartup.addListener(() => void init().catch(console.error))

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'complete') updatePanel(tabId, tab.url).catch(ignoreClosedTab)
})

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs
    .get(tabId)
    .then((tab) => updatePanel(tabId, tab.url))
    .catch(ignoreClosedTab)
})
