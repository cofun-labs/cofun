// Hosts where the side panel and the agent's tools work.
export const NOTION_HOSTS = ['www.notion.so', 'app.notion.com']

export function isNotion(url?: string): boolean {
  if (!url) return false
  try {
    return NOTION_HOSTS.includes(new URL(url).hostname)
  } catch {
    return false
  }
}
