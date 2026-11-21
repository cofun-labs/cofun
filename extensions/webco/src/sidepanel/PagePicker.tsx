import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { QuestionPage } from '@cofun/agent'
import { openWebTabs, type WebTab } from '@cofun/tools'
import { allowSite } from '@cofun/tools/tab'
import { Icon } from './icons'
import { useMenu } from './menu'
import { PageIcon, titleOf } from './Pages'

/** A tab's identity in the picker. */
export const pageKey = (page: QuestionPage): string => `tab ${page.tab ?? page.url}`

interface Option {
  key: string
  page: QuestionPage
  added: boolean
}

interface PickerOptions {
  open: boolean
  query: string
  onQuery?: (query: string) => void
  added: Set<string>
  onPick: (page: QuestionPage) => void
  onClose: () => void
}

/** The open tabs the user can attach with @ or "+". */
export function usePagePicker({ open, query, onQuery, added, onPick, onClose }: PickerOptions): {
  element: ReactNode
  onKeyDown: (e: KeyboardEvent) => boolean
  activeId?: string
  titleMatch: boolean
} {
  const id = useId()
  const [local, setLocal] = useState<WebTab[]>()
  // A tab on another site whose site Chrome is asked to let Webco read, or was refused, by host.
  const [access, setAccess] = useState<{ host: string; asking: boolean }>()
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick
  const [active, setActive] = useState(0)

  useEffect(() => {
    setAccess(undefined)
    if (!open) return setLocal(undefined)
    let live = true
    void openWebTabs()
      .catch((err: unknown) => {
        console.error('Could not read the open tabs', err)
        return []
      })
      .then((tabs) => {
        if (live) setLocal(tabs)
      })
    return () => void (live = false)
  }, [open])

  /**
   * Adds a page; a tab on a site Webco may not read yet only once Chrome let it, asked in the
   * click or key press that picked it (Chrome takes the request only then), so nothing is awaited
   * before. A tab whose site the user refused is not added.
   */
  function pick(page: QuestionPage) {
    const tab = local?.find((t) => t.page.tab === page.tab)
    if (!tab || tab.allowed) return onPick(page)
    if (access?.asking) return
    const host = new URL(tab.origin).host
    setAccess({ host, asking: true })
    allowSite(tab.origin)
      .catch((err: unknown) => {
        console.error('Could not ask Chrome for access to the site', err)
        return false
      })
      .then((allowed) => {
        if (!allowed) return setAccess({ host, asking: false })
        setAccess(undefined)
        tab.allowed = true
        onPickRef.current(page)
      })
  }

  const words = query.trim()
  const lower = words.toLowerCase()
  const options: Option[] = (local ?? []).flatMap(({ page }) => {
    if (!titleOf(page).toLowerCase().includes(lower) && !hostOf(page).toLowerCase().includes(lower)) return []
    const key = pageKey(page)
    return [{ key, page, added: added.has(key) }]
  })

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
        pick(options[current].page)
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

  if (!open) return { element: null, onKeyDown, titleMatch: true }

  const state = access
    ? access.asking
      ? `Allow Webco to read ${access.host} in Chrome’s prompt to add its tab.`
      : `Webco may not read ${access.host}, so its tab wasn’t added.`
    : stateLine(words, options.length > 0, !!local)

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
        {options.length > 0 && (
          <div id={`${id}-list`} role="listbox" aria-label="Pages">
            {options.map((option, i) => (
              <div
                key={option.key}
                id={optionId(i)}
                role="option"
                aria-selected={i === current}
                className={i === current ? 'picker-option active' : 'picker-option'}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => i !== current && setActive(i)}
                onClick={() => pick(option.page)}
              >
                <PageIcon page={option.page} />
                <span className="picker-lines">
                  <span className="picker-name">{marked(titleOf(option.page), words)}</span>
                  <span className="picker-path">{hostOf(option.page)}</span>
                </span>
                {option.added && <span className="picker-hint">Added</span>}
              </div>
            ))}
          </div>
        )}
        {state && (
          <p className="picker-state" role="status">
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
    activeId: current >= 0 ? optionId(current) : undefined,
    titleMatch: !local || options.length > 0,
  }
}

function stateLine(words: string, any: boolean, loaded: boolean): string | undefined {
  if (any || !loaded) return undefined
  return words ? `No tabs match “${words}”.` : 'Open a tab to add it here.'
}

/** The site of a tab, as the picker shows it under its title. */
const hostOf = (page: QuestionPage) => new URL(page.url).host

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
        aria-label="Add a page or tab"
        data-tip="Add a page or tab"
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
            Add a page or tab…
          </button>
        </div>
      )}
    </div>
  )
}
