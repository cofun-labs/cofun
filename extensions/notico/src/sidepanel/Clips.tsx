import { useEffect, useRef, useState } from 'react'
import { loadClipSettings, watchClips, type ClipRequest } from '../clip'
import { CHOOSE_A_TARGET, writeClip } from '../tools/clip'
import { Icon } from './icons'

type ClipState =
  | { status: 'clipping'; target: string }
  | { status: 'clipped'; target: string; url: string }
  | { status: 'failed'; message: string }

/**
 * Writes each clip sent to this window's side panel with the context menu (src/clip.ts), one at a
 * time in the order clicked, and says over the chat how the latest one went: a link to what it
 * made, or why it failed. It stays until the user closes it or clips again.
 */
export function Clips() {
  const [state, setState] = useState<ClipState>()
  // Clips are written one after another: two at once would each look for the target's tab.
  const queue = useRef(Promise.resolve())

  useEffect(() => {
    let stop: (() => void) | undefined
    let closed = false
    const run = async (windowId: number, clip: ClipRequest) => {
      const { target } = await loadClipSettings()
      if (!target) return setState({ status: 'failed', message: CHOOSE_A_TARGET })
      setState({ status: 'clipping', target: target.title })
      try {
        const { url } = await writeClip(windowId, target, clip)
        if (!closed) setState({ status: 'clipped', target: target.title, url })
      } catch (err) {
        if (!closed) setState({ status: 'failed', message: err instanceof Error ? err.message : String(err) })
      }
    }
    chrome.windows
      .getCurrent()
      .then((window) => {
        const windowId = window.id
        if (closed || windowId === undefined) return
        stop = watchClips(windowId, (clip) => {
          queue.current = queue.current.then(() => run(windowId, clip)).catch((err: unknown) => console.error(err))
        })
      })
      .catch((err: unknown) => console.error('Could not tell which window the side panel is in', err))
    return () => {
      closed = true
      stop?.()
    }
  }, [])

  if (!state) return null
  const close = (
    <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setState(undefined)}>
      <Icon name="close" />
    </button>
  )
  if (state.status === 'failed')
    return (
      <div className="clip-notice" role="alert">
        <span className="grow">{state.message}</span>
        {close}
      </div>
    )
  return (
    <div className="clip-notice" role="status">
      <span className="grow">
        {state.status === 'clipping' ? (
          `Clipping to “${state.target}”…`
        ) : (
          <>
            Clipped to “{state.target}”.{' '}
            <a href={state.url} target="_blank" rel="noreferrer">
              Open the clipped page
            </a>
          </>
        )}
      </span>
      {state.status === 'clipped' && close}
    </div>
  )
}
