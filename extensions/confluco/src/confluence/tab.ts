// Runs Confluence REST requests and editor reads in the captured Confluence tab with its site session.
import { z } from '../zod'
import {
  cloudWikiInstance,
  isAtlassianHost,
  looksLikeConfluence,
  matchesInstance,
  parseInstance,
  type Instance,
} from './instance'

export interface ConfluenceTab {
  tabId: number
  url: string
  instance: Instance
}

/** The tab a question was asked on: the active tab of the side panel's window, without its hash. */
export interface CapturedTab {
  tabId: number
  url: string
}

export async function activeTab(): Promise<CapturedTab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined || !tab.url) return
  try {
    const url = new URL(tab.url)
    url.hash = ''
    return { tabId: tab.id, url: url.href }
  } catch {
    return undefined
  }
}

/**
 * The site whose access Confluence tools on this tab need, when the tab could be a Confluence page:
 * a Cloud wiki, or a self-managed URL shaped like a Confluence page. Only such a tab is asked about
 * or read.
 */
export function confluenceOrigin(captured: CapturedTab): string | undefined {
  const url = new URL(captured.url)
  if (cloudWikiInstance(url) || (!isAtlassianHost(url.hostname) && looksLikeConfluence(url))) return url.origin
}

export function mayUseSite(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [origin + '/*'] })
}

const contextPath = z
  .string()
  .max(1000)
  .regex(/^(?:\/[^/?#]+)*$/)

/**
 * The Confluence site the tab shows, once Confluco may use the tab's site. A Cloud wiki is known by its
 * address. A self-managed page names its deployment path in Confluence's own metadata, which must
 * contain the page: a page can claim to be Confluence, but requests only go back to its own origin.
 */
export async function confluenceTabAt(captured: CapturedTab): Promise<ConfluenceTab | undefined> {
  const url = new URL(captured.url)
  // Only a tab that could be Confluence is read, so no script runs on other sites the user allowed.
  const origin = confluenceOrigin(captured)
  if (!origin || !(await mayUseSite(origin))) return
  let instance = cloudWikiInstance(url)
  if (!instance) {
    const [frame] = await chrome.scripting
      .executeScript({
        target: { tabId: captured.tabId },
        world: 'ISOLATED',
        func: (expectedUrl: string) => {
          const current = new URL(location.href)
          current.hash = ''
          if (current.href !== expectedUrl) return { changed: true }
          // Only the head's: a page's body can hold markup its editors wrote.
          return {
            path: document.head?.querySelector<HTMLMetaElement>('meta[name="confluence-context-path"]')?.content,
          }
        },
        args: [captured.url],
      })
      .catch(() => [])
    const result = z.object({ changed: z.literal(true) }).safeParse(frame?.result)
    if (result.success) refuse('The Confluence tab changed. Open the intended page and ask again.')
    const path = contextPath.safeParse(z.object({ path: z.unknown() }).safeParse(frame?.result).data?.path)
    if (path.success) instance = parseInstance(url.origin + path.data)
  }
  if (!instance || !matchesInstance(url, instance)) return
  return { ...captured, instance }
}

export async function captureConfluenceTab(): Promise<ConfluenceTab | undefined> {
  const captured = await activeTab()
  return captured && confluenceTabAt(captured)
}

const result = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    pageId: z.string().regex(/^\d+$/).optional(),
    status: z.int().min(200).max(299),
    data: z.unknown(),
  }),
  z.object({
    kind: z.enum([
      'changed',
      'not-page',
      'auth',
      'unexpected-web-response',
      'rejected',
      'forbidden',
      'missing',
      'unsupported',
      'conflict',
      'limited',
      'large',
      'network',
      'invalid',
    ]),
  }),
])

const errors = {
  changed: 'The Confluence tab changed. Open the intended page and ask again.',
  'not-page': 'Open a published Confluence page before asking Confluco to read it.',
  auth: 'Sign in to Confluence in the page tab, then ask again.',
  'unexpected-web-response':
    'Confluence returned a redirect or a web page. Check that the tab shows Confluence and that you are signed in, then ask again.',
  rejected: 'Confluence rejected the request. Check the search text, space key or page reference.',
  forbidden: 'Your Confluence account does not have permission for this request.',
  missing: 'The requested Confluence item is missing or is not visible to your account.',
  unsupported: 'This Confluence instance does not support the requested operation.',
  conflict: 'The Confluence page has a newer version. Check the current page before trying again.',
  limited: 'Confluence rate-limited this request. Wait before asking again.',
  large: 'The Confluence response was too large to read.',
  network: 'Could not complete the request to Confluence. Check the site and try again.',
  invalid: 'Confluence did not return the expected response.',
} satisfies Record<Exclude<z.infer<typeof result>['kind'], 'ok'>, string>

export function refuse(message: string, mayHaveChanged = false): never {
  throw Object.assign(new Error(message), { stopsQuestion: message, mayHaveChanged })
}

type Query = Record<string, string | string[]>
export type RestArea = 'api' | 'experimental' | 'cloud-v2'
type RestRequest = {
  area: RestArea
  resource: string
  query: Query
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: string
}

export class ConfluenceRequestError extends Error {
  readonly stopsQuestion: string

  constructor(readonly kind: keyof typeof errors) {
    super(errors[kind])
    this.stopsQuestion = this.message
  }
}

/** A failed read-back must retain both a known refusal and the uncertain write outcome. */
export function verificationFailed(message: string, cause?: unknown): never {
  if (cause instanceof ConfluenceRequestError && cause.kind === 'limited') message += ` ${cause.message}`
  throw Object.assign(new Error(message, { cause }), { stopsQuestion: message, mayHaveChanged: true })
}

export function requireTab(tab: ConfluenceTab | undefined): ConfluenceTab {
  if (!tab) refuse('Open a Confluence page in the current tab first.')
  return tab
}

export function restUrl(instance: Instance, resource: string, query: Query, area: RestArea): URL {
  const folder = area === 'cloud-v2' ? 'api/v2' : `rest/${area}`
  const endpoint = new URL(`${instance.origin}${instance.path}/${folder}/${resource}`)
  endpoint.search = new URLSearchParams(
    Object.entries(query).flatMap(([key, value]) =>
      Array.isArray(value) ? value.map((item): [string, string] => [key, item]) : [[key, value]],
    ),
  ).toString()
  return endpoint
}

export function getConfluence(
  target: ConfluenceTab,
  resource: string | null,
  query: Query,
  signal?: AbortSignal,
  area: RestArea = 'api',
) {
  // Chrome drops null properties when serializing injected arguments.
  return sendConfluence(target, { area, resource: resource ?? 'current-page', query, method: 'GET' }, signal)
}

export function createCloudChildPage(
  tab: ConfluenceTab,
  input: { spaceId: string; parentId: string; title: string; text: string },
  signal?: AbortSignal,
) {
  const { text, ...page } = input
  return sendConfluence(
    tab,
    {
      area: 'cloud-v2',
      resource: 'pages',
      method: 'POST',
      query: {},
      body: JSON.stringify({ ...page, status: 'current', body: { representation: 'storage', value: text } }),
    },
    signal,
    'Confluence rejected the page change. Check that the title is valid and unique in the chosen space.',
  )
}

export function moveCloudPage(tab: ConfluenceTab, pageId: string, parentId: string, signal?: AbortSignal) {
  return sendConfluence(
    tab,
    { area: 'api', resource: `content/${pageId}/move/append/${parentId}`, method: 'PUT', query: {} },
    signal,
    'Confluence rejected the move. Check that both pages are eligible and in the same space.',
  )
}

export function trashCloudPage(tab: ConfluenceTab, pageId: string, signal?: AbortSignal) {
  return sendConfluence(
    tab,
    { area: 'cloud-v2', resource: `pages/${pageId}`, method: 'DELETE', query: {} },
    signal,
    'Confluence rejected moving this page to the trash. Review the page in Confluence before trying again.',
  )
}

export function updateCloudPage(
  tab: ConfluenceTab,
  pageId: string,
  input: { title: string; version: number; text: string },
  signal?: AbortSignal,
) {
  return sendConfluence(
    tab,
    {
      area: 'cloud-v2',
      resource: `pages/${pageId}`,
      method: 'PUT',
      query: {},
      body: JSON.stringify({
        id: pageId,
        status: 'current',
        title: input.title,
        version: { number: input.version },
        body: { representation: 'storage', value: input.text },
      }),
    },
    signal,
  )
}

export function renameCloudPage(tab: ConfluenceTab, pageId: string, title: string, signal?: AbortSignal) {
  return sendConfluence(
    tab,
    {
      area: 'cloud-v2',
      resource: `pages/${pageId}/title`,
      method: 'PUT',
      query: {},
      body: JSON.stringify({ status: 'current', title }),
    },
    signal,
  )
}

export function createCloudFooterComment(
  tab: ConfluenceTab,
  target: { pageId: string } | { parentCommentId: string },
  text: string,
  signal?: AbortSignal,
) {
  return sendConfluence(
    tab,
    {
      area: 'cloud-v2',
      resource: 'footer-comments',
      method: 'POST',
      query: {},
      body: JSON.stringify({ ...target, body: { representation: 'storage', value: text } }),
    },
    signal,
    'Confluence rejected the comment. Check the page and reply target.',
  )
}

type LabelWrite = { method: 'POST'; body: unknown } | { method: 'DELETE'; query: Query }

export function writeConfluenceLabel(target: ConfluenceTab, id: string, write: LabelWrite, signal?: AbortSignal) {
  return sendConfluence(
    target,
    {
      area: 'api',
      resource: `content/${id}/label`,
      method: write.method,
      query: write.method === 'DELETE' ? write.query : {},
      ...(write.method === 'POST' && { body: JSON.stringify(write.body) }),
    },
    signal,
  )
}

export function createConfluenceContent<T extends { type: 'page' | 'comment' }>(
  target: ConfluenceTab,
  body: T,
  signal?: AbortSignal,
) {
  return sendConfluence(
    target,
    { area: 'api', resource: 'content', method: 'POST', query: {}, body: JSON.stringify(body) },
    signal,
    body.type === 'comment' ? 'Confluence rejected the comment. Check the page and reply target.' : undefined,
  )
}

export function updateConfluencePage(target: ConfluenceTab, id: string, body: unknown, signal?: AbortSignal) {
  return sendConfluence(
    target,
    { area: 'api', resource: `content/${id}`, method: 'PUT', query: {}, body: JSON.stringify(body) },
    signal,
  )
}

export function trashConfluencePage(target: ConfluenceTab, id: string, signal?: AbortSignal) {
  return sendConfluence(
    target,
    { area: 'api', resource: `content/${id}`, method: 'DELETE', query: { status: 'current' } },
    signal,
  )
}

async function sendConfluence(target: ConfluenceTab, request: RestRequest, signal?: AbortSignal, rejection?: string) {
  signal?.throwIfAborted()
  if (!(await chrome.permissions.contains({ origins: [target.instance.permission] }))) {
    refuse('Confluco needs Chrome site access to this Confluence site. Ask again and allow it.')
  }
  signal?.throwIfAborted()

  const writing = request.method !== 'GET'
  const uncertain = () =>
    refuse('The Confluence change may have been applied. Check the page before trying again.', true)
  const requestId = crypto.randomUUID()
  const injection = {
    target: { tabId: target.tabId },
    world: 'ISOLATED' as const,
  }
  let onAbort: (() => void) | undefined
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(signal?.reason)
      void chrome.scripting.executeScript({ ...injection, func: abortRequest, args: [requestId] }).catch(() => {})
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

  let raw: unknown
  try {
    const [frame] = await Promise.race([
      chrome.scripting.executeScript({
        ...injection,
        func: requestConfluence,
        args: [target.url, target.instance.path, request, requestId],
      }),
      stopped,
    ])
    raw = frame?.result
  } catch {
    if (writing) uncertain()
    signal?.throwIfAborted()
    refuse('Could not access the Confluence tab. Check its site permission and try again.')
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
  if (signal?.aborted && writing) uncertain()
  signal?.throwIfAborted()

  const response = result.safeParse(raw)
  if (!response.success) {
    if (writing) uncertain()
    refuse(errors.invalid)
  }
  if (response.data.kind !== 'ok') {
    const { kind } = response.data
    if (writing && ['unexpected-web-response', 'large', 'network', 'invalid'].includes(kind)) uncertain()
    if (kind === 'rejected' && rejection) refuse(rejection)
    if (kind === 'rejected' && request.method === 'DELETE' && request.query.status === 'current')
      refuse('Confluence rejected moving this page to the trash. Review the page in Confluence before trying again.')
    if (
      kind === 'rejected' &&
      (request.method === 'PUT' || (request.method === 'POST' && request.resource === 'content'))
    )
      refuse('Confluence rejected the page change. Check that the title is valid and unique in the chosen space.')
    throw new ConfluenceRequestError(kind)
  }
  return response.data
}

declare global {
  // These controllers exist only in the extension's isolated world for this tab.
  var cofunConfluenceReads: Map<string, AbortController> | undefined
}

function abortRequest(requestId: string) {
  globalThis.cofunConfluenceReads?.get(requestId)?.abort()
}

/** Chrome serializes this function into the top-level page. Keep its dependencies inside it. */
async function requestConfluence(expectedUrl: string, contextPath: string, request: RestRequest, requestId: string) {
  const actual = new URL(location.href)
  actual.hash = ''
  if (actual.href !== expectedUrl) return { kind: 'changed' }
  const { area, query, method, body } = request
  let { resource } = request
  let pageId: string | undefined
  const cloud = /(?:^|\.)atlassian\.net$/.test(actual.hostname)
  if (cloud) {
    const jsonWrite = body !== undefined && Object.keys(query).length === 0
    const isLabel = /^content\/\d{1,20}\/label$/.test(resource)
    const cloudRead =
      method === 'GET' &&
      body === undefined &&
      ((area === 'cloud-v2' &&
        /^(?:current-page|spaces(?:\/\d{1,20})?|pages(?:\/\d{1,20}(?:\/(?:ancestors|direct-children|versions|operations|labels|footer-comments|inline-comments|attachments))?)?|folders\/\d{1,20}(?:\/(?:ancestors|direct-children))?|footer-comments\/\d{1,20}|(?:footer|inline)-comments\/\d{1,20}\/children)$/.test(
          resource,
        )) ||
        (area === 'api' && /^(?:search|content\/\d{1,20}\/restriction\/byOperation)$/.test(resource)))
    const cloudWrite =
      (area === 'cloud-v2' &&
        jsonWrite &&
        ((method === 'POST' && ['pages', 'footer-comments'].includes(resource)) ||
          (method === 'PUT' && /^pages\/\d{1,20}(?:\/title)?$/.test(resource)))) ||
      (area === 'api' &&
        isLabel &&
        ((method === 'POST' && jsonWrite) ||
          (method === 'DELETE' &&
            body === undefined &&
            Object.keys(query).length === 1 &&
            typeof query.name === 'string'))) ||
      (body === undefined &&
        Object.keys(query).length === 0 &&
        ((area === 'api' && method === 'PUT' && /^content\/\d{1,20}\/move\/append\/\d{1,20}$/.test(resource)) ||
          // No draft or purge flags may reach Cloud's delete endpoint.
          (area === 'cloud-v2' && method === 'DELETE' && /^pages\/\d{1,20}$/.test(resource))))
    if (
      actual.protocol !== 'https:' ||
      actual.port ||
      contextPath !== '/wiki' ||
      !/^\/wiki(?:\/|$)/.test(actual.pathname) ||
      (!cloudRead && !cloudWrite)
    )
      return { kind: 'invalid' }
  } else if (area === 'cloud-v2') return { kind: 'invalid' }
  if (resource === 'current-page') {
    if ((area !== 'api' && area !== 'cloud-v2') || method !== 'GET') return { kind: 'invalid' }
    const path = actual.pathname.slice(contextPath.length).replace(/;[^/]*|%3bjsessionid(?:=|%3d)[^/]*/gi, '')
    const type = document.querySelector<HTMLMetaElement>('meta[name="ajs-content-type"]')?.content
    const metaId = document.querySelector<HTMLMetaElement>('meta[name="ajs-page-id"]')?.content
    if (type && type !== 'page') return { kind: 'not-page' }
    if (path === '/pages/viewpage.action') {
      const [id, duplicate] = actual.searchParams.getAll('pageId')
      if (id && duplicate === undefined && (!metaId || metaId === id)) pageId = id
    } else if (!cloud && /^\/display\/[^/]+\/[^/]+\/?$/.test(path)) {
      pageId = metaId
    } else {
      // Data Center 9.1 and later put the page ID in the pretty URL.
      const id = /^\/spaces\/[^/]+\/pages\/(\d{1,20})(?:\/[^/]+)?\/?$/.exec(path)?.[1]
      if (id && (!metaId || metaId === id)) pageId = id
    }
    if (!pageId || !/^\d{1,20}$/.test(pageId)) return { kind: 'not-page' }
    resource = (cloud ? 'pages/' : 'content/') + pageId
  }

  if (!cloud) {
    if (area === 'experimental' && (method !== 'GET' || !/^content\/\d{1,20}\/version$/.test(resource)))
      return { kind: 'invalid' }
    const labelResource = /^content\/\d{1,20}\/label$/.test(resource)
    const pageResource = /^content\/\d{1,20}$/.test(resource)
    if (method === 'POST' && resource !== 'content' && !labelResource) return { kind: 'invalid' }
    // A page is updated with no query: one with a status could bring it back from the trash.
    if (method === 'PUT' && (!pageResource || Object.keys(query).length)) return { kind: 'invalid' }
    if (method === 'DELETE' && !labelResource) {
      // Deleting content in any other status could purge it. Only a current page may enter the trash.
      if (!pageResource || query.status !== 'current' || Object.keys(query).length !== 1) return { kind: 'invalid' }
    }
  }
  const apiPath = area === 'cloud-v2' ? `${contextPath}/api/v2/` : `${contextPath}/rest/${area}/`
  const endpoint = new URL(actual.origin + apiPath + resource)
  if (endpoint.origin !== actual.origin || !endpoint.pathname.startsWith(apiPath) || endpoint.hash || endpoint.search)
    return { kind: 'invalid' }
  endpoint.search = new URLSearchParams(
    Object.entries(query).flatMap(([key, value]) =>
      Array.isArray(value) ? value.map((item): [string, string] => [key, item]) : [[key, value]],
    ),
  ).toString()

  const controller = new AbortController()
  globalThis.cofunConfluenceReads ??= new Map()
  globalThis.cofunConfluenceReads.set(requestId, controller)
  const cap = 1_000_000
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(endpoint.href, {
      method,
      credentials: 'same-origin',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      headers,
      body,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    })
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
      return { kind: 'unexpected-web-response' }
    if (response.status === 401) return { kind: 'auth' }
    if (response.status === 400) return { kind: 'rejected' }
    if (response.status === 403) return { kind: 'forbidden' }
    if (response.status === 404) return { kind: 'missing' }
    if (response.status === 405 || response.status === 501) return { kind: 'unsupported' }
    if (response.status === 409) return { kind: 'conflict' }
    if (response.status === 429) return { kind: 'limited' }
    if (!response.ok) return { kind: 'network' }
    if (response.status === 204 && method === 'DELETE') return { kind: 'ok', status: response.status, data: null }
    const contentType = response.headers.get('content-type') ?? ''
    if (!/^application\/json(?:;|$)/i.test(contentType))
      return { kind: /^text\/html(?:;|$)/i.test(contentType) ? 'unexpected-web-response' : 'invalid' }
    if (Number(response.headers.get('content-length')) > cap || !response.body) return { kind: 'large' }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let json = ''
    let size = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > cap) {
        await reader.cancel()
        return { kind: 'large' }
      }
      json += decoder.decode(part.value, { stream: true })
    }
    try {
      const data: unknown = JSON.parse(json + decoder.decode())
      return { kind: 'ok', pageId, status: response.status, data }
    } catch {
      return { kind: 'invalid' }
    }
  } catch {
    return { kind: 'network' }
  } finally {
    globalThis.cofunConfluenceReads.delete(requestId)
  }
}
