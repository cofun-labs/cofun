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
    // The text shown, if the tip shows.
    let shown: string | undefined
    // The control whose tip a click or Escape put away. It shows none until the pointer leaves it,
    // whatever focus does meanwhile: a click moves focus, from the message box say, and that must not
    // let the tip come back as the pointer moves within the control (from its icon to its edge).
    let dismissed: HTMLElement | undefined
    // A tip that changes while it shows (Copy reply, then Copied) follows the control, and one whose
    // control is gone hides: a removed control fires no focusout or pointer event.
    const watch = new MutationObserver(() => {
      if (!current) return
      if (!current.isConnected) hide()
      else if (shown !== undefined && current.dataset.tip !== shown) show(current)
    })

    const show = (el: HTMLElement) => {
      const text = el.dataset.tip
      if (!text || !el.isConnected) return hide()
      shown = text
      setTip({ text, anchor: el.getBoundingClientRect() })
    }
    const hide = () => {
      clearTimeout(timer)
      watch.disconnect()
      if (shown !== undefined) warmUntil = Date.now() + WARM
      current = undefined
      shown = undefined
      setTip(undefined)
    }
    // Puts away the tip of `el`: the control pressed, or for Escape the one whose tip shows.
    const dismiss = (el: HTMLElement | undefined) => {
      hide()
      dismissed = el
      // Not a move along a toolbar: the next control's tip waits as usual.
      warmUntil = 0
    }
    const follow = (el: HTMLElement | undefined, now: boolean) => {
      // A put-away tip shows again once the pointer, or the focus, has moved on to another control.
      if (el === dismissed) return
      dismissed = undefined
      if (el === current) return
      if (!el) return hide()
      clearTimeout(timer)
      watch.disconnect()
      shown = undefined
      setTip(undefined)
      current = el
      watch.observe(document.body, { subtree: true, childList: true, attributeFilter: ['data-tip'] })
      if (now || Date.now() < warmUntil) show(el)
      else timer = window.setTimeout(() => show(el), DELAY)
    }
    const tipped = (target: EventTarget | null) =>
      target instanceof Element ? (target.closest<HTMLElement>('[data-tip]') ?? undefined) : undefined

    const onPointerOver = (e: PointerEvent) => follow(tipped(e.target), false)
    // Out of the panel altogether (onto the page next to it): no pointerover follows inside it.
    const onPointerOut = (e: PointerEvent) => {
      if (e.relatedTarget !== null) return
      dismissed = undefined
      hide()
    }
    // Only a scroll that moves the control: the chat scrolling itself as a reply streams in leaves
    // the composer's buttons, and their tips, where they are.
    const onScroll = (e: Event) => {
      const scrolled = e.target === document ? document.documentElement : e.target
      if (current && scrolled instanceof Node && scrolled.contains(current)) hide()
    }
    const onFocusIn = (e: FocusEvent) => {
      const el = tipped(e.target)
      // Keyboard focus only: a click also focuses the control, and its tip would linger.
      if (el && el.matches(':focus-visible')) follow(el, true)
    }
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && dismiss(current)
    const onPointerDown = (e: PointerEvent) => dismiss(tipped(e.target))
    const options = { capture: true }
    document.addEventListener('pointerover', onPointerOver, options)
    document.addEventListener('pointerout', onPointerOut, options)
    document.addEventListener('focusin', onFocusIn, options)
    document.addEventListener('focusout', hide, options)
    document.addEventListener('pointerdown', onPointerDown, options)
    document.addEventListener('keydown', onKeyDown, options)
    document.addEventListener('scroll', onScroll, options)
    window.addEventListener('blur', hide)
    // The tip is placed once; the panel resizing moves the control from under it.
    window.addEventListener('resize', hide)
    return () => {
      hide()
      document.removeEventListener('pointerover', onPointerOver, options)
      document.removeEventListener('pointerout', onPointerOut, options)
      document.removeEventListener('focusin', onFocusIn, options)
      document.removeEventListener('focusout', hide, options)
      document.removeEventListener('pointerdown', onPointerDown, options)
      document.removeEventListener('keydown', onKeyDown, options)
      document.removeEventListener('scroll', onScroll, options)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
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
