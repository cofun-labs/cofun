import { z } from '../zod'

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
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    return {
      origin: url.origin,
      path: cloud ? '/wiki' : path,
      cloud,
      permission: `${url.protocol}//${url.hostname}:${port}/*`,
    }
  } catch {
    return undefined
  }
}

export type Instance = NonNullable<ReturnType<typeof parseInstance>>

const instanceKey = (userId: string) => `confluence-instance:${userId}`
const grantKey = (permission: string) => `confluence-grant:${permission}`
const connectionLock = 'confluence-connections'

export async function getInstance(userId: string): Promise<Instance | undefined> {
  const key = instanceKey(userId)
  const saved = await chrome.storage.local.get(key)
  return parseSavedInstance(saved[key])
}

export function watchInstance(userId: string, onChange: (instance: Instance | undefined) => void): () => void {
  const key = instanceKey(userId)
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && key in changes) onChange(parseSavedInstance(changes[key].newValue))
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}

function parseSavedInstance(value: unknown): Instance | undefined {
  const url = z.string().safeParse(value)
  if (url.success) return parseInstance(url.data)
}

/** Call directly from a user gesture so Chrome can ask for the site permission. */
export async function connectInstance(userId: string, instance: Instance): Promise<boolean> {
  const origins = [instance.permission]
  // Start the permission check first without yielding the user gesture needed for the request.
  const [alreadyGranted, allowed] = await Promise.all([
    chrome.permissions.contains({ origins }),
    chrome.permissions.request({ origins }),
  ])
  if (!allowed) return false
  return navigator.locks.request(connectionLock, async () => {
    if (!(await chrome.permissions.contains({ origins }))) return false
    const previous = await getInstance(userId)
    try {
      await chrome.storage.local.set({
        [instanceKey(userId)]: instance.origin + instance.path,
        ...(!alreadyGranted && { [grantKey(instance.permission)]: true }),
      })
    } catch (error) {
      if (!alreadyGranted) await releaseUnusedPermission(instance.permission, true)
      throw error
    }
    if (previous && previous.permission !== instance.permission) await releaseUnusedPermission(previous.permission)
    return true
  })
}

export function disconnectInstance(userId: string, instance: Instance): Promise<Instance | undefined> {
  return navigator.locks.request(connectionLock, async () => {
    const current = await getInstance(userId)
    if (current?.origin !== instance.origin || current.path !== instance.path) return current
    await chrome.storage.local.remove(instanceKey(userId))
    await releaseUnusedPermission(instance.permission)
  })
}

async function releaseUnusedPermission(permission: string, justGranted = false): Promise<void> {
  const all = await chrome.storage.local.get(null)
  const key = grantKey(permission)
  if (!justGranted && all[key] !== true) return
  // Chrome host grants are shared by all extension panels. Keep one another connection still uses.
  const stillUsed = Object.entries(all).some(
    ([key, value]) =>
      key.startsWith('confluence-instance:') &&
      typeof value === 'string' &&
      parseInstance(value)?.permission === permission,
  )
  if (stillUsed) return
  await chrome.permissions.remove({ origins: [permission] })
  await chrome.storage.local.remove(key)
}

export function matchesInstance(url: URL, instance: Instance): boolean {
  return (
    url.origin === instance.origin &&
    !url.username &&
    !url.password &&
    (url.pathname === instance.path || url.pathname.startsWith(instance.path + '/'))
  )
}
