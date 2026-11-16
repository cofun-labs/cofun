const cleanPath = (path: string) => path.replace(/;[^/]*|%3bjsessionid(?:=|%3d)[^/]*/gi, '')

/** A page link for the model and session labels, derived only from browser tab metadata. */
function confluencePageUrl(url: URL): string | undefined {
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return
  const { origin } = url
  // Java servlet URLs can carry session IDs in the path.
  const pathname = cleanPath(url.pathname)
  // Self-hosted viewpage links use this numeric parameter to identify the page.
  if (!pathname.endsWith('/pages/viewpage.action')) return origin + pathname
  const [pageId, duplicate] = url.searchParams.getAll('pageId')
  if (pageId && duplicate === undefined && /^\d+$/.test(pageId)) return `${origin}${pathname}?pageId=${pageId}`
}

export async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

export function tabPage(tab: chrome.tabs.Tab | undefined): { title: string; url: string } | undefined {
  if (!tab?.url) return
  try {
    const link = confluencePageUrl(new URL(tab.url))
    if (link) return { title: tab.title?.trim() || 'Untitled page', url: link }
  } catch {
    return undefined
  }
}

/** Read again for each question, so switching tabs updates the model's context. */
export function openPageNote(page: ReturnType<typeof tabPage>): string {
  if (!page) return '[No supported Confluence page is open in the current tab.]'
  // The page author controls the title. Keep it inside this one metadata note.
  const title = Array.from(page.title.replace(/[[\]]/g, '')).slice(0, 200).join('')
  const url = page.url.replaceAll('[', '%5B').replaceAll(']', '%5D')
  return `[The Confluence page open in the current tab: ${JSON.stringify(title)}, ${url}]`
}
