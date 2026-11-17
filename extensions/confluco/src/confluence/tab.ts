// Runs the read-only connector requests in the selected Confluence document, with its site session.
import { z } from '../zod'
import { matchesInstance, type Instance } from './instance'

export interface ConfluenceTab {
  tabId: number
  url: string
  instance: Instance
}

export async function currentConfluenceTab(instance: Instance | undefined): Promise<ConfluenceTab> {
  if (!instance) throw new Error('Connect a self-managed Confluence site in Settings first.')
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined || !tab.url) throw new Error('Open the connected Confluence site in the current tab.')
  const url = new URL(tab.url)
  if (!matchesInstance(url, instance)) throw new Error('Open the connected Confluence site in the current tab.')
  url.hash = ''
  return { tabId: tab.id, url: url.href, instance }
}

/** The path is supplied by api.ts. A page request appends the document's own numeric page ID. */
type ReadRequest = { kind: 'page' | 'search'; path: string; query: Record<string, string> }

const ErrorKind = z.enum([
  'changed',
  'not-page',
  'auth',
  'unexpected-web-response',
  'rejected',
  'forbidden',
  'missing',
  'limited',
  'large',
  'network',
  'invalid',
])
const errors: Record<z.infer<typeof ErrorKind>, string> = {
  changed: 'The Confluence tab changed. Open the intended page and ask again.',
  'not-page': 'Open a published Confluence page before asking Confluco to read it.',
  auth: 'Sign in to Confluence in the page tab, then ask again.',
  'unexpected-web-response':
    'Confluence returned a redirect or a web page. Check the configured URL and your session, then ask again.',
  rejected: 'Confluence rejected the request. Check the search text or space key.',
  forbidden: 'Your Confluence account does not have permission for this request.',
  missing: 'The page or search endpoint is missing or is not visible to your account.',
  limited: 'Confluence rate-limited this request. Wait before asking again.',
  large: 'The Confluence response was too large to read.',
  network: 'Could not complete the request to Confluence. Check the site and try again.',
  invalid: 'Confluence did not return the expected response.',
}
const Result = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    pageId: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
    data: z.unknown(),
  }),
  z.object({ kind: ErrorKind }),
])

/** An unexpected answer from a service acting as the user stops the question. */
export class ConfluenceReadError extends Error {
  readonly stopsQuestion: string

  constructor(message: string) {
    super(message)
    this.stopsQuestion = message
  }
}

export async function readInTab(target: ConfluenceTab, request: ReadRequest, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (!(await chrome.permissions.contains({ origins: [target.instance.permission] }))) {
    throw new Error('Confluco needs Chrome site access. Reconnect the site in Settings.')
  }
  signal?.throwIfAborted()
  const requestId = crypto.randomUUID()
  const injection = { target: { tabId: target.tabId }, world: 'ISOLATED' as const }
  let cancel: (() => void) | undefined
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => {
      reject(signal?.reason)
      void chrome.scripting.executeScript({ ...injection, func: abortRead, args: [requestId] }).catch(() => {})
    }
    signal?.addEventListener('abort', cancel, { once: true })
  })

  let raw: unknown
  try {
    const [frame] = await Promise.race([
      chrome.scripting.executeScript({
        ...injection,
        func: readConfluence,
        args: [target.url, target.instance.path, request, requestId],
      }),
      stopped,
    ])
    raw = frame?.result
  } catch {
    signal?.throwIfAborted()
    throw new ConfluenceReadError('Could not access the Confluence tab. Check its site access and ask again.')
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel)
  }
  signal?.throwIfAborted()

  const response = Result.safeParse(raw)
  if (!response.success) throw new ConfluenceReadError(errors.invalid)
  const result = response.data
  if (result.kind === 'ok') return result
  throw new ConfluenceReadError(errors[result.kind])
}

declare global {
  // Both scripts run in the same isolated world. The page cannot access these requests.
  var cofunConfluenceReads: Map<string, AbortController> | undefined
}

function abortRead(id: string) {
  globalThis.cofunConfluenceReads?.get(id)?.abort()
}

/** Chrome serializes this function on its own. It runs only in the user's top-level document. */
async function readConfluence(expectedUrl: string, contextPath: string, request: ReadRequest, requestId: string) {
  const actual = new URL(location.href)
  actual.hash = ''
  if (actual.href !== expectedUrl) return { kind: 'changed' }

  let pageId: string | undefined
  if (request.kind === 'page') {
    const path = actual.pathname.slice(contextPath.length).replace(/;[^/]*|%3bjsessionid(?:=|%3d)[^/]*/gi, '')
    const type = document.querySelector<HTMLMetaElement>('meta[name="ajs-content-type"]')?.content
    const metaId = document.querySelector<HTMLMetaElement>('meta[name="ajs-page-id"]')?.content
    if (type && type !== 'page') return { kind: 'not-page' }
    if (path === '/pages/viewpage.action') {
      const [id, duplicate] = actual.searchParams.getAll('pageId')
      if (id && duplicate === undefined && (!metaId || metaId === id)) pageId = id
    } else if (/^\/display\/[^/]+\/[^/]+\/?$/.test(path)) {
      pageId = metaId
    } else {
      // Data Center 9.1 and later put the page ID in the pretty URL.
      const id = /^\/spaces\/[^/]+\/pages\/(\d{1,20})(?:\/[^/]+)?\/?$/.exec(path)?.[1]
      if (id && (!metaId || metaId === id)) pageId = id
    }
    if (!pageId || !/^\d{1,20}$/.test(pageId)) return { kind: 'not-page' }
  }

  const endpoint = new URL(request.path + (pageId ?? ''), actual.origin)
  if (
    endpoint.origin !== actual.origin ||
    !endpoint.pathname.startsWith(contextPath + '/') ||
    endpoint.search ||
    endpoint.hash
  )
    return { kind: 'invalid' }
  endpoint.search = new URLSearchParams(request.query).toString()

  const controller = new AbortController()
  globalThis.cofunConfluenceReads ??= new Map()
  globalThis.cofunConfluenceReads.set(requestId, controller)
  // Bound the time and data taken from the user's site even when it sends no Content-Length.
  const cap = 1_000_000
  try {
    const response = await fetch(endpoint.href, {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    })
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
      return { kind: 'unexpected-web-response' }
    if (response.status === 401) return { kind: 'auth' }
    if (response.status === 400) return { kind: 'rejected' }
    if (response.status === 403) return { kind: 'forbidden' }
    if (response.status === 404) return { kind: 'missing' }
    if (response.status === 429) return { kind: 'limited' }
    if (!response.ok) return { kind: 'network' }
    const mediaType = response.headers.get('content-type') ?? ''
    if (/^text\/html(?:;|$)/i.test(mediaType)) return { kind: 'unexpected-web-response' }
    if (!/^application\/json(?:;|$)/i.test(mediaType) || !response.body) return { kind: 'invalid' }
    if (Number(response.headers.get('content-length')) > cap) return { kind: 'large' }

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
      return { kind: 'ok', pageId, data }
    } catch {
      return { kind: 'invalid' }
    }
  } catch {
    return { kind: 'network' }
  } finally {
    globalThis.cofunConfluenceReads.delete(requestId)
  }
}
