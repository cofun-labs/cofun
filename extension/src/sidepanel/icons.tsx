import type { ReactNode } from 'react'

/** The Cofun mark: an open ring with a dot just outside its gap (see `extension/icons/icon.svg`). */
export function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="-21 -21 42 42" aria-hidden="true" focusable="false">
      <path
        d="M12.9 -1.6A13 13 0 1 1 1.6 -12.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <circle cx="12" cy="-12" r="5" fill="currentColor" />
    </svg>
  )
}

// Drawn on a 16-unit grid, as outlines in the current text color (see `.icon` in style.css).
const SHAPES = {
  history: <path d="M8 4.5V8l2.3 1.5M2.5 8a5.5 5.5 0 1 0 1.7-4M2.5 3v2.5H5" />,
  compose: (
    <path d="M8 3H4a1.5 1.5 0 0 0-1.5 1.5V12A1.5 1.5 0 0 0 4 13.5h7.5A1.5 1.5 0 0 0 13 12V8M11.5 2.5l2 2L8.5 9.5l-2.5.5.5-2.5z" />
  ),
  send: <path d="M8 13V3.5M4 7l4-4 4 4" />,
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.3 10.3l3.2 3.2" />
    </>
  ),
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1M6.8 7v4M9.2 7v4" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  ask: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.5M8 11v.01" />
    </>
  ),
  dots: <path d="M3.5 8v.01M8 8v.01M12.5 8v.01" strokeWidth="2.4" />,
  minus: <path d="M4 8h8" />,
  square: <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />,
  slash: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4.2 11.8l7.6-7.6" />
    </>
  ),
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof SHAPES

/** A decorative icon: whatever it sits in carries the name. */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {SHAPES[name]}
    </svg>
  )
}
