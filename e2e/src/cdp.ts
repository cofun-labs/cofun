// A small Chrome DevTools Protocol client: one WebSocket to the browser, with a flat session per
// target. No chrome.debugger and no extension of our own: Canary was started with a debugging port.

export const DEFAULT_PORT = 9228
/** How long Chrome may take to answer one request, so a wedged target can't hang a command (and hold the lock). */
export const REQUEST_TIMEOUT_MS = 60_000

export interface TargetInfo {
  targetId: string
  type: string
  url: string
  attached: boolean
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

export class CdpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdpError'
  }
}

export class Cdp {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (msg.id === undefined) return
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new CdpError(msg.error.message))
      else p.resolve(msg.result)
    })
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new CdpError('The connection to Chrome closed.'))
      this.pending.clear()
    })
  }

  static async connect(port = DEFAULT_PORT): Promise<Cdp> {
    let url: string
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      url = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl
    } catch {
      throw new CdpError(
        `Chrome Canary is not listening for DevTools on port ${port}. Start it with ` +
          `--remote-debugging-port=${port} as the maintainer's local setup describes; this tool doesn't launch it.`,
      )
    }
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new CdpError(`Could not connect to ${url}`)), { once: true })
    })
    return new Cdp(ws)
  }

  send<T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`Chrome did not answer ${method} within ${REQUEST_TIMEOUT_MS / 1000} s.`))
      }, REQUEST_TIMEOUT_MS)
      const settle =
        <V>(fn: (v: V) => void) =>
        (v: V) => {
          clearTimeout(timer)
          fn(v)
        }
      this.pending.set(id, { resolve: settle(resolve as (v: unknown) => void), reject: settle(reject) })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close(): void {
    this.ws.close()
  }
}

/** One target (tab, side panel, extension page) to run code in. */
export class Target {
  constructor(
    private readonly cdp: Cdp,
    readonly targetId: string,
    private readonly sessionId: string,
  ) {}

  /**
   * Runs `fn(...args)` in the target and returns its (awaited) result. `fn` is sent as source, so it
   * must not use anything from outside its body; `args` go as values, never as code. `userGesture`
   * makes it count as a user's click.
   */
  async evaluate<A extends unknown[], R>(
    fn: (...args: A) => R,
    args: A,
    options: { userGesture?: boolean; contextId?: number } = {},
  ): Promise<Awaited<R>> {
    // The function runs on the context's global object, which callFunctionOn needs a handle to.
    const global = await this.send<{ result: { objectId?: string } }>('Runtime.evaluate', {
      expression: 'globalThis',
      ...(options.contextId === undefined ? {} : { contextId: options.contextId }),
    })
    if (!global.result.objectId) throw new CdpError('Could not reach the page.')
    const res = await this.send<{
      result: { value?: unknown }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }>('Runtime.callFunctionOn', {
      // tsx (esbuild's keepNames) wraps named functions in a __name helper that the page lacks.
      functionDeclaration: `function (...args) { const __name = (f) => f; return (${fn.toString()})(...args) }`,
      objectId: global.result.objectId,
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
      userGesture: options.userGesture ?? false,
    })
    await this.send('Runtime.releaseObject', { objectId: global.result.objectId }).catch(() => undefined)
    if (res.exceptionDetails) {
      throw new CdpError(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    }
    return res.result.value as Awaited<R>
  }

  /** A JavaScript world of its own in the target's main frame, out of the page's reach. */
  async isolatedWorld(name: string): Promise<number> {
    const { frameTree } = await this.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree')
    const { executionContextId } = await this.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: name,
    })
    return executionContextId
  }

  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId)
  }
}

export class Browser {
  private readonly sessions = new Map<string, Target>()

  constructor(readonly cdp: Cdp) {}

  async targets(): Promise<TargetInfo[]> {
    const { targetInfos } = await this.cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets')
    return targetInfos
  }

  /** The open target with this id, as Chrome lists it, or undefined if it has closed. */
  async find(targetId: string | undefined): Promise<TargetInfo | undefined> {
    return targetId ? (await this.targets()).find((t) => t.targetId === targetId) : undefined
  }

  /** Opens a tab; `background` keeps the current tab of its window in front. */
  async open(url: string, { background = false } = {}): Promise<string> {
    const { targetId } = await this.cdp.send<{ targetId: string }>('Target.createTarget', { url, background })
    return targetId
  }

  async close(targetId: string): Promise<void> {
    this.sessions.delete(targetId)
    await this.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined)
  }

  async activate(targetId: string): Promise<void> {
    await this.cdp.send('Target.activateTarget', { targetId })
  }

  async attach(targetId: string): Promise<Target> {
    const known = this.sessions.get(targetId)
    if (known) return known
    const { sessionId } = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    const target = new Target(this.cdp, targetId, sessionId)
    this.sessions.set(targetId, target)
    return target
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Calls `check` until it returns something other than undefined, or throws `onTimeout()` after `ms`. */
export async function until<T>(
  check: () => Promise<T | undefined>,
  { ms, every = 250, onTimeout }: { ms: number; every?: number; onTimeout: () => Error },
): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await check().catch(() => undefined)
    if (value !== undefined) return value
    if (Date.now() > end) throw onTimeout()
    await sleep(every)
  }
}
