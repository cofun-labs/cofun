// Chrome APIs and tab DOM used at the extension boundary.
const globals = globalThis as Record<string, unknown>
const saved = { chrome: globals.chrome, fetch: globals.fetch }

/** Puts back the globals a FakeTab replaced. Call it after each test. */
export function restoreGlobals(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globals[key]
    else globals[key] = value
  }
}

/** A context menu item, as the extension made or updated it. */
interface MenuItem {
  title?: string
  contexts?: string[]
  documentUrlPatterns?: string[]
  visible?: boolean
}

type StorageListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void

/**
 * Stands in for chrome.storage: the `local` and `session` areas, and the change events every document
 * of the extension gets, the one that made the change included. `restart` empties `session`, as a
 * browser restart does.
 */
class FakeStorage {
  /** The browser restarts: what the session area held is gone. */
  restart(): void {
    for (const key of Object.keys(this.sessionValues)) delete this.sessionValues[key]
  }

  /** What `local` holds. */
  values: Record<string, unknown> = {}
  /** What `session` holds: what Chrome keeps until the browser closes. */
  sessionValues: Record<string, unknown> = {}
  /** What `sync` holds: what Chrome sync takes to the user's other devices. */
  syncValues: Record<string, unknown> = {}
  private listeners: StorageListener[] = []

  local = this.area(this.values, 'local')
  session = this.area(this.sessionValues, 'session')
  sync = this.area(this.syncValues, 'sync')

  private area(values: Record<string, unknown>, name: string) {
    const change = (changes: Parameters<StorageListener>[0]) => {
      for (const listener of this.listeners) listener(changes, name)
    }
    return {
      // `null` gets all of it.
      get: async (key: string | null) =>
        key === null ? structuredClone(values) : key in values ? { [key]: values[key] } : {},
      set: async (items: Record<string, unknown>) => {
        const changes: Parameters<StorageListener>[0] = {}
        for (const [key, newValue] of Object.entries(items)) {
          // Chrome hands each document a copy, as it stores one.
          changes[key] = { oldValue: values[key], newValue: structuredClone(newValue) }
          values[key] = newValue
        }
        change(changes)
      },
      remove: async (key: string) => {
        if (!(key in values)) return
        const oldValue = values[key]
        delete values[key]
        change({ [key]: { oldValue } })
      },
    }
  }

  onChanged = {
    addListener: (listener: StorageListener) => void this.listeners.push(listener),
    removeListener: (listener: StorageListener) => void (this.listeners = this.listeners.filter((l) => l !== listener)),
  }
}

/** An active tab and its neighboring tabs. Injected scripts run against each tab's own DOM. */
export class FakeTab {
  injections: { tabId: number; world?: string }[] = []
  pageUrl?: string
  closed = false
  injectionError?: string
  dom?: object
  title = 'Fixture page'

  /**
   * The sites the user allowed the extension to read (optional host permissions), as match
   * patterns such as `https://example.com/*`.
   */
  allowed = new Set<string>()

  /** What the user answers in Chrome's own prompt when the extension asks to read a site. */
  promptAnswer = true

  /** While set, Chrome's prompt stays open: the user answers it once this resolves. */
  promptOpen?: Promise<void>

  /** The sites the extension asked Chrome to let it read, each request as its match patterns. */
  accessRequests: string[][] = []

  /**
   * The browser's other tabs, as chrome.tabs reports them, with ids from 20 on: in the side panel's
   * window unless `windowId` says another (2), each with the page's DOM for scripts that read it.
   */
  otherTabs: { url: string; title: string; windowId?: number; dom?: object; closed?: boolean }[] = []

  /** The text selected in the page, as the page's getSelection gives it. */
  selected = ''

  /**
   * activeTab: the extension may run scripts in the tab, whatever its site, until it goes to another
   * page. A click on one of the extension's menu items grants it.
   */
  private activeTab = false

  /** The extension's context menu items, by id, as it made them. */
  menuItems = new Map<string, MenuItem>()

  /** The windows Chrome opened the side panel in, in order. */
  panelOpens: number[] = []

  /** Set while Chrome hands the service worker a user's click (see `pickMenuItem`). */
  private gesture = false

  private installed: (() => void)[] = []
  private menuClicks: ((info: object, tab: object) => void)[] = []

  /** Chrome installs the extension: its service worker hears of it (runtime.onInstalled). */
  extensionInstalled(): void {
    for (const listener of this.installed) listener()
  }

  /**
   * The user selects `text` in the page (in the frame `frameId`, 0 the top one), right-clicks it, and
   * picks the extension's menu item `id`. Chrome gives the extension the tab (activeTab) and tells its
   * service worker, with its own copy of the selection, on one line.
   */
  pickMenuItem(id: string, text: string, frameId = 0): void {
    // Chrome shows only the items that are visible.
    if (this.menuItems.get(id)?.visible === false || !this.menuItems.has(id)) throw new Error(`no menu item ${id}`)
    this.selected = text
    this.activeTab = true
    const info = { menuItemId: id, selectionText: text.replace(/\s+/g, ' ').trim(), pageUrl: this.url, frameId }
    this.gesture = true
    try {
      for (const listener of this.menuClicks) listener(info, { id: 7, windowId: 1, url: this.url, title: this.title })
    } finally {
      this.gesture = false
    }
  }

  /** Scripts running in the tab, each until it returns. */
  private running = new Set<Promise<unknown>>()

  /**
   * Resolves once no script runs in the tab: every script has returned. A test
   * that moves a fake clock waits for this first, so the next timer is never one that only a
   * request still in flight would have cleared.
   */
  async answered(): Promise<void> {
    while (this.running.size) await Promise.allSettled(this.running)
  }

  constructor(public url: string | undefined) {}

  /** The browser's chrome.storage, which all its side panels share. */
  storage = new FakeStorage()

  private activated: ((info: { tabId: number; windowId: number }) => void)[] = []
  private updated: ((tabId: number, change: { url?: string; title?: string }, tab: object) => void)[] = []
  private replaced: ((added: number, removed: number) => void)[] = []

  /** Chrome swaps in a prerendered tab showing `url` for the current one, as it can on a navigation. */
  replaceTab(url: string, title = ''): void {
    this.url = url
    this.title = title
    for (const listener of this.replaced) listener(8, 7)
  }

  /** The user switches to another tab, showing `url`; Chrome tells the side panel. */
  switchTab(url: string | undefined, title = ''): void {
    this.activeTab = false
    this.url = url
    this.title = title
    for (const listener of this.activated) listener({ tabId: 7, windowId: 1 })
  }

  /** The tab goes to `url` (or renames its page, given the same URL); Chrome tells the side panel. */
  navigate(url: string, title = this.title): void {
    const change = { ...(url !== this.url && { url }), ...(title !== this.title && { title }) }
    if (url !== this.url) this.activeTab = false
    this.url = url
    this.title = title
    for (const listener of this.updated) listener(7, change, { id: 7, active: true, url, title })
  }

  install(): this {
    globals.chrome = {
      storage: this.storage,
      tabs: {
        query: async (info: { active?: boolean; currentWindow?: boolean; url?: string[] } = {}) => {
          const current =
            this.url === undefined ? [] : [{ id: 7, windowId: 1, url: this.url, title: this.title, active: true }]
          if (info.active) return current
          const others = this.otherTabs.flatMap(({ url, title, windowId = 1, closed }, i) =>
            closed ? [] : [{ id: 20 + i, url, title, windowId, active: false }],
          )
          const all = [...current, ...others].filter((tab) => !info.currentWindow || tab.windowId === 1)
          // Match patterns as the extension uses them: `https://<host>/*`.
          const hosts = info.url?.map((pattern) => /^https:\/\/([^/]+)\/\*$/.exec(pattern)?.[1])
          // Like Chrome, a tab that doesn't match is not reported at all: no URL or title of it.
          return hosts ? all.filter((tab) => hosts.includes(new URL(tab.url).hostname)) : all
        },
        onActivated: listeners(this.activated),
        onUpdated: listeners(this.updated),
        onReplaced: listeners(this.replaced),
        get: async (tabId: number) => {
          const other = this.otherTabs[tabId - 20]
          if (tabId === 7 ? this.closed : !other || other.closed) throw new Error(`No tab with id: ${tabId}.`)
          return tabId === 7 ? { id: tabId, url: this.pageUrl ?? this.url } : { id: tabId, ...other }
        },
        // With no tab id, Chrome updates the current window's active tab: this one. Given another
        // tab's id, it makes that tab the active one.
        update: async (...args: [{ url: string }] | [number, { active: true }]) => {
          if (args.length === 1) return this.navigate(args[0].url, '')
          const other = this.otherTabs[args[0] - 20]
          if (!other || other.closed) throw new Error(`No tab with id: ${args[0]}.`)
          this.switchTab(other.url, other.title)
        },
      },
      permissions: {
        contains: async ({ origins }: { origins: string[] }) => origins.every((o) => this.allowed.has(o)),
        // Like Chrome, only in a user's click or key press, while it is being handled; then the user
        // answers its prompt.
        request: async ({ origins }: { origins: string[] }) => {
          const type = (globalThis as { event?: Event }).event?.type
          if (type !== 'click' && type !== 'keydown')
            throw new Error('This function must be called during a user gesture')
          this.accessRequests.push(origins)
          await this.promptOpen
          if (this.promptAnswer) for (const o of origins) this.allowed.add(o)
          return this.promptAnswer
        },
      },
      windows: { getCurrent: async () => ({ id: 1 }), update: async () => ({ id: 1 }) },
      runtime: { onInstalled: listeners(this.installed), onStartup: listeners([]) },
      contextMenus: {
        removeAll: (done?: () => void) => {
          this.menuItems.clear()
          done?.()
        },
        create: ({ id, ...item }: MenuItem & { id: string }) => {
          if (this.menuItems.has(id)) throw new Error(`Cannot create item with duplicate id ${id}`)
          this.menuItems.set(id, item)
        },
        update: async (id: string, change: MenuItem) => {
          const item = this.menuItems.get(id)
          if (!item) throw new Error(`Cannot find menu item with id ${id}`)
          this.menuItems.set(id, { ...item, ...change })
        },
        onClicked: listeners(this.menuClicks),
      },
      sidePanel: {
        setPanelBehavior: async () => {},
        // Like Chrome, only while a user's click is being handled.
        open: async ({ windowId }: { windowId: number }) => {
          if (!this.gesture) throw new Error('`sidePanel.open()` may only be called in response to a user gesture.')
          this.panelOpens.push(windowId)
        },
      },
      scripting: {
        executeScript: (injection: {
          target: { tabId: number; frameIds?: number[] }
          world?: string
          func: Function
          args?: unknown[]
        }) => {
          const running = this.executeScript(injection)
          this.running.add(running)
          running.then(
            () => this.running.delete(running),
            () => this.running.delete(running),
          )
          return running
        },
      },
    }
    return this
  }

  /** Runs an injected script the way Chrome does (see the class). */
  private async executeScript({
    target,
    world,
    func,
    args,
  }: {
    target: { tabId: number; frameIds?: number[] }
    world?: string
    func: Function
    args?: unknown[]
  }) {
    // Another tab shows only a page on another site, read by its DOM.
    const other = target.tabId === 7 ? undefined : this.otherTabs[target.tabId - 20]
    if ((target.tabId !== 7 && (!other || other.closed)) || (!other && this.closed))
      throw new Error(`No tab with id: ${target.tabId}.`)
    if (this.injectionError) throw new Error(this.injectionError)
    // Chrome runs scripts only on a site the extension may access. activeTab reaches the tab's own
    // site only: in this fake, every frame but the top one is from another site.
    const at = new URL(other?.url ?? this.pageUrl ?? this.url!)
    const frame = target.frameIds?.[0] ?? 0
    const active = !other && this.activeTab
    if (frame !== 0 || (!this.allowed.has(`${at.origin}/*`) && !active))
      throw new Error(
        'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
      )
    this.injections.push({ tabId: target.tabId, world })
    const location = at
    // The page's selection, unless the test gave the page a DOM of its own that has one.
    const selected = () => ({ toString: () => (other ? '' : this.selected) })
    const document = Object.assign({ getSelection: selected }, (other ? other.dom : this.dom) ?? {})
    const rebuilt = new Function('location', 'document', `return (${func.toString()})`)(location, document) as Function
    return [{ frameId: frame, result: await rebuilt(...(asChromeSends(args ?? []) as unknown[])) }]
  }
}

/** A chrome.events.Event that keeps its listeners in `list`. */
function listeners<L>(list: L[]) {
  return {
    addListener: (listener: L) => void list.push(listener),
    removeListener: (listener: L) => {
      const i = list.indexOf(listener)
      if (i >= 0) list.splice(i, 1)
    },
  }
}

/**
 * Script arguments as Chrome hands them to the page: copied, with object keys whose value is null
 * left out (Chrome's conversion of extension API arguments strips them).
 */
function asChromeSends(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(asChromeSends)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).flatMap(([k, v]) => (v === null ? [] : [[k, asChromeSends(v)]])))
  return value
}

export const PAGE_URL = 'https://www.example.com/fixture-page'

export function pageTab(url = PAGE_URL) {
  return new FakeTab(url).install()
}

/**
 * The DOM of a page on another site, as far as the script that reads a tab uses it: its title, its
 * type, and a real document (jsdom's, with no layout, so nothing is hidden by style) whose body holds
 * `html`, or `main` in a `main` element, at `url`, and as many frames as asked.
 */
export function webPage({
  title,
  main,
  html = main === undefined ? '' : `<main>${main}</main>`,
  contentType = 'text/html',
  frames = 0,
  url = 'https://news.example.com/',
}: {
  title: string
  main?: string
  html?: string
  contentType?: string
  frames?: number
  url?: string
}): object {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><head><base href="${url}"></head><body>${html}${'<iframe></iframe>'.repeat(frames)}</body>`,
    'text/html',
  )
  return {
    title,
    contentType,
    body: doc.body,
    baseURI: doc.baseURI,
    querySelector: (selector: string) => doc.querySelector(selector),
    querySelectorAll: (selector: string) => doc.querySelectorAll(selector),
  }
}
