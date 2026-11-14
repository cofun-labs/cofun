import type { ReactNode } from 'react'

/**
 * The top of the panel: what is open, on one line, then whatever actions the screen has. Chrome's own
 * title bar above the panel already names the extension, so the header does not.
 */
export function Header({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <header>
      {title !== undefined && <h1 className="title">{title}</h1>}
      {children}
    </header>
  )
}
