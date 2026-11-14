import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from './icons'

/** How saving a reply or a chat to Notion went: what shows where the user saved it. */
export type SaveState = { status: 'saving' } | { status: 'saved'; url: string } | { status: 'failed'; error: string }

/** Saves something to Notion, resolving with the new page's link; it rejects with what to tell the user. */
type Save = () => Promise<{ url: string }>

/**
 * The state of each thing's save, by key, and a function that starts one. A save that is running
 * starts no other for its key: one click creates at most one page. Keep it where it outlives what
 * shows it (a closed popover, a reply's row that shows another chat), so neither the guard nor the
 * link is lost.
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

export interface SaveActionsProps {
  /** Why nothing can be saved now, if it can't. */
  blocked?: string
  reply?: SaveState
  chat?: SaveState
  onSaveReply: () => void
  onSaveChat: () => void
}

/**
 * The actions at the top of a reply's details: save the reply, or the whole chat, to Notion. Each
 * becomes a link to the page it made, and says while it saves or why it failed.
 */
export function SaveActions({ blocked, reply, chat, onSaveReply, onSaveChat }: SaveActionsProps) {
  const hint = useId()
  return (
    <div className="save-actions">
      <SaveItem what="reply" state={reply} blocked={blocked} hint={hint} onSave={onSaveReply} />
      <SaveItem what="chat" state={chat} blocked={blocked} hint={hint} onSave={onSaveChat} />
      {blocked && (
        <div id={hint} className="save-note">
          {blocked}
        </div>
      )}
    </div>
  )
}

function SaveItem({
  what,
  state,
  blocked,
  hint,
  onSave,
}: {
  what: 'reply' | 'chat'
  state?: SaveState
  blocked?: string
  hint: string
  onSave: () => void
}) {
  const link = useRef<HTMLAnchorElement>(null)
  const saved = state?.status === 'saved'
  // The link takes the place of the button, and the focus with it, unless the user has moved on
  // from the popover meanwhile. Not `autoFocus`: React applies it to form controls only.
  useEffect(() => {
    const popover = link.current?.closest('[role="dialog"]')
    const at = document.activeElement
    if (saved && (at === document.body || popover?.contains(at))) link.current?.focus()
  }, [saved])
  if (state?.status === 'saved')
    return (
      <a className="save-item saved" href={state.url} target="_blank" rel="noreferrer" ref={link}>
        <Icon name="check" />
        Open the saved {what}
      </a>
    )
  const saving = state?.status === 'saving'
  return (
    <>
      <button
        type="button"
        className="save-item"
        disabled={!!blocked}
        // Not `disabled` while it saves, so the focus stays on it; a second press starts nothing (useSaves).
        aria-disabled={saving || undefined}
        aria-describedby={blocked ? hint : undefined}
        onClick={onSave}
      >
        <Icon name="page" />
        {saving ? `Saving the ${what}…` : `Save ${what} to Notion`}
      </button>
      {state?.status === 'failed' && (
        <div className="save-note failed" role="alert">
          {state.error}
        </div>
      )}
    </>
  )
}
