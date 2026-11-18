import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import type { ClipTarget } from '../clip'
import { pageIdFromUrl } from '../notion/hosts'
import {
  chooseTarget,
  clipPlace,
  DEFAULT_TARGET,
  defaultTarget,
  findTargets,
  makingDefault,
  type ClipPlace,
  type PageChoice,
} from '../tools/clip'
import { Icon } from './icons'

/** How long typing pauses before the workspace is searched: one search per pause, not per key. */
const SEARCH_DELAY_MS = 300

/** What Settings says about the last choice: done, or why not. */
export interface ClipNote {
  text: string
  failed?: boolean
}

type Option =
  | { kind: 'page'; page: PageChoice; group: string; detail?: string }
  | { kind: 'default'; group: string; detail: string }

/**
 * Where clips go, as a field that opens a picker like the message box's: a search of the workspace
 * of the Notion page in the current tab (Notion's quick find), which with nothing typed suggests
 * that page and the private page "Notico Clips" (made if the user has none).
 */
export function ClipInto({
  target,
  making,
  onNote,
}: {
  target?: ClipTarget
  /** "Notico Clips" is being found or made for the switch (see defaultTarget). */
  making: boolean
  onNote: (note: ClipNote | undefined) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [place, setPlace] = useState<ClipPlace | string>()
  const [found, setFound] = useState<{ query: string; pages: PageChoice[] | string }>()
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLButtonElement>(null)

  // The workspace is looked up as the picker opens: the current tab may have changed since.
  useEffect(() => {
    if (!open) return
    let closed = false
    setPlace(undefined)
    clipPlace().then(
      (found) => !closed && setPlace(found),
      (err: unknown) => !closed && setPlace(err instanceof Error ? err.message : String(err)),
    )
    return () => void (closed = true)
  }, [open])

  const words = query.trim()
  useEffect(() => {
    if (!open || !words || typeof place !== 'object') return
    let closed = false
    const timer = setTimeout(() => {
      findTargets(place, words).then(
        (pages) => !closed && setFound({ query: words, pages }),
        (err: unknown) =>
          !closed && setFound({ query: words, pages: err instanceof Error ? err.message : String(err) }),
      )
    }, SEARCH_DELAY_MS)
    return () => {
      closed = true
      clearTimeout(timer)
    }
  }, [open, words, place])

  const targetId = target && pageIdFromUrl(target.url)
  const options: Option[] = []
  let state: { text: string; loading?: boolean } | undefined
  // While "Notico Clips" is being found or made, nothing is offered: a page picked meanwhile would be
  // saved, then replaced by it once it is done.
  if (making || makingDefault())
    state = { text: `Looking for “${DEFAULT_TARGET}” in your Private section…`, loading: true }
  else if (typeof place === 'string') state = { text: place }
  else if (!place) state = { text: 'Looking for your Notion page…', loading: true }
  else if (words) {
    const result = found?.query === words ? found.pages : undefined
    if (result === undefined) state = { text: 'Searching…', loading: true }
    else if (typeof result === 'string') state = { text: result }
    else if (!result.length) state = { text: `No pages found for “${words}”.` }
    else for (const page of result) options.push({ kind: 'page', page, group: 'Pages' })
  } else {
    const current = place.current
    if (current && current.id !== targetId)
      options.push({ kind: 'page', page: current, group: 'Suggested', detail: 'Current page' })
    if (target?.title !== DEFAULT_TARGET) options.push({ kind: 'default', group: 'Suggested', detail: 'In Private' })
    if (!options.length) state = { text: 'Type to search your workspace.' }
  }

  function close({ focus = false } = {}) {
    setOpen(false)
    setQuery('')
    setActive(0)
    if (focus) field.current?.focus()
  }

  async function pick(option: Option) {
    if (typeof place !== 'object') return
    close({ focus: true })
    setBusy(true)
    onNote(undefined)
    try {
      if (option.kind === 'page') {
        await chooseTarget(place, option.page)
        onNote({ text: `Clips go to “${option.page.title}”.` })
      } else {
        const made = await defaultTarget(place)
        onNote(
          typeof made === 'string'
            ? { text: made, failed: true }
            : { text: `Clips go to “${made.title}”${made.made ? ', made in your Private section' : ''}.` },
        )
      }
    } catch (err) {
      onNote({ text: err instanceof Error ? err.message : String(err), failed: true })
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      close({ focus: true })
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((n) => (options.length ? (n + step + options.length) % options.length : 0))
    } else if (e.key === 'Enter' && options[active]) {
      e.preventDefault()
      void pick(options[active])
    }
  }

  // Leaving the picker (a click or Tab outside it) closes it.
  function onBlur(e: FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget)) close()
  }

  const listId = `${id}-list`
  const optionId = (n: number) => `${id}-option-${n}`
  const groups = [...new Set(options.map((o) => o.group))]
  return (
    <div className="clip-into" onBlur={open ? onBlur : undefined}>
      <div className="clip-into-head">
        <span aria-hidden="true">Clip into</span>
        {target && (
          <a href={target.url} target="_blank" rel="noreferrer" aria-label={`Open ${target.title}`}>
            Open in Notion
          </a>
        )}
      </div>
      <div className="clip-into-row">
        <button
          ref={field}
          type="button"
          className="clip-field"
          aria-label="Clip into"
          aria-description={target?.title}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-busy={busy || undefined}
          // While a choice is saved: a second one could land first, then be overwritten by the first.
          disabled={busy}
          onClick={() => (open ? close() : setOpen(true))}
        >
          <Icon name="page" />
          <span className={target ? 'clip-field-name' : 'clip-field-name empty'}>
            {busy ? 'Saving…' : (target?.title ?? 'Choose a page')}
          </span>
          <span className="clip-field-chevron">
            <Icon name="forward" />
          </span>
        </button>
      </div>
      {open && (
        <div
          className="page-picker clip-picker"
          // A press anywhere in the picker but its search field (a heading, the status line) keeps the
          // focus there, so the picker stays open.
          onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}
        >
          <input
            type="search"
            className="picker-search"
            aria-label="Search pages"
            placeholder="Search pages…"
            aria-controls={listId}
            aria-activedescendant={options[active] ? optionId(active) : undefined}
            value={query}
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
          />
          <div className="picker-list">
            {options.length > 0 && (
              <div id={listId} role="listbox" aria-label="Pages to clip into">
                {groups.map((group) => (
                  <div key={group} role="group" aria-label={group}>
                    <div className="picker-group" aria-hidden="true">
                      {group}
                    </div>
                    {options.map((o, n) =>
                      o.group !== group ? null : (
                        <div
                          key={o.kind === 'page' ? o.page.id : 'default'}
                          id={optionId(n)}
                          role="option"
                          aria-selected={n === active}
                          className={n === active ? 'picker-option active' : 'picker-option'}
                          // Keeps the focus in the search field.
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseMove={() => n !== active && setActive(n)}
                          onClick={() => void pick(o)}
                        >
                          <Icon name={o.kind === 'page' ? 'page' : 'plus'} />
                          <span className="picker-lines">
                            <span className="picker-name">{o.kind === 'page' ? o.page.title : DEFAULT_TARGET}</span>
                            {o.detail && <span className="picker-path">{o.detail}</span>}
                          </span>
                          {o.kind === 'page' && o.page.id === targetId && <span className="picker-hint">Current</span>}
                        </div>
                      ),
                    )}
                  </div>
                ))}
              </div>
            )}
            {state && (
              <p className="picker-state" role="status">
                {state.loading && <span className="spinner" aria-hidden="true" />}
                {state.text}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
