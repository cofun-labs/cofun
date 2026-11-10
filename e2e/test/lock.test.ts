import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CanaryLock, STALE_MS, checkOwner } from '../src/lock'

let root: string
let dir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'e2e-lock-'))
  dir = join(root, 'canary.lock')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const at = (iso: string) => () => new Date(iso)

describe('CanaryLock', () => {
  it('takes a free lock and writes the owner line the shell script writes', async () => {
    const lock = new CanaryLock(dir, at('2026-11-10T08:11:00'))
    expect(await lock.holder()).toBeUndefined()
    expect(await lock.acquire('issue-106', 'UC-NOTION-007-S04')).toEqual({ status: 'acquired' })
    expect(await readFile(join(dir, 'owner'), 'utf8')).toBe('issue-106 | UC-NOTION-007-S04 | since 2026-11-10 08:11\n')
    expect(await lock.holder()).toBe('issue-106 | UC-NOTION-007-S04 | since 2026-11-10 08:11')
  })

  it('reports a lock held by someone else as busy, and leaves it alone', async () => {
    const other = new CanaryLock(dir)
    await other.acquire('issue-96', 'e2e')
    const lock = new CanaryLock(dir)
    expect(await lock.acquire('issue-106', 'e2e')).toEqual({
      status: 'busy',
      holder: expect.stringMatching(/^issue-96 \| e2e \| since /),
    })
    expect(await lock.release('issue-106')).toBe(false)
    expect(await lock.refresh('issue-106')).toBe(false)
    expect(await lock.holder()).toMatch(/^issue-96 \|/)
  })

  it('does not take an owner whose name is a prefix of the holder', async () => {
    await new CanaryLock(dir).acquire('issue-106-b', 'e2e')
    expect(await new CanaryLock(dir).acquire('issue-106', 'e2e')).toMatchObject({ status: 'busy' })
  })

  it('counts a lock its owner already holds as held, and refreshes it', async () => {
    const lock = new CanaryLock(dir)
    await lock.acquire('issue-106', 'several steps')
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(dir, old, old)
    expect(await lock.acquire('issue-106', 'pnpm e2e ask')).toEqual({ status: 'held' })
    expect((await stat(dir)).mtime.getTime()).toBeGreaterThan(old.getTime())
    // The first purpose stays: the lock wasn't taken again.
    expect(await lock.holder()).toMatch(/^issue-106 \| several steps \|/)
  })

  it('takes over a lock not refreshed for 30 minutes', async () => {
    await new CanaryLock(dir).acquire('issue-96', 'forgotten')
    const old = new Date(Date.now() - STALE_MS - 60_000)
    await utimes(dir, old, old)
    const r = await new CanaryLock(dir).acquire('issue-106', 'e2e')
    expect(r).toEqual({ status: 'acquired', tookOver: expect.stringMatching(/^issue-96 \| forgotten/) })
    expect(await new CanaryLock(dir).holder()).toMatch(/^issue-106 \|/)
  })

  it('releases only its own lock', async () => {
    const lock = new CanaryLock(dir)
    await lock.acquire('issue-106', 'e2e')
    expect(await lock.release('issue-106')).toBe(true)
    expect(await lock.holder()).toBeUndefined()
    expect(await lock.release('issue-106')).toBe(false)
  })

  it('keeps purposes on one line, so the owner file stays parseable', async () => {
    await new CanaryLock(dir, at('2026-11-10T08:11:00')).acquire('issue-106', 'a | b\nc')
    expect(await readFile(join(dir, 'owner'), 'utf8')).toBe('issue-106 | a b c | since 2026-11-10 08:11\n')
  })

  it('reports a lock directory without an owner file as held', async () => {
    await mkdir(dir)
    expect(await new CanaryLock(dir).holder()).toBe('(unknown holder)')
  })
})

describe('the maintainer’s canary-lock.sh, when installed', () => {
  const script = join(process.env.HOME ?? '', '.cache', 'notion-copilot', 'canary-lock.sh')

  it.skipIf(!existsSync(script))('sees a lock this tool took, and the tool sees one the script took', async () => {
    // The script has its lock path built in; run a copy pointed at the test directory.
    const copy = join(root, 'canary-lock.sh')
    await writeFile(copy, (await readFile(script, 'utf8')).replace(/^LOCK=.*$/m, `LOCK="${dir}"`))
    const sh = (...args: string[]) => {
      try {
        return execFileSync('zsh', [copy, ...args], { encoding: 'utf8' }).trim()
      } catch (err) {
        return String((err as { stdout?: string }).stdout).trim()
      }
    }
    const lock = new CanaryLock(dir)
    await lock.acquire('issue-106', 'tool')
    expect(sh('acquire', 'issue-96', 'script')).toMatch(/^busy: issue-106 \| tool \| since \d{4}-\d\d-\d\d \d\d:\d\d$/)
    expect(sh('release', 'issue-106')).toBe('released')
    expect(sh('acquire', 'issue-96', 'script')).toBe('acquired')
    expect(await lock.acquire('issue-106', 'tool')).toMatchObject({ status: 'busy' })
    expect(await new CanaryLock(dir).release('issue-96')).toBe(true)
  })
})

describe('checkOwner', () => {
  it('refuses owners the owner file could not tell apart', () => {
    expect(() => checkOwner('issue-106')).not.toThrow()
    for (const bad of ['', '  ', 'a | b', 'a\nb']) expect(() => checkOwner(bad)).toThrow()
  })
})
