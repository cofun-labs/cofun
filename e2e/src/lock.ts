// The lock on the one shared Chrome Canary. Same directory and format as the maintainer's
// canary-lock.sh, so sessions using either can share the browser: `mkdir` is the lock, an `owner`
// file inside says who holds it ("<owner> | <purpose> | since <time>"), and a lock not refreshed for
// 30 minutes counts as abandoned.
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LOCK_DIR = join(homedir(), '.cache', 'notion-copilot', 'canary.lock')
export const STALE_MS = 30 * 60_000

export type Acquired =
  /** Taken now; `tookOver` names the holder of the stale lock it replaced. */
  | { status: 'acquired'; tookOver?: string }
  /** Already held by this owner, for example across several steps. */
  | { status: 'held' }
  | { status: 'busy'; holder: string }

export class CanaryLock {
  constructor(
    readonly dir = LOCK_DIR,
    private readonly now = () => new Date(),
  ) {}

  /** Who holds the lock ("<owner> | <purpose> | since <time>"), or undefined when it is free. */
  async holder(): Promise<string | undefined> {
    if (!(await this.exists())) return undefined
    const text = await readFile(join(this.dir, 'owner'), 'utf8').catch(() => '')
    return text.trim() || '(unknown holder)'
  }

  async acquire(owner: string, purpose: string): Promise<Acquired> {
    checkOwner(owner)
    let tookOver: string | undefined
    const modified = await stat(this.dir).then(
      (s) => s.mtime.getTime(),
      () => undefined,
    )
    if (modified !== undefined) {
      if (await this.isOwner(owner)) {
        await this.touch()
        return { status: 'held' }
      }
      if (this.isStale(modified)) {
        tookOver = await this.takeOver()
      }
    }
    await mkdir(join(this.dir, '..'), { recursive: true })
    try {
      await mkdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      return { status: 'busy', holder: (await this.holder()) ?? '(unknown holder)' }
    }
    await writeFile(join(this.dir, 'owner'), `${owner} | ${oneLine(purpose)} | since ${stamp(this.now())}\n`)
    return { status: 'acquired', tookOver }
  }

  /**
   * Moves a stale lock out of the way and returns its holder. The rename is atomic, so of several
   * sessions taking over the same stale lock, one moves it and the others find it gone and race for
   * mkdir instead.
   */
  private async takeOver(): Promise<string | undefined> {
    const moved = `${this.dir}.stale-${process.pid}-${Date.now()}`
    try {
      await rename(this.dir, moved)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
    const holder = (await readFile(join(moved, 'owner'), 'utf8').catch(() => '')).trim() || '(unknown holder)'
    await rm(moved, { recursive: true, force: true })
    return holder
  }

  private isStale(modified: number): boolean {
    return this.now().getTime() - modified > STALE_MS
  }

  /** Marks the lock as still in use; false if this owner doesn't hold it. */
  async refresh(owner: string): Promise<boolean> {
    if (!(await this.isOwner(owner))) return false
    await this.touch()
    return true
  }

  /** Frees the lock; false if this owner doesn't hold it. */
  async release(owner: string): Promise<boolean> {
    if (!(await this.isOwner(owner))) return false
    await rm(this.dir, { recursive: true, force: true })
    return true
  }

  async isOwner(owner: string): Promise<boolean> {
    return (await this.holder())?.startsWith(`${owner} |`) ?? false
  }

  private async exists(): Promise<boolean> {
    return stat(this.dir).then(
      (s) => s.isDirectory(),
      () => false,
    )
  }

  private async touch(): Promise<void> {
    const now = this.now()
    await utimes(this.dir, now, now)
  }
}

/** Owners are matched as the text before the first " |", like the shell script does. */
export function checkOwner(owner: string): void {
  if (!owner.trim() || /[|\n\r]/.test(owner)) throw new Error(`Not a usable lock owner: ${JSON.stringify(owner)}`)
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n|][\s\r\n|]*/g, ' ').trim()
}

/** Local time as the shell script writes it: 2026-11-10 08:11. */
export function stamp(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
