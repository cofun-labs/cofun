// The unpacked extension in Canary: is it enabled, where does Chrome load it from, and reloading it
// after a build. Read through chrome://extensions (chrome.developerPrivate), in a tab this tool opens
// and closes. It only reports problems such as Developer mode being off; it never changes settings.
import { spawn } from 'node:child_process'
import { access, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { type Browser, type Target, sleep, until } from './cdp'

export const EXTENSIONS = {
  notico: { id: 'moblfnjjebknafkgoifncombfnbfghom', name: 'Notico: AI copilot for Notion' },
  confluco: { id: 'eolgkcpoohaeaedpcnljkldkpnjcdemm', name: 'Confluco: AI copilot for Confluence' },
} as const

export type ExtensionSlug = keyof typeof EXTENSIONS

export interface ExtensionStatus {
  developerMode: boolean
  /** Undefined when the extension isn't installed in this profile. */
  extension?: {
    state: string
    location: string
    /** The folder an unpacked extension is loaded from. */
    path?: string
    disableReasons: string[]
  }
}

/** Why the extension can't run from a build of this checkout, or undefined if it can. */
export function problem(extension: ExtensionSlug, status: ExtensionStatus): string | undefined {
  if (!status.developerMode) {
    return (
      'Developer mode is off in chrome://extensions, so Chrome disables the unpacked extension. ' +
      'Turn it on there by hand; this tool never changes browser settings.'
    )
  }
  const { id, name } = EXTENSIONS[extension]
  const ext = status.extension
  if (!ext) return `${name} (${id}) is not installed in this Chrome profile. Load it unpacked by hand.`
  if (ext.location !== 'UNPACKED' || !ext.path) {
    return `${name} is not loaded unpacked (${ext.location}), so a build can't replace it.`
  }
  if (ext.state !== 'ENABLED') {
    const why = ext.disableReasons.length ? ` (${ext.disableReasons.join(', ')})` : ''
    return `${name} is ${ext.state.toLowerCase()}${why}. Enable it in chrome://extensions by hand.`
  }
  return undefined
}

/**
 * Why a new build must not replace the loaded one, or undefined if it may. The manifest `key` fixes
 * the extension id, which Chrome uses for the profile's storage and sign-in.
 */
function replaceProblem(extension: ExtensionSlug, loaded: string, built: string): string | undefined {
  const key = (text: string) => manifestOf(text)?.key
  if (key(built) === key(loaded)) return undefined
  return (
    "The build's manifest key differs from the loaded extension's, so reloading would change the " +
    `extension id. Check CRX_PUBLIC_KEY in this checkout's extensions/${extension}/.env and .env.local.`
  )
}

function manifestOf(text: string): { name?: unknown; key?: unknown } | undefined {
  try {
    const json = JSON.parse(text) as unknown
    return json && typeof json === 'object' ? json : undefined
  } catch {
    return undefined
  }
}

/** A chrome://extensions tab of our own, open for the duration of `fn`. */
export async function withExtensionsPage<T>(
  browser: Browser,
  extension: ExtensionSlug,
  fn: (page: Target) => Promise<T>,
): Promise<T> {
  const id = await browser.open(`chrome://extensions/?id=${EXTENSIONS[extension].id}`, { background: true })
  try {
    const page = await browser.attach(id)
    await until(() => page.evaluate(() => (typeof chrome?.developerPrivate === 'object' ? true : undefined), []), {
      ms: 10_000,
      onTimeout: () => new Error('chrome://extensions did not load.'),
    })
    return await fn(page)
  } finally {
    await browser.close(id)
  }
}

export function readStatus(page: Target, extension: ExtensionSlug): Promise<ExtensionStatus> {
  return page.evaluate(
    (id: string) =>
      new Promise<ExtensionStatus>((resolve) => {
        chrome.developerPrivate.getProfileConfiguration((config) => {
          chrome.developerPrivate.getExtensionInfo(id, (info) => {
            // getExtensionInfo reports an unknown id through lastError.
            const known = !chrome.runtime?.lastError && info
            const reasons = (known && info.disableReasons) || {}
            resolve({
              developerMode: config.inDeveloperMode,
              extension: known
                ? {
                    state: info.state,
                    location: info.location,
                    path: info.path,
                    disableReasons: Object.keys(reasons).filter((k) => reasons[k]),
                  }
                : undefined,
            })
          })
        })
      }),
    [EXTENSIONS[extension].id],
  )
}

/** Reloads the extension from its folder; resolves with Chrome's load error, if any. */
export function reloadExtension(page: Target, extension: ExtensionSlug): Promise<string | undefined> {
  return page.evaluate(
    (id: string) =>
      new Promise<string | undefined>((resolve) => {
        chrome.developerPrivate.reload(id, { failQuietly: true }, (loadError) => {
          const err = chrome.runtime?.lastError?.message
          resolve(err ?? (loadError ? `${loadError.error} (${loadError.path})` : undefined))
        })
      }),
    [EXTENSIONS[extension].id],
  )
}

/**
 * Builds this checkout's extension, using its environment files, and puts it in `outDir`. It
 * is built next to `outDir` first and replaces it only if it would load as the same extension.
 */
export async function build(repoRoot: string, extension: ExtensionSlug, outDir: string): Promise<void> {
  if (!isAbsolute(outDir)) throw new Error(`Chrome reported a relative extension folder: ${outDir}`)
  const manifest = await readFile(join(outDir, 'manifest.json'), 'utf8').catch(() => '')
  const { name } = EXTENSIONS[extension]
  // A build from before the extension's name took its descriptor ("Confluco" before 0.1.0) is
  // still that extension's build. This can go once every shared Canary has a build with the new name.
  const loaded = manifestOf(manifest)?.name
  if (loaded !== name && loaded !== name.split(':')[0]) {
    throw new Error(`${outDir} doesn't hold a build of ${name}; not building over it.`)
  }
  const source = join(repoRoot, 'extensions', extension)
  if (
    !(await access(join(source, 'node_modules', '.bin', 'vite')).then(
      () => true,
      () => false,
    ))
  ) {
    throw new Error(`The extension's dependencies are not installed in ${repoRoot}: run pnpm install first.`)
  }
  const next = `${outDir}.next-${process.pid}`
  try {
    await viteBuild(source, next)
    const stop = replaceProblem(extension, manifest, await readFile(join(next, 'manifest.json'), 'utf8'))
    if (stop) throw new Error(stop)
    // Swap the folders so the shared extension folder is never left missing: the old build comes
    // back if the new one can't take its place.
    await swap(outDir, next)
  } finally {
    await rm(next, { recursive: true, force: true })
  }
}

async function swap(outDir: string, next: string): Promise<void> {
  const old = `${outDir}.old-${process.pid}`
  await rename(outDir, old)
  try {
    await rename(next, outDir)
  } catch (err) {
    await rename(old, outDir)
    throw err
  }
  await rm(old, { recursive: true, force: true })
}

async function viteBuild(extension: string, outDir: string): Promise<void> {
  const output: Buffer[] = []
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
      cwd: extension,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (d: Buffer) => output.push(d))
    child.stderr.on('data', (d: Buffer) => output.push(d))
    child.on('error', reject)
    child.on('close', resolve)
  })
  if (code !== 0) throw new Error(`The extension build failed:\n${Buffer.concat(output).toString()}`)
}

/** Waits for the reloaded extension to report enabled again, and returns its status. */
export async function settledStatus(page: Target, extension: ExtensionSlug): Promise<ExtensionStatus> {
  let status = await readStatus(page, extension)
  for (let i = 0; i < 20 && status.extension?.state !== 'ENABLED'; i++) {
    await sleep(250)
    status = await readStatus(page, extension)
  }
  return status
}
