export function parseInstance(value: string) {
  try {
    const url = new URL(value.trim())
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.hostname.includes('*') ||
      /[;]|%2f|%5c|%00/i.test(url.pathname)
    )
      return
    const cloud = /(?:^|\.)atlassian\.net$/.test(url.hostname)
    const path = url.pathname.replace(/\/+$/, '')
    if (
      cloud &&
      (url.protocol !== 'https:' ||
        url.port ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/.test(url.hostname) ||
        (path !== '' && path !== '/wiki'))
    )
      return
    return {
      origin: url.origin,
      path: cloud ? '/wiki' : path,
      cloud,
      // The pattern a tool card's Allow asks Chrome for (see allowSite in @cofun/tools).
      permission: `${url.origin}/*`,
    }
  } catch {
    return undefined
  }
}

export type Instance = NonNullable<ReturnType<typeof parseInstance>>

/** Whether the URL is on an Atlassian Cloud tenant's wiki, the only part of a tenant that is Confluence. */
export function cloudWikiInstance(url: URL): Instance | undefined {
  if (!/(?:^|\.)atlassian\.net$/.test(url.hostname)) return
  if (url.pathname !== '/wiki' && !url.pathname.startsWith('/wiki/')) return
  return parseInstance(url.origin + '/wiki')
}

/**
 * Whether a self-managed URL has the shape of a Confluence page, so asking the user to allow its site
 * for Confluence makes sense. Only the page's own metadata, read once the site is allowed, decides.
 */
export function looksLikeConfluence(url: URL): boolean {
  return (
    /^https?:$/.test(url.protocol) &&
    /\/(?:display\/[^/]+|spaces\/[^/]+|pages\/[a-z]+\.action|dashboard\.action|index\.action)(?:\/|$)/.test(
      url.pathname,
    )
  )
}

export function matchesInstance(url: URL, instance: Instance): boolean {
  return (
    url.origin === instance.origin &&
    !url.username &&
    !url.password &&
    (url.pathname === instance.path || url.pathname.startsWith(instance.path + '/'))
  )
}
