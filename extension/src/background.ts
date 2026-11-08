// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err))

const NOTION_HOSTS = ['www.notion.so', 'notion.so', 'app.notion.com']

function isNotion(url?: string): boolean {
  if (!url) return false
  try {
    return NOTION_HOSTS.includes(new URL(url).hostname)
  } catch {
    return false
  }
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
    if (tab.id !== undefined) await updatePanel(tab.id, tab.url)
  }
}
init().catch((err) => console.error(err))

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'complete') updatePanel(tabId, tab.url)
})

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId)
  updatePanel(tabId, tab.url)
})
