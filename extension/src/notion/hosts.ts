// Hosts where the side panel and the agent's tools work. Notion calls go only to these.
export const NOTION_HOSTS = ['www.notion.so', 'app.notion.com']

export function isNotion(url?: string): boolean {
  if (!url) return false
  try {
    return NOTION_HOSTS.includes(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * The id of the page a Notion URL shows, as a dashed UUID: the page in side peek (`?p=<id>`) if
 * one is open, else the id at the end of the path (`/Title-<id>`, `/<id>`, `/p/<id>`).
 */
export function pageIdFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url)
    const hex = notionId(u.searchParams.get('p') ?? '') ?? notionId(u.pathname.split('/').at(-1) ?? '')
    return hex && `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  } catch {
    return undefined
  }
}

/** The 32-hex id at the end of `text`, with or without dashes. */
function notionId(text: string): string | undefined {
  const hex = text.replace(/-/g, '').match(/[0-9a-f]{32}$/i)?.[0]
  return hex?.toLowerCase()
}
