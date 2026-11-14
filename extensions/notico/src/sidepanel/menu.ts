import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

/**
 * A menu that opens from a button, as the panel's menus behave: opening puts the focus on the
 * first item, the arrow keys, Home, and End move between items, Escape closes it and puts the
 * focus back on the button, Tab moves on and closes it, and a press anywhere else closes it.
 * Put `rootRef` and `onKeyDown` on the element around the button and the menu, and `menuRef` on
 * the element with the menu role.
 */
export function useMenu() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]

  useEffect(() => {
    if (open) items()[0]?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function close() {
    setOpen(false)
    rootRef.current?.querySelector('button')?.focus()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      return close()
    }
    if (e.key === 'Tab') return setOpen(false)
    const all = items()
    const at = all.findIndex((item) => item === document.activeElement)
    const to = {
      ArrowDown: (at + 1) % all.length,
      ArrowUp: (at <= 0 ? all.length : at) - 1,
      Home: 0,
      End: all.length - 1,
    }[e.key]
    if (to === undefined) return
    e.preventDefault()
    all[to]?.focus()
  }

  return { open, setOpen, close, rootRef, menuRef, onKeyDown }
}
