// Runs Confluence REST requests and editor reads in the connected document with its site session.
import { z } from '../zod'
import { getInstance, matchesInstance, type Instance } from './instance'

export interface ConfluenceTab {
  tabId: number
  url: string
  instance: Instance
}

export async function currentConfluenceTab(instance: Instance | undefined): Promise<ConfluenceTab> {
  if (!instance) throw new Error('Connect a Confluence site in Settings first.')
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined || !tab.url) throw new Error('Open the connected Confluence site in the current tab.')
  const url = new URL(tab.url)
  if (!matchesInstance(url, instance)) throw new Error('Open the connected Confluence site in the current tab.')
  url.hash = ''
  return { tabId: tab.id, url: url.href, instance }
}

function confluenceTab(tab: chrome.tabs.Tab | undefined, instance: Instance | undefined): ConfluenceTab | undefined {
  if (!instance || tab?.id === undefined || !tab.url) return
  try {
    const url = new URL(tab.url)
    if (!matchesInstance(url, instance)) return
    url.hash = ''
    return { tabId: tab.id, url: url.href, instance }
  } catch {
    return undefined
  }
}

export async function captureConfluenceTab(accountId: string) {
  const [[tab], instance] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    getInstance(accountId),
  ])
  return confluenceTab(tab, instance)
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
      'not-restorable',
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
  'not-restorable':
    'Confluco could not prepare the restore confirmation. Check the page and your session in Confluence.',
  changed: 'The Confluence tab changed. Open the intended page and ask again.',
  'not-page': 'Open a published Confluence page before asking Confluco to read it.',
  auth: 'Sign in to Confluence in the page tab, then ask again.',
  'unexpected-web-response':
    'Confluence returned a redirect or a web page. Check the configured URL and your session, then ask again.',
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
export type RestArea = 'api' | 'experimental' | 'cloud-v2' | 'cloud-restore' | 'cloud-attachment'
type RestRequest = {
  area: RestArea
  resource: string
  query: Query
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: string
  file?: { name: string; mediaType: string; base64: string }
}

export const attachmentSizeLimit = 10 * 1024 * 1024

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
  if (!tab) refuse('Connect a self-managed Confluence instance and open a page on it first.')
  return tab
}

const selectionLimit = 4000
const editorSelectionResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('selection'), text: z.string().min(1).max(selectionLimit), chars: z.int().positive() }),
  z.object({ kind: z.enum(['changed', 'not-editor', 'empty']) }),
])

export async function readEditorSelection(target: ConfluenceTab | undefined) {
  const tab = requireTab(target)
  if (!(await chrome.permissions.contains({ origins: [tab.instance.permission] })))
    refuse('Confluco needs Chrome site access. Reconnect this Confluence instance and try again.')
  const [frame] = await chrome.scripting
    .executeScript({
      target: { tabId: tab.tabId },
      world: 'ISOLATED',
      func: readSelection,
      args: [tab.url, tab.instance.path, selectionLimit],
    })
    .catch(() => refuse('Could not access the editor. Open the intended Confluence tab and try again.'))
  const parsed = editorSelectionResult.safeParse(frame?.result)
  if (!parsed.success) refuse('Confluence did not return the expected editor selection.')
  switch (parsed.data.kind) {
    case 'selection':
      if (!frame?.documentId) refuse('Confluco could not identify the editor document.')
      return { tab, documentId: frame.documentId, text: parsed.data.text, chars: parsed.data.chars }
    case 'changed':
      refuse('The active tab changed. Select text in the intended editor and try again.')
    case 'not-editor':
      refuse('Open a supported Confluence editor and select text in the page body.')
    case 'empty':
      refuse('Select text in the Confluence editor before attaching it.')
  }
}

export async function isEditorSelectionCurrent(tab: ConfluenceTab, documentId: string): Promise<boolean> {
  try {
    if (!(await chrome.permissions.contains({ origins: [tab.instance.permission] }))) return false
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId: tab.tabId },
      world: 'ISOLATED',
      func: (expectedUrl: string) => {
        const current = new URL(location.href)
        current.hash = ''
        return current.href === expectedUrl
      },
      args: [tab.url],
    })
    return frame?.documentId === documentId && frame.result === true
  } catch {
    return false
  }
}

/** Runs in the isolated world of the captured top-level tab. */
function readSelection(expectedUrl: string, contextPath: string, limit: number) {
  const current = new URL(location.href)
  current.hash = ''
  if (current.href !== expectedUrl) return { kind: 'changed' }
  const path = current.pathname.slice(contextPath.length).replace(/;[^/]*|%3bjsessionid(?:=|%3d)[^/]*/gi, '')
  if (!/^\/pages\/(?:editpage|resumedraft|createpage)\.action$/.test(path)) return { kind: 'not-editor' }

  const frame = document.querySelector<HTMLIFrameElement>('iframe#wysiwygTextarea_ifr')
  const editor = frame?.contentDocument?.body
  if (!editor || editor.getAttribute('contenteditable') !== 'true') return { kind: 'not-editor' }
  const selection = editor.ownerDocument.getSelection()
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    selection.isCollapsed ||
    !editor.contains(selection.anchorNode) ||
    !editor.contains(selection.focusNode)
  )
    return { kind: 'empty' }
  const text = selection.toString().trim()
  if (!text) return { kind: 'empty' }
  return { kind: 'selection', text: text.slice(0, limit), chars: text.length }
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

export function restoreCloudPage(tab: ConfluenceTab, pageId: string, key: string, signal?: AbortSignal) {
  return sendConfluence(
    tab,
    {
      area: 'cloud-restore',
      resource: 'trash',
      method: 'POST',
      query: { key, contentId: pageId },
    },
    signal,
    'Confluence rejected the restore. Check the page and your space administrator access.',
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

export function restoreConfluencePage(target: ConfluenceTab, id: string, nextVersion: number, signal?: AbortSignal) {
  return sendConfluence(
    target,
    {
      area: 'api',
      resource: `content/${id}`,
      method: 'PUT',
      query: { status: 'trashed' },
      body: JSON.stringify({ id, status: 'current', version: { number: nextVersion } }),
    },
    signal,
  )
}

export async function uploadConfluenceAttachment(
  target: ConfluenceTab,
  pageId: string,
  attachmentId: string | undefined,
  file: File,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  if (file.size > attachmentSizeLimit) refuse('Choose an attachment of at most 10 MiB.')
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(','))
        return reject(new Error('Could not read the selected file.'))
      resolve(reader.result.slice(reader.result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
  const collection = `content/${pageId}/child/attachment`
  const upload = { name: file.name, mediaType: file.type, base64 }
  return sendConfluence(
    target,
    target.instance.cloud
      ? { area: 'cloud-attachment', resource: 'doattachfile.action', method: 'POST', query: { pageId }, file: upload }
      : {
          area: 'api',
          resource: attachmentId ? `${collection}/${attachmentId.replace(/^att/, '')}/data` : collection,
          method: 'POST',
          query: attachmentId ? {} : { status: 'current' },
          file: upload,
        },
    signal,
    'Confluence rejected the upload. Check the file and attachment rules on the destination page.',
  )
}

async function sendConfluence(target: ConfluenceTab, request: RestRequest, signal?: AbortSignal, rejection?: string) {
  signal?.throwIfAborted()
  if (!(await chrome.permissions.contains({ origins: [target.instance.permission] }))) {
    refuse('Confluco needs Chrome site access. Reconnect this Confluence instance and try again.')
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
    if (kind === 'rejected' && request.method === 'PUT' && request.query.status === 'trashed')
      refuse('Confluence rejected the restore. Check the page in the space trash before trying again.')
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
  const { area, query, method, body, file } = request
  let { resource } = request
  let pageId: string | undefined
  const cloud = /(?:^|\.)atlassian\.net$/.test(actual.hostname)
  const nativeUpload = area === 'cloud-attachment'
  const nativeRestore = area === 'cloud-restore'
  if (
    nativeUpload &&
    (!file ||
      method !== 'POST' ||
      resource !== 'doattachfile.action' ||
      body !== undefined ||
      Object.keys(query).length !== 1 ||
      typeof query.pageId !== 'string' ||
      !/^\d{1,20}$/.test(query.pageId))
  )
    return { kind: 'invalid' }
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
      (file !== undefined && !nativeUpload) ||
      (!nativeUpload &&
        !cloudRead &&
        !cloudWrite &&
        !(
          nativeRestore &&
          resource === 'trash' &&
          method === 'POST' &&
          body === undefined &&
          Object.keys(query).length === 2 &&
          typeof query.key === 'string' &&
          query.key.length > 0 &&
          query.key.length <= 255 &&
          typeof query.contentId === 'string' &&
          /^\d{1,20}$/.test(query.contentId)
        ))
    )
      return { kind: 'invalid' }
  } else if (area === 'cloud-v2' || nativeRestore || nativeUpload) return { kind: 'invalid' }
  if (resource === 'current-page' || nativeUpload) {
    if (!nativeUpload && ((area !== 'api' && area !== 'cloud-v2') || method !== 'GET')) return { kind: 'invalid' }
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
    if (nativeUpload) {
      if (pageId !== query.pageId) return { kind: 'changed' }
    } else resource = (cloud ? 'pages/' : 'content/') + pageId
  }

  if (!cloud) {
    if (area === 'experimental' && (method !== 'GET' || !/^content\/\d{1,20}\/version$/.test(resource)))
      return { kind: 'invalid' }
    const labelResource = /^content\/\d{1,20}\/label$/.test(resource)
    const pageResource = /^content\/\d{1,20}$/.test(resource)
    const attachmentCreate = /^content\/\d{1,20}\/child\/attachment$/.test(resource)
    const attachmentReplace = /^content\/\d{1,20}\/child\/attachment\/\d{1,20}\/data$/.test(resource)
    if (file) {
      if (
        area !== 'api' ||
        method !== 'POST' ||
        body !== undefined ||
        !(
          (attachmentCreate && query.status === 'current' && Object.keys(query).length === 1) ||
          (attachmentReplace && Object.keys(query).length === 0)
        )
      )
        return { kind: 'invalid' }
    } else if (method === 'POST' && resource !== 'content' && !labelResource) return { kind: 'invalid' }
    if (method === 'PUT' && !pageResource) return { kind: 'invalid' }
    if (method === 'DELETE' && !labelResource) {
      // Deleting content in any other status could purge it. Only a current page may enter the trash.
      if (!pageResource || query.status !== 'current' || Object.keys(query).length !== 1) return { kind: 'invalid' }
    }
  }
  const apiPath =
    nativeRestore || nativeUpload
      ? `${contextPath}/pages/`
      : area === 'cloud-v2'
        ? `${contextPath}/api/v2/`
        : `${contextPath}/rest/${area}/`
  const endpoint = new URL(actual.origin + apiPath + (nativeRestore ? 'restoretrashitem.action' : resource))
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
  let restoreSubmitted = false
  try {
    let payload: BodyInit | undefined = body
    const headers: Record<string, string> = { Accept: nativeRestore || nativeUpload ? 'text/html' : 'application/json' }
    if (file) {
      const decoded = atob(file.base64)
      const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0))
      const form = new FormData()
      form.append(
        nativeUpload ? 'file_0' : 'file',
        new Blob([bytes], { type: file.mediaType || 'application/octet-stream' }),
        file.name,
      )
      payload = form
      headers['X-Atlassian-Token'] = nativeUpload ? 'no-check' : 'nocheck'
      if (nativeUpload) headers['X-Requested-With'] = 'XMLHttpRequest'
    } else if (body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(endpoint.href, {
      method: nativeRestore ? 'GET' : method,
      credentials: 'same-origin',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      headers,
      body: payload,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(file ? 60_000 : 15_000)]),
    })
    function failure(response: Response): { kind: Exclude<z.infer<typeof result>['kind'], 'ok'> } | undefined {
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
        return { kind: 'unexpected-web-response' }
      if (response.status === 401) return { kind: 'auth' }
      if (response.status === 400 || (file && response.status === 413)) return { kind: 'rejected' }
      if (response.status === 403) return { kind: 'forbidden' }
      if (response.status === 404) return { kind: 'missing' }
      if (response.status === 405 || response.status === 501) return { kind: 'unsupported' }
      if (response.status === 409) return { kind: 'conflict' }
      if (response.status === 429) return { kind: 'limited' }
      if (!response.ok) return { kind: 'network' }
    }
    const failed = failure(response)
    if (failed)
      return nativeRestore && ['unexpected-web-response', 'network', 'invalid', 'large'].includes(failed.kind)
        ? { kind: 'not-restorable' }
        : failed
    if (response.status === 204 && method === 'DELETE') return { kind: 'ok', status: response.status, data: null }
    const contentType = response.headers.get('content-type') ?? ''
    if (nativeUpload) {
      // The native action returns an HTML page. The caller verifies the exact attachment with REST.
      void response.body?.cancel()
      if (response.status !== 200 || !/^text\/html(?:;|$)/i.test(contentType)) return { kind: 'invalid' }
      return { kind: 'ok', status: response.status, data: null }
    }
    if (nativeRestore ? !/^text\/html(?:;|$)/i.test(contentType) : !/^application\/json(?:;|$)/i.test(contentType))
      return {
        kind: nativeRestore
          ? 'not-restorable'
          : /^text\/html(?:;|$)/i.test(contentType)
            ? 'unexpected-web-response'
            : 'invalid',
      }
    if (Number(response.headers.get('content-length')) > cap || !response.body)
      return { kind: nativeRestore ? 'not-restorable' : 'large' }

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
        return { kind: nativeRestore ? 'not-restorable' : 'large' }
      }
      json += decoder.decode(part.value, { stream: true })
    }
    const text = json + decoder.decode()
    if (nativeRestore) {
      const html = new DOMParser().parseFromString(text, 'text/html')
      const expected = actual.origin + contextPath + '/pages/dorestoretrashitem.action'
      const forms = [...html.forms].filter(
        (form) =>
          form.method.toLowerCase() === 'post' &&
          new URL(form.getAttribute('action') ?? '', endpoint).href === expected,
      )
      if (forms.length !== 1) return { kind: 'not-restorable' }
      const form = forms[0]
      const field = (name: string) => {
        const inputs = [...form.querySelectorAll('input')].filter((input) => input.name === name)
        return inputs.length === 1 ? inputs[0].value : undefined
      }
      const key = field('key')
      const contentId = field('contentId')
      const token = field('atl_token')
      const confirm = field('confirm')
      if (
        !contentId ||
        !key ||
        contentId !== query.contentId ||
        key !== query.key ||
        !token ||
        token.length > 8192 ||
        !confirm ||
        confirm.length > 255
      )
        return { kind: 'not-restorable' }
      const atPost = new URL(location.href)
      atPost.hash = ''
      if (atPost.href !== expectedUrl) return { kind: 'changed' }
      // The CSRF value stays inside this isolated tab and is never returned to the extension.
      restoreSubmitted = true
      const posted = await fetch(expected, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'manual',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ atl_token: token, key, contentId, confirm }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      })
      // The native action may redirect. Never follow it; the caller may verify the same page once.
      const denied = failure(posted)
      void posted.body?.cancel()
      if (denied) return denied
      // Native success is an HTML response. The caller verifies the page with a separate REST read.
      if (posted.status !== 200 || !/^text\/html(?:;|$)/i.test(posted.headers.get('content-type') ?? ''))
        return { kind: 'invalid' }
      return { kind: 'ok', status: posted.status, data: null }
    }
    try {
      const data: unknown = JSON.parse(text)
      return { kind: 'ok', pageId, status: response.status, data }
    } catch {
      return { kind: 'invalid' }
    }
  } catch {
    return { kind: nativeRestore && !restoreSubmitted ? 'not-restorable' : 'network' }
  } finally {
    globalThis.cofunConfluenceReads.delete(requestId)
  }
}
