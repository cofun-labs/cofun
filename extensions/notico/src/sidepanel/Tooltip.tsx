import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** How long the pointer rests on a control before its tip shows; Chrome's own `title` waits about a second. */
const DELAY = 300
/** After a tip hides, the next control's tip shows at once for this long, so moving along a toolbar reads each. */
const WARM = 500
/** Room kept between a tip and the edge of the panel. */
const EDGE = 6

/**
 * The tip of the control under the pointer, or with keyboard focus: what its `data-tip` says. One for
 * the whole panel, drawn above the control, or below it when there is no room. It only shows what
 * the control's accessible name already says, so screen readers are not told it again.
 */
export function Tooltips() {
  const [tip, setTip] = useState<{ text: string; anchor: DOMRect }>()
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number }>()

  useEffect(() => {
    let current: HTMLElement | undefined
    let timer: number | undefined
    let warmUntil = 0
    // A tip that changes while it shows (Copy reply, then Copied) follows the control.
    const watch = new MutationObserver(() => current && show(current))

    const show = (el: HTMLElement) => {
      const text = el.dataset.tip
      if (!text || !el.isConnected) return hide()
      setTip({ text, anchor: el.getBoundingClientRect() })
    }
    const hide = () => {
      clearTimeout(timer)
      watch.disconnect()
      if (current) warmUntil = Date.now() + WARM
      current = undefined
      setTip(undefined)
    }
    const follow = (el: HTMLElement | undefined, now: boolean) => {
      if (el === current) return
      if (!el) return hide()
      clearTimeout(timer)
      watch.disconnect()
      setTip(undefined)
      current = el
      watch.observe(el, { attributeFilter: ['data-tip'] })
      if (now || Date.now() < warmUntil) show(el)
      else timer = window.setTimeout(() => show(el), DELAY)
    }
    const tipped = (target: EventTarget | null) =>
      target instanceof Element ? (target.closest<HTMLElement>('[data-tip]') ?? undefined) : undefined

    const onPointerOver = (e: PointerEvent) => follow(tipped(e.target), false)
    const onFocusIn = (e: FocusEvent) => {
      const el = tipped(e.target)
      // Keyboard focus only: a click also focuses the control, and its tip would linger.
      if (el && el.matches(':focus-visible')) follow(el, true)
    }
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && hide()
    const options = { capture: true }
    document.addEventListener('pointerover', onPointerOver, options)
    document.addEventListener('focusin', onFocusIn, options)
    document.addEventListener('focusout', hide, options)
    document.addEventListener('pointerdown', hide, options)
    document.addEventListener('keydown', onKeyDown, options)
    document.addEventListener('scroll', hide, options)
    window.addEventListener('blur', hide)
    return () => {
      hide()
      document.removeEventListener('pointerover', onPointerOver, options)
      document.removeEventListener('focusin', onFocusIn, options)
      document.removeEventListener('focusout', hide, options)
      document.removeEventListener('pointerdown', hide, options)
      document.removeEventListener('keydown', onKeyDown, options)
      document.removeEventListener('scroll', hide, options)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // Placed once drawn, so its own size is known: centered on the control, kept inside the panel.
  useLayoutEffect(() => {
    const box = ref.current
    if (!tip || !box) return setPlace(undefined)
    const { width, height } = box.getBoundingClientRect()
    const { anchor } = tip
    const left = Math.min(Math.max(EDGE, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - EDGE)
    const above = anchor.top - height - EDGE
    const top = above >= EDGE ? above : anchor.bottom + EDGE
    setPlace({ left, top })
  }, [tip])

  if (!tip) return null
  return (
    <div
      ref={ref}
      className="tooltip"
      role="tooltip"
      aria-hidden="true"
      style={place ? { left: place.left, top: place.top } : { visibility: 'hidden' }}
    >
      {tip.text}
    </div>
  )
}
