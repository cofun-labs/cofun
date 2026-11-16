import { useEffect, useId, useRef } from 'react'
import type { SaveState } from './chat-session'
import { Icon } from './icons'

/**
 * The icon that saves a reply or the chat to Notion, with a tooltip saying what it does; once the
 * page is made, a link to it in its place. `blocked` says why it can't be used now (the tooltip
 * says it, and pressing does nothing).
 */
export function SaveButton({
  what,
  destination,
  state,
  blocked,
  onSave,
  className,
  tipBelow,
}: {
  what: 'reply' | 'chat'
  destination: string
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
        aria-label={`Save ${what} to ${destination}`}
        // Not `disabled`: the tooltip still says why, and the focus stays while it saves.
        aria-disabled={blocked || saving ? true : undefined}
        aria-describedby={blocked ? hint : undefined}
        data-tip={saving ? `Saving the ${what}…` : (blocked ?? `Save ${what} to ${destination}`)}
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
export function SaveToast({
  message,
  onClose,
}: {
  message: string
  /** `focused`: the focus was in the toast, so it needs somewhere to go. */
  onClose: (focused: boolean) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const close = useRef(() => onClose(!!root.current?.contains(document.activeElement)))
  close.current = () => onClose(!!root.current?.contains(document.activeElement))
  useEffect(() => {
    const timer = setTimeout(() => close.current(), TOAST_MS)
    return () => clearTimeout(timer)
  }, [message])
  return (
    <div className="save-toast" role="alert" ref={root}>
      <span className="grow">{message}</span>
      <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => close.current()}>
        <Icon name="close" />
      </button>
    </div>
  )
}
