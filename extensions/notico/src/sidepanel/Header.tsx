import type { ReactNode } from 'react'
import { Mark } from './icons'

/** The top of the panel: the product's mark and name, then whatever actions the screen has. */
export function Header({ children }: { children?: ReactNode }) {
  return (
    <header>
      <span className="brand-tile">
        <Mark />
      </span>
      <span className="title">Notico</span>
      {children}
    </header>
  )
}
