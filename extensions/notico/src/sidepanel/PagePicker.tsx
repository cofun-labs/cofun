import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { QuestionPage } from '../agent'
import { LIMITED_STOP, NotionError } from '../notion/api'
import { pageIdFromUrl } from '../notion/hosts'
import { findPages, openNotionPages, type FoundPage } from '../tools'
import { Icon } from './icons'
import { useMenu } from './menu'
import { PageIcon, titleOf } from './Pages'

/** Which page a URL shows: its id, or the URL when it has none (say, Notion's home). */
export const pageKey = (page: { url: string }): string => pageIdFromUrl(page.url) ?? page.url

/** How long typing must pause before the workspace is searched. */
const SEARCH_DELAY_MS = 300
/** Typed characters a workspace search needs. */
const SEARCH_MIN = 2
/** Results a workspace search shows. */
const SEARCH_LIMIT = 8
/** Recent pages shown at most. */
const RECENT_MAX = 5

/**
 * Why the workspace is not searched again for this question: Notion turned a search away (`busy`),
 * or one failed in a way the panel doesn't work around.
 */
export type SearchStop = { busy: true } | { busy: false; message: string }

type Group = 'This page' | 'Open tabs' | 'Recent' | 'Workspace'

interface Option {
  key: string
  group: Group
  page: FoundPage
  /** The question carries this page already. */
  added: boolean
}

type Search =
  /** Too little is typed, or the workspace is not searched for this question. */
  | { status: 'off' }
  /** No Notion page is open: there is no workspace to search. */
  | { status: 'no-page' }
  | { status: 'waiting' }
  | { status: 'searching' }
  | { status: 'done'; pages: FoundPage[] }

export interface PickerOptions {
  open: boolean
  /** What the pages are filtered by: what follows the `@`, or what is typed in the picker's own field. */
  query: string
  /** Set when the picker has its own search field (opened from "+"); it changes the query. */
  onQuery?: (query: string) => void
  /** The Notion page open in the current tab, when it shows one. */
  thisPage?: QuestionPage
  /** The pages the question carries, by `pageKey`. */
  added: Set<string>
  /** Pages recent chats went with, newest first; read from the device when the picker opens. */
  recent: () => Promise<QuestionPage[]>
  /** Set once the workspace is not searched again for this question. */
  stop?: SearchStop
  /**
   * A question is being answered: the workspace is not searched meanwhile, so the picker never
   * asks Notion for anything while the agent does.
   */
  paused?: boolean
  /**
   * Called with the `onStop` given when the failed search was sent; false when that question was
   * sent meanwhile, so the failure stops nothing.
   */
  onStop: (stop: SearchStop) => boolean
  onPick: (page: QuestionPage) => void
  /** Escape, or Tab: the picker closes, and what was typed stays as text. */
  onClose: () => void
}

/**
 * The page picker the composer opens with `@` or "+": the page open in the tab, the other Notion
 * pages open in tabs, and recent pages, all without a Notion request; and, once at least two
 * characters are typed and typing pauses, Notion's search of the workspace. One search at a time:
 * a newer query replaces one still waiting before it is sent, and waits for one already sent, so
 * none run side by side. Nothing is retried: a search Notion turns away, or one that fails, stops
 * the search for the rest of the question, and the other groups stay usable.
 *
 * Returns the picker to render, the key handler for the field the user types in (true when it
 * handled the key), the id of the option the keys move to, and whether a page's title may hold the query.
 */
export function usePagePicker({
  open,
  query,
  onQuery,
  thisPage,
  added,
  recent,
  stop,
  paused = false,
  onStop,
  onPick,
  onClose,
}: PickerOptions): {
  element: ReactNode
  onKeyDown: (e: KeyboardEvent) => boolean
  activeId?: string
  /**
   * Resolves once no search is out, with what the user is told when Notion turned that one away: a
   * question sent meanwhile waits for it, so the two never ask Notion at once, and stops with it.
   */
  settled: () => Promise<string | undefined>
  /**
   * Some page's title may hold the query: one listed does, or the pages in the browser or the
   * workspace search are still to come.
   */
  titleMatch: boolean
} {
  const id = useId()
  const [local, setLocal] = useState<{ tabs: QuestionPage[]; recent: QuestionPage[] }>()
  const [search, setSearch] = useState<Search>({ status: 'off' })
  const [active, setActive] = useState(0)
  const onStopRef = useRef(onStop)
  onStopRef.current = onStop
  // The query the next search sends, if one should; cleared when no search is wanted any more.
  const wanted = useRef<string>(undefined)
  const running = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // The search that is out, if one is: resolves with whether Notion turned it away.
  const out = useRef<Promise<string | undefined>>(undefined)

  // The pages already in the browser, read each time the picker opens: no Notion request.
  useEffect(() => {
    if (!open) return setLocal(undefined)
    let live = true
    void Promise.all([
      openNotionPages().catch(() => []),
      recent().catch((err: unknown) => {
        console.error('Could not read the recent pages', err)
        return []
      }),
    ]).then(([tabs, pages]) => live && setLocal({ tabs, recent: pages }))
    return () => void (live = false)
  }, [open])

  const words = query.trim()
  const searchable = !!thisPage && pageIdFromUrl(thisPage.url) !== undefined
  const longEnough = Array.from(words).length >= SEARCH_MIN
  const wantsSearch = open && !stop && !paused && longEnough

  async function run() {
    const sending = wanted.current
    if (sending === undefined) return
    // One at a time: the search running sends the newest query when it ends. Until then, this query
    // is being searched for, as far as the user is concerned.
    if (running.current) return setSearch({ status: 'searching' })
    running.current = true
    // A failure stops searching for the question this search was sent for, not the one after it.
    const stopSearch = onStopRef.current
    setSearch({ status: 'searching' })
    let turnedAway!: (stopsQuestion: string | undefined) => void
    out.current = new Promise<string | undefined>((resolve) => (turnedAway = resolve))
    let stopsQuestion: string | undefined
    try {
      const pages = await findPages(sending, SEARCH_LIMIT)
      if (wanted.current === sending) setSearch({ status: 'done', pages })
    } catch (err) {
      const limited = err instanceof NotionError && err.code === 'rate_limited'
      // A failure that stops a question stops the one waiting for this search too: Notion turning
      // it away, or a failure nobody understands (see NotionError.stopsQuestion).
      if (err instanceof NotionError && err.stopsQuestion) stopsQuestion = err.stopsQuestion
      else if (limited) stopsQuestion = LIMITED_STOP
      // Never retried, nor worked around: no more searches for this question. A failure that comes
      // after its question was sent leaves the next question's query to go on.
      const stopped = stopSearch(
        limited ? { busy: true } : { busy: false, message: err instanceof Error ? err.message : String(err) },
      )
      if (stopped || wanted.current === sending) wanted.current = undefined
    } finally {
      running.current = false
      out.current = undefined
      turnedAway(stopsQuestion)
    }
    // A newer query waited for this search; if its pause is over too, it goes now.
    if (wanted.current !== undefined && wanted.current !== sending && timer.current === undefined) void run()
  }

  useEffect(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    if (!wantsSearch || !searchable) {
      wanted.current = undefined
      setSearch({ status: wantsSearch ? 'no-page' : 'off' })
      return
    }
    wanted.current = words
    setSearch({ status: 'waiting' })
    timer.current = setTimeout(() => {
      timer.current = undefined
      void run()
    }, SEARCH_DELAY_MS)
  }, [wantsSearch, searchable, words])

  // A panel that goes away sends nothing more, and takes no answer.
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      wanted.current = undefined
    },
    [],
  )

  const lower = words.toLowerCase()
  const matches = (page: QuestionPage) => titleOf(page).toLowerCase().includes(lower)
  const options: Option[] = []
  const seen = new Set<string>()
  const add = (group: Group, page: FoundPage) => {
    const key = pageKey(page)
    if (seen.has(key)) return
    seen.add(key)
    options.push({ key, group, page, added: added.has(key) })
  }
  if (thisPage && searchable && matches(thisPage)) add('This page', thisPage)
  for (const page of local?.tabs ?? []) if (matches(page)) add('Open tabs', page)
  let recents = 0
  for (const page of local?.recent ?? []) {
    if (recents === RECENT_MAX || !matches(page) || seen.has(pageKey(page))) continue
    add('Recent', page)
    recents++
  }
  // Notion's search matched the content too, so its pages are not filtered by title, unless words
  // after an `@` go past a space: those may be the message going on, which a page's content can
  // match. The "+" picker's own field searches any words.
  const spaced = !onQuery && /\s/.test(words)
  if (search.status === 'done') for (const page of search.pages) if (!spaced || matches(page)) add('Workspace', page)

  // The keys move from the first option again whenever the options change.
  const optionKeys = options.map((o) => o.key).join(' ')
  useEffect(() => setActive(0), [optionKeys])
  const current = options.length ? Math.min(active, options.length - 1) : -1
  const optionId = (i: number) => `${id}-option-${i}`

  function onKeyDown(e: KeyboardEvent): boolean {
    if (!open) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (options.length) setActive((current + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
      return true
    }
    // Enter adds the highlighted page. With none listed, after an `@` the words were the message
    // going on: the picker closes and Enter sends the message as typed. In the picker's own search
    // field it does nothing, and never submits the message.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (current >= 0) {
        e.preventDefault()
        onPick(options[current].page)
        return true
      }
      if (onQuery) {
        e.preventDefault()
        return true
      }
      onClose()
      return false
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return true
    }
    if (e.key === 'Tab') onClose()
    return false
  }

  const settled = () => out.current ?? Promise.resolve(undefined)

  if (!open) return { element: null, onKeyDown, settled, titleMatch: true }

  const groups = (['This page', 'Open tabs', 'Recent', 'Workspace'] as const).flatMap((group) => {
    const rows = options.flatMap((o, i) => (o.group === group ? [{ o, i }] : []))
    return rows.length ? [{ group, rows }] : []
  })
  const state = stateLine(search, stop, paused && longEnough, words, options.length > 0, !!local)

  const element = (
    <div className="page-picker">
      {onQuery && (
        <input
          type="search"
          className="picker-search"
          aria-label="Search pages"
          placeholder="Search pages…"
          aria-controls={`${id}-list`}
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          value={query}
          autoFocus
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => void onKeyDown(e)}
        />
      )}
      <div className="picker-list">
        {groups.length > 0 && (
          <div id={`${id}-list`} role="listbox" aria-label="Pages">
            {groups.map(({ group, rows }) => (
              <div key={group} role="group" aria-label={group}>
                <div className="picker-group" aria-hidden="true">
                  {group}
                </div>
                {rows.map(({ o, i }) => (
                  <div
                    key={o.key}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === current}
                    className={i === current ? 'picker-option active' : 'picker-option'}
                    // Keeps the focus in the field the user types in.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => i !== current && setActive(i)}
                    onClick={() => onPick(o.page)}
                  >
                    <PageIcon page={o.page} />
                    <span className="picker-lines">
                      <span className="picker-name">{marked(titleOf(o.page), words)}</span>
                      {o.page.path && <span className="picker-path">{o.page.path}</span>}
                    </span>
                    {o.added && <span className="picker-hint">Added</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {state && (
          <p className="picker-state" role="status">
            {search.status === 'searching' && <span className="spinner" aria-hidden="true" />}
            {state}
          </p>
        )}
      </div>
      <div className="picker-foot" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> to choose
        </span>
        <span>
          <kbd>Enter</kbd> to add
        </span>
        <span>
          <kbd>Esc</kbd> to close
        </span>
      </div>
    </div>
  )
  return {
    element,
    onKeyDown,
    settled,
    activeId: current >= 0 ? optionId(current) : undefined,
    titleMatch:
      !local || search.status === 'waiting' || search.status === 'searching' || options.some((o) => matches(o.page)),
  }
}

/** What the picker says under its pages: how the workspace search stands, or that nothing matches. */
function stateLine(
  search: Search,
  stop: SearchStop | undefined,
  paused: boolean,
  words: string,
  any: boolean,
  loaded: boolean,
): string | undefined {
  if (stop?.busy) return 'Notion is busy, so your workspace isn’t searched for this question. Try again in a moment.'
  if (stop) return `Couldn’t search your workspace: ${stop.message}`
  if (paused) return 'Your workspace is searched once the answer is done.'
  if (search.status === 'waiting') return 'Searches your workspace when you stop typing.'
  if (search.status === 'searching') return 'Searching your workspace…'
  if (search.status === 'no-page' && !any) return 'Open a Notion page to search its workspace.'
  if (any || !loaded) return undefined
  return words ? `No pages match “${words}”.` : 'Type to search your workspace.'
}

/** `title` with the first match of `words` in bold. */
function marked(title: string, words: string): ReactNode {
  const at = words ? title.toLowerCase().indexOf(words.toLowerCase()) : -1
  if (at < 0) return title
  return (
    <>
      {title.slice(0, at)}
      <mark>{title.slice(at, at + words.length)}</mark>
      {title.slice(at + words.length)}
    </>
  )
}

/** The "+" button on the left of the composer's toolbar, and its menu. */
export function AddMenu({ onAddPage }: { onAddPage: () => void }) {
  const { open, setOpen, rootRef, menuRef, onKeyDown } = useMenu()
  return (
    <div className="add-menu" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="tool-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add a page"
        title="Add a page"
        onClick={() => setOpen(!open)}
      >
        <Icon name="plus" />
      </button>
      {open && (
        <div ref={menuRef} className="add-popover" role="menu" aria-label="Add">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              setOpen(false)
              onAddPage()
            }}
          >
            <Icon name="page" />
            Add a page…
          </button>
        </div>
      )}
    </div>
  )
}
