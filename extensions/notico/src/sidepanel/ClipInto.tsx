import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { ClipTarget } from '../clip'
import {
  chooseTarget,
  clipPlace,
  DEFAULT_TARGET,
  defaultTarget,
  findTargets,
  type ClipPlace,
  type PageChoice,
} from '../tools/clip'

/** How long typing pauses before the workspace is searched: one search per pause, not per key. */
const SEARCH_DELAY_MS = 300

/** What Settings says about the last choice: done, or why not. */
export interface ClipNote {
  text: string
  failed?: boolean
}

type Option = { kind: 'page'; page: PageChoice; label: string } | { kind: 'default'; label: string }

/**
 * Where clips go, and a search box to choose another page: Notion's quick find in the workspace of
 * the Notion page in the current tab. With nothing typed it offers that page and the private page
 * "Notico Clips" (made if the user has none).
 */
export function ClipInto({ target, onNote }: { target?: ClipTarget; onNote: (note: ClipNote | undefined) => void }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [place, setPlace] = useState<ClipPlace | string>()
  const [found, setFound] = useState<{ query: string; pages: PageChoice[] | string }>()
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // The workspace is looked up as the box opens: the current tab may have changed since.
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

  let options: Option[] = []
  let message: string | undefined
  if (typeof place === 'string') message = place
  else if (!place) message = 'Looking for your Notion page…'
  else if (words) {
    const result = found?.query === words ? found.pages : undefined
    if (result === undefined) message = 'Searching…'
    else if (typeof result === 'string') message = result
    else if (!result.length) message = `No pages found for “${words}”.`
    else options = result.map((page) => ({ kind: 'page', page, label: page.title }))
  } else {
    const current = place.current
    if (current) options.push({ kind: 'page', page: current, label: `Current page: ${current.title}` })
    if (target?.title !== DEFAULT_TARGET) options.push({ kind: 'default', label: `${DEFAULT_TARGET}, in Private` })
    if (!options.length) message = 'Type to search your workspace.'
  }

  async function pick(option: Option) {
    if (typeof place !== 'object') return
    setOpen(false)
    setQuery('')
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
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return setOpen(true)
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((n) => (options.length ? (n + step + options.length) % options.length : 0))
    } else if (e.key === 'Enter' && open && options[active]) {
      e.preventDefault()
      void pick(options[active])
    }
  }

  const listId = `${id}-list`
  const optionId = (n: number) => `${id}-option-${n}`
  return (
    <div className="clip-into">
      <p>
        Clip into{' '}
        {target ? (
          <a href={target.url} target="_blank" rel="noreferrer">
            {target.title}
          </a>
        ) : (
          <span className="account-detail">no page yet</span>
        )}
      </p>
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-label="Clip into"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? optionId(active) : undefined}
        aria-busy={busy || undefined}
        placeholder={busy ? 'Saving…' : 'Search Notion pages'}
        value={query}
        onFocus={() => setOpen(true)}
        // Clicked again after Escape closed it, while it still has the focus.
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label="Pages to clip into" className="clip-into-list">
          {options.map((option, n) => (
            <li
              key={option.kind === 'page' ? option.page.id : 'default'}
              id={optionId(n)}
              role="option"
              aria-selected={n === active}
              // Before the box loses the focus, which closes the list.
              onMouseDown={(e) => {
                e.preventDefault()
                void pick(option)
              }}
            >
              {option.label}
            </li>
          ))}
          {message && (
            <li role="presentation" className="account-detail">
              {message}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
