import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from './icons'
import { useMenu } from './menu'

/** How saving a reply or a chat to Notion went: what shows where the user saved it. */
export type SaveState = { status: 'saving' } | { status: 'saved'; url: string } | { status: 'failed'; error: string }

/** Saves something to Notion, resolving with the new page's link; it rejects with what to tell the user. */
export type Save = () => Promise<{ url: string }>

/**
 * The state of each thing's save, by key, and a function that starts one. A save that is running
 * starts no other for its key: one click creates at most one page. Keep it where it outlives what
 * shows it (a closed popover or list), so neither the guard nor the link is lost.
 */
export function useSaves(): [Record<string, SaveState>, (key: string, save: Save) => void] {
  const [states, setStates] = useState<Record<string, SaveState>>({})
  const running = useRef(new Set<string>())
  function start(key: string, save: Save) {
    if (running.current.has(key)) return
    running.current.add(key)
    const set = (state: SaveState) => setStates((all) => ({ ...all, [key]: state }))
    set({ status: 'saving' })
    save()
      .then(
        ({ url }) => set({ status: 'saved', url }),
        (err: unknown) => set({ status: 'failed', error: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => running.current.delete(key))
  }
  return [states, start]
}

/**
 * What a save shows once started: that it is running, a link to the page it made, or why it failed.
 * With `focus`, the link takes the focus as it shows, since it takes the place of the button pressed.
 */
function SaveStatus({ state, focus }: { state?: SaveState; focus?: boolean }) {
  // Not `autoFocus`: React applies it to form controls only.
  const link = useRef<HTMLAnchorElement>(null)
  const saved = state?.status === 'saved'
  useEffect(() => {
    if (focus && saved) link.current?.focus()
  }, [focus, saved])
  if (!state) return null
  if (state.status === 'saving') return <span className="save-note">Saving to Notion…</span>
  if (state.status === 'saved')
    return (
      <a className="save-link" href={state.url} target="_blank" rel="noreferrer" ref={link}>
        <Icon name="page" />
        Open the saved page
      </a>
    )
  return (
    <span className="save-note failed" role="alert">
      {state.error}
    </span>
  )
}

/**
 * "Save to Notion", inside a reply's details. `blocked` says why it can't be used now; once the
 * page is made, the link to it takes the button's place.
 */
export function SaveReply({ blocked, state, onSave }: { blocked?: string; state?: SaveState; onSave: () => void }) {
  const hint = useId()
  return (
    <div className="reply-save">
      {state?.status !== 'saved' && (
        <button
          type="button"
          className="save-button"
          disabled={!!blocked}
          // Not `disabled` while it saves, so the focus stays on it; a second press starts nothing (useSaves).
          aria-disabled={state?.status === 'saving' || undefined}
          aria-describedby={blocked ? hint : undefined}
          onClick={onSave}
        >
          <Icon name="page" />
          Save to Notion
        </button>
      )}
      {blocked && state?.status !== 'saved' && (
        <span id={hint} className="save-note">
          {blocked}
        </span>
      )}
      <SaveStatus state={state} focus />
    </div>
  )
}

/** The "…" menu of a row in the chat list, with "Save to Notion", and what the save shows under the row. */
export function ChatMenu({ blocked, state, onSave }: { blocked?: string; state?: SaveState; onSave: () => void }) {
  const { open, setOpen, close, rootRef, menuRef, onKeyDown } = useMenu()
  const hint = useId()
  return (
    <>
      <div className="chat-menu" ref={rootRef} onKeyDown={onKeyDown}>
        <button
          type="button"
          className="session-more"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="More for this chat"
          title="More"
          onClick={() => setOpen(!open)}
        >
          <Icon name="dots" />
        </button>
        {open && (
          <div className="chat-popover">
            <div ref={menuRef} role="menu" aria-label="Chat">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={blocked || state?.status === 'saving' ? true : undefined}
                aria-describedby={blocked ? hint : undefined}
                onClick={() => {
                  if (blocked) return
                  // Back to the "…" button: the item is about to go.
                  close()
                  onSave()
                }}
              >
                <Icon name="page" />
                Save to Notion
              </button>
            </div>
            {/* Outside the menu, which holds only its items; the item names it as its description. */}
            {blocked && (
              <span id={hint} className="save-note">
                {blocked}
              </span>
            )}
          </div>
        )}
      </div>
      {state && (
        <div className="session-saved">
          <SaveStatus state={state} />
        </div>
      )}
    </>
  )
}
