// pnpm e2e: runs ai-e2e scenarios in the shared Chrome Canary. See USAGE in args.ts and docs/bdd.md.
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { type Command, USAGE, UsageError, parseArgs } from './args'
import { Browser, Cdp, DEFAULT_PORT } from './cdp'
import {
  EXTENSION_NAME,
  build,
  problem,
  readStatus,
  reloadExtension,
  settledStatus,
  withExtensionsPage,
} from './extension'
import { type TabNotion, createDatabase, createPage, pageUrl, parseRow, privateSpace, tabNotion, trash } from './notion'
import { withinOwnPages } from './scope'
import { E2eError } from './errors'
import { beforeInterruptExit } from './exit'
import { DEFAULT_NOTION_URL, TimeoutError, isOwnPage, ask, notionTab, openPanel, ownNotionTab, ownPanel } from './panel'
import { formatReply } from './reply'
import { CanaryLock, checkOwner } from './lock'
import { type State, loadState, saveState, statePath } from './state'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

function cdpPort(): number {
  const raw = process.env.E2E_CDP_PORT
  if (raw === undefined) return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new UsageError(`E2E_CDP_PORT is not a port: ${raw}`)
  return port
}
const EXIT_BUSY = 3
const EXIT_NEEDS_ANSWER = 4
const NOT_OWN_PAGE =
  'The side panel opens only on pages pnpm e2e created: pass the url that pnpm e2e page or db printed.'

function defaultOwner(): string {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
    if (branch.trim() && branch.trim() !== 'HEAD') return branch.trim()
  } catch {
    // Not a git checkout: --owner or E2E_OWNER must say.
  }
  throw new UsageError('Name the lock owner with --owner or E2E_OWNER (no git branch to use).')
}

async function lockCommand(lock: CanaryLock, owner: string, command: Extract<Command, { name: 'lock' }>) {
  switch (command.action) {
    case 'acquire': {
      const r = await lock.acquire(owner, command.purpose ?? 'pnpm e2e')
      if (r.status === 'busy') throw new E2eError(`busy: ${r.holder}`, EXIT_BUSY)
      if (r.status === 'acquired' && r.tookOver) console.error(`took over a stale lock: ${r.tookOver}`)
      console.log(r.status === 'held' ? `already held by ${owner}` : `acquired by ${owner}`)
      return
    }
    case 'refresh':
    case 'release': {
      const ok = command.action === 'refresh' ? await lock.refresh(owner) : await lock.release(owner)
      if (!ok) throw new E2eError(`not held by ${owner}: ${(await lock.holder()) ?? 'free'}`)
      console.log(command.action === 'refresh' ? 'refreshed' : 'released')
      return
    }
    case 'status': {
      const holder = await lock.holder()
      console.log(holder ? `held: ${holder}` : 'free')
    }
  }
}

/** Runs `fn` under the Canary lock: one taken just for it, or one this owner already holds. */
async function withLock<T>(lock: CanaryLock, owner: string, purpose: string, fn: () => Promise<T>): Promise<T> {
  const r = await lock.acquire(owner, purpose)
  if (r.status === 'busy') throw new E2eError(`Chrome Canary is busy: ${r.holder}`, EXIT_BUSY)
  if (r.status === 'acquired' && r.tookOver) console.error(`took over a stale lock: ${r.tookOver}`)
  // A long wait for a reply must not let the lock look abandoned.
  const keepFresh = setInterval(() => void lock.refresh(owner).catch(() => undefined), 60_000)
  // Ctrl-C, or a shell killing a long ask, skips the finally below: free a lock taken just for this
  // command there too, or it would look held by this owner until it goes stale.
  const signals = { SIGINT: 130, SIGTERM: 143 } as const
  const onSignal = (signal: keyof typeof signals) => {
    clearInterval(keepFresh)
    void beforeInterruptExit()
      .then(() => (r.status === 'acquired' ? lock.release(owner) : false))
      .catch(() => undefined)
      .finally(() => process.exit(signals[signal]))
  }
  for (const signal of Object.keys(signals) as (keyof typeof signals)[]) process.once(signal, onSignal)
  try {
    return await fn()
  } finally {
    for (const signal of Object.keys(signals)) process.removeListener(signal, onSignal)
    clearInterval(keepFresh)
    if (r.status === 'acquired') await lock.release(owner)
  }
}

async function browserCommand(
  browser: Browser,
  state: State,
  command: Command,
  save: () => Promise<void>,
): Promise<number> {
  switch (command.name) {
    case 'reload': {
      const path = await withExtensionsPage(browser, async (page) => {
        const before = await readStatus(page)
        const stop = problem(before)
        if (stop) throw new E2eError(stop)
        const dir = before.extension!.path!
        await build(REPO_ROOT, dir)
        const loadError = await reloadExtension(page)
        if (loadError) throw new E2eError(`Chrome could not load the build: ${loadError}`)
        const after = problem(await settledStatus(page))
        if (after) throw new E2eError(after)
        return dir
      })
      // Reloading closes the extension's side panels.
      state.panelTarget = undefined
      console.log(`Built ${REPO_ROOT} into ${path}, reloaded ${EXTENSION_NAME}; it is enabled.`)
      return 0
    }
    case 'panel': {
      const own = (url: string) => isOwnPage(url, state.created)
      // Checked before going there, and again once loaded (Notion may redirect).
      if (command.url && !own(command.url)) throw new E2eError(NOT_OWN_PAGE)
      const notion = await notionTab(browser, state, command.url)
      if (!own(await notion.evaluate(() => location.href, []))) {
        throw new E2eError(NOT_OWN_PAGE)
      }
      await openPanel(browser, state, notion)
      console.log('Side panel open on the Notion tab, with a new chat.')
      return 0
    }
    case 'ask': {
      const panel = await ownPanel(browser, state)
      // --allow approves only calls inside the pages this tool created, checked in Notion.
      let notion: Promise<TabNotion> | undefined
      const mayAllow = async (callText: string) => {
        const tab = await ownNotionTab(browser, state)
        if (!tab) return false
        notion ??= browser.attach(tab).then(tabNotion)
        const { client } = await notion
        return withinOwnPages(callText, state.created, async ({ table, id }) => {
          const record = (await client.findRecords([{ table: table as 'block' | 'collection', id }]))[
            table as 'block' | 'collection'
          ]?.[id]
          return record?.parent_id && record.parent_table
            ? { table: record.parent_table, id: record.parent_id }
            : undefined
        })
      }
      try {
        const result = await ask(panel, command.question, command.answer, command.timeoutMs, mayAllow)
        if (command.json) console.log(JSON.stringify(result, null, 2))
        else console.log(formatReply(result.parts))
        if (result.status === 'done') return 0
        console.error(
          result.status === 'outside'
            ? '\nNot approving: this call reaches beyond the pages pnpm e2e created. Deny it with pnpm e2e ask ' +
                '--deny, or decide in the side panel yourself.'
            : '\nWaiting for approval: run pnpm e2e ask --allow or pnpm e2e ask --deny.',
        )
        return EXIT_NEEDS_ANSWER
      } catch (err) {
        if (err instanceof TimeoutError) {
          const parts = err.snapshot.parts
          console.log(command.json ? JSON.stringify({ status: 'timeout', parts }, null, 2) : formatReply(parts))
        }
        throw err
      }
    }
    case 'page':
    case 'db': {
      // E2E_NOTION_URL, when set, picks the workspace: a page in it.
      const tab = await notionTab(browser, state, process.env.E2E_NOTION_URL, DEFAULT_NOTION_URL)
      const notion = await tabNotion(tab)
      const { url, userId } = await tab.evaluate(() => {
        const id = /(?:^|;\s*)notion_user_id=([^;]+)/.exec(document.cookie)?.[1]
        return { url: location.href, userId: id && decodeURIComponent(id) }
      }, [])
      const space = await privateSpace(notion.client, url, userId)
      // Remembered before it is sent, so trash still takes it if this command doesn't finish.
      const remember = async (id: string) => {
        state.created.push(id)
        await save()
      }
      const id =
        command.name === 'page'
          ? await createPage(notion, space, command.title, command.markdown, remember)
          : await createDatabase(notion, space, command.title, command.rows.map(parseRow), remember)
      console.log(`id: ${id}\nurl: ${pageUrl(url, id)}`)
      return 0
    }
    case 'trash': {
      if (!state.created.includes(command.id)) {
        throw new E2eError(`pnpm e2e only trashes pages it created, and ${command.id} is not one of them.`)
      }
      const tab = await notionTab(browser, state, undefined, DEFAULT_NOTION_URL)
      const result = await trash(await tabNotion(tab), command.id)
      state.created = state.created.filter((id) => id !== command.id)
      console.log(
        result === 'trashed'
          ? `Moved ${command.id} to the trash.`
          : `${command.id} doesn't exist (its creation never reached Notion); forgot it.`,
      )
      return 0
    }
    case 'close': {
      const id = await ownNotionTab(browser, state)
      if (id) await browser.close(id)
      state.notionTarget = state.panelTarget = undefined
      console.log(id ? 'Closed the Notion tab.' : 'No Notion tab opened by pnpm e2e is open.')
      return 0
    }
    default:
      throw new Error(`Not a browser command: ${command.name}`)
  }
}

async function main(argv: string[]): Promise<number> {
  const { command, owner: given } = parseArgs(argv)
  if (command.name === 'help') {
    console.log(USAGE)
    return 0
  }
  const owner = given ?? process.env.E2E_OWNER ?? defaultOwner()
  checkOwner(owner)
  const lock = new CanaryLock()
  if (command.name === 'lock') {
    await lockCommand(lock, owner, command)
    return 0
  }
  return withLock(lock, owner, `pnpm e2e ${command.name}`, async () => {
    const path = statePath(owner)
    const state = await loadState(path)
    const cdp = await Cdp.connect(cdpPort())
    try {
      return await browserCommand(new Browser(cdp), state, command, () => saveState(path, state))
    } finally {
      await saveState(path, state)
      cdp.close()
    }
  })
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    if (err instanceof UsageError) console.error(`\n${USAGE}`)
    process.exit(err instanceof UsageError ? 2 : err instanceof E2eError ? err.exitCode : 1)
  },
)
