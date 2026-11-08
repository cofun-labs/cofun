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
  const notion = isNotion(url)
  await chrome.sidePanel.setOptions(
    notion ? { tabId, path: 'sidepanel.html', enabled: true } : { tabId, enabled: false },
  )
}

// Off by default, so tabs we haven't seen yet don't get the panel. Tabs that
// were already open when the extension started get their state set here.
async function init() {
  await chrome.sidePanel.setOptions({ enabled: false })
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined) await updatePanel(tab.id, tab.url).catch(ignoreClosedTab)
  }
}

// Chrome forgets side panel options whenever the extension unloads (disable,
// reload, update) or the browser restarts, and then falls back to the
// manifest default. The manifest sets no default path, so that means no panel. storage.session is cleared at the
// same moments, so a missing flag means the options need setting again.
// Checking on every service worker start also covers disable/re-enable, which
// fires neither onInstalled nor onStartup.
chrome.storage.session
  .get('panelInit')
  .then(async ({ panelInit }) => {
    if (panelInit) return
    await init()
    await chrome.storage.session.set({ panelInit: true })
  })
  .catch(console.error)

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'complete') updatePanel(tabId, tab.url).catch(ignoreClosedTab)
})

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs
    .get(tabId)
    .then((tab) => updatePanel(tabId, tab.url))
    .catch(ignoreClosedTab)
})
