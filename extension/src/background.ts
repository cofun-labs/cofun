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

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'complete') updatePanel(tabId, tab.url)
})

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId)
  updatePanel(tabId, tab.url)
})
