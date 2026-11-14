import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from './icons'

/** How saving a reply or a chat to Notion is going: running, or done with a link to the page. */
export type SaveState = { status: 'saving' } | { status: 'saved'; url: string }

/** Saves something to Notion, resolving with the new page's link; it rejects with what to tell the user. */
type Save = () => Promise<{ url: string }>

/**
 * The state of each thing's save, by key, and a function that starts one. A save that is running
 * starts no other for its key: one click creates at most one page. A failure leaves the key as it
 * was before, so the save can be tried again, and goes to `onFail` with what to tell the user.
 * Keep it where it outlives what shows it (a reply's row that shows another chat), so neither the
 * guard nor the link is lost.
 */
export function useSaves(
  onFail: (message: string) => void,
): [Record<string, SaveState>, (key: string, save: Save) => void] {
  const [states, setStates] = useState<Record<string, SaveState>>({})
  const running = useRef(new Set<string>())
  const fail = useRef(onFail)
  fail.current = onFail
  function start(key: string, save: Save) {
    if (running.current.has(key)) return
    running.current.add(key)
    const set = (state?: SaveState) =>
      setStates((all) => {
        const next = { ...all }
        if (state) next[key] = state
        else delete next[key]
        return next
      })
    set({ status: 'saving' })
    save()
      .then(
        ({ url }) => set({ status: 'saved', url }),
        (err: unknown) => {
          set(undefined)
          fail.current(err instanceof Error ? err.message : String(err))
        },
      )
      .finally(() => running.current.delete(key))
  }
  return [states, start]
}

/**
 * The icon that saves a reply or the chat to Notion, with a tooltip saying what it does; once the
 * page is made, a link to it in its place. `blocked` says why it can't be used now (the tooltip
 * says it, and pressing does nothing).
 */
export function SaveButton({
  what,
  state,
  blocked,
  onSave,
  className,
  tipBelow,
}: {
  what: 'reply' | 'chat'
  state?: SaveState
  blocked?: string
  onSave: () => void
  /** The look of the place it sits in: a reply's row, or the header. */
  className: string
  /** The tooltip opens below, as in the header. */
  tipBelow?: boolean
}) {
  const link = useRef<HTMLAnchorElement>(null)
  const hint = useId()
  const saved = state?.status === 'saved'
  // The link takes the place of the button, and the focus with it, unless the user moved on
  // meanwhile. Not `autoFocus`: React applies it to form controls only.
  useEffect(() => {
    if (saved && document.activeElement === document.body) link.current?.focus()
  }, [saved])
  const tip = tipBelow ? 'tip-below' : undefined
  if (state?.status === 'saved') {
    const label = `Open the saved ${what}`
    return (
      <a
        className={`${className} ${tip ?? ''}`}
        href={state.url}
        target="_blank"
        rel="noreferrer"
        ref={link}
        aria-label={label}
        data-tip={label}
      >
        <Icon name="check" />
      </a>
    )
  }
  const saving = state?.status === 'saving'
  return (
    <>
      <button
        type="button"
        className={`${className} ${tip ?? ''}`}
        aria-label={`Save ${what} to Notion`}
        // Not `disabled`: the tooltip still says why, and the focus stays while it saves.
        aria-disabled={blocked || saving ? true : undefined}
        aria-describedby={blocked ? hint : undefined}
        data-tip={saving ? `Saving the ${what}…` : (blocked ?? `Save ${what} to Notion`)}
        onClick={() => !blocked && onSave()}
      >
        <Icon name="save" />
      </button>
      {blocked && (
        <span id={hint} className="sr-only">
          {blocked}
        </span>
      )}
    </>
  )
}

/** How long a failed save's message shows: pressing the icon again shows it again. */
const TOAST_MS = 6000

/** Why a save failed, for a few seconds or until the user closes it. */
export function SaveToast({ message, onClose }: { message: string; onClose: () => void }) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const timer = setTimeout(() => close.current(), TOAST_MS)
    return () => clearTimeout(timer)
  }, [message])
  return (
    <div className="save-toast" role="alert">
      <span className="grow">{message}</span>
      <button type="button" className="icon-button" aria-label="Dismiss" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  )
}
