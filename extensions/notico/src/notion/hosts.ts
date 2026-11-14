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
    const hex = trailingId(new URL(url).searchParams.get('p') ?? '')
    return hex ? dashed(hex) : pathPageIdFromUrl(url)
  } catch {
    return undefined
  }
}

/**
 * Whether a Notion URL shows a database as its page: a full-page database has its view in the URL
 * (`?v=<id>`), unless a side peek (`?p=<id>`) shows one of its rows over it.
 */
export function showsDatabase(url: string): boolean {
  try {
    const params = new URL(url).searchParams
    return params.has('v') && !params.has('p')
  } catch {
    return false
  }
}

/** The id of the page under a side peek: the id at the end of the URL's path, as a dashed UUID. */
export function pathPageIdFromUrl(url: string): string | undefined {
  try {
    const hex = trailingId(new URL(url).pathname.split('/').at(-1) ?? '')
    return hex && dashed(hex)
  } catch {
    return undefined
  }
}

/** A link that opens a page on the tab's Notion host: app.notion.com opens pages only under `/p/`. */
export function pageLink(tabUrl: string, id: string): string {
  return `${new URL(tabUrl).origin}/p/${id.replace(/-/g, '').toLowerCase()}`
}

/** A Notion id in the form Notion's API keys records by (dashed, lowercase), or undefined if `id` isn't one. */
export function toUuid(id: string): string | undefined {
  const hex = id.replace(/-/g, '')
  return /^[0-9a-f]{32}$/i.test(hex) ? dashed(hex.toLowerCase()) : undefined
}

function dashed(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The 32-hex id at the end of `text`, with or without dashes. */
function trailingId(text: string): string | undefined {
  const hex = text.replace(/-/g, '').match(/[0-9a-f]{32}$/i)?.[0]
  return hex?.toLowerCase()
}
