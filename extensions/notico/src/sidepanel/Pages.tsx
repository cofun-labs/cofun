import type { MouseEvent } from 'react'
import type { QuestionPage, QuestionSelection } from '../agent'
import { Icon } from './icons'

/** A page's title as the panel shows it; Notion shows a page without one as "Untitled". */
export const titleOf = (page: QuestionPage) => page.title.trim() || 'Untitled'

/** A page's icon: a table for a database, a page otherwise. */
export function PageIcon({ page }: { page: QuestionPage }) {
  return <Icon name={page.database ? 'database' : 'page'} />
}

/** A page the next question goes with; `auto` when the panel added it (the page open in the tab). */
export interface Chip {
  page: QuestionPage
  auto: boolean
}

/** Where a selection is from and how it starts, as its chip says it: `example.com: “The text…”`. */
function selectionLabel(selection: QuestionSelection): string {
  let host = ''
  try {
    host = new URL(selection.url).host
  } catch {
    // Not a URL: the chip shows the text alone.
  }
  return `${host ? `${host}: ` : ''}“${selection.quote}”`
}

/** Whether the panel links to the page a selection is from: only to a web page. */
const linksTo = (url: string) => /^https?:\/\//.test(url)

/**
 * The pages the next question goes with, at the top of the composer: the page open in the current
 * tab, dashed since the panel added it, and the pages the user added, each of which they can take
 * off the question; then the text the user selected on pages and sent with the context menu.
 */
export function ComposerPages({
  chips,
  onRemove,
  selections,
  onRemoveSelection,
}: {
  chips: Chip[]
  onRemove: (chip: Chip) => void
  selections: QuestionSelection[]
  /** Takes the selection at this place in `selections` off the question. */
  onRemoveSelection: (index: number) => void
}) {
  if (!chips.length && !selections.length) return null
  return (
    <ul className="page-chips" aria-label="Pages to send">
      {chips.map((chip) => {
        const title = titleOf(chip.page)
        return (
          <li
            key={chip.page.url}
            className={chip.auto ? 'page-chip added' : 'page-chip'}
            title={chip.auto ? 'The page open in this tab' : title}
          >
            <PageIcon page={chip.page} />
            <span className="page-title">{title}</span>
            <button
              type="button"
              className="page-remove"
              aria-label={`Remove ${title}`}
              title="Remove"
              onClick={() => onRemove(chip)}
            >
              <Icon name="close" />
            </button>
          </li>
        )
      })}
      {selections.map((selection, i) => (
        <li key={`${i}:${selection.url}`} className="page-chip" title={selection.title || undefined}>
          <Icon name="quote" />
          <span className="page-title">{selectionLabel(selection)}</span>
          <button
            type="button"
            className="page-remove"
            aria-label={`Remove ${selectionLabel(selection)}`}
            title="Remove"
            onClick={() => onRemoveSelection(i)}
          >
            <Icon name="close" />
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * The pages a question was sent with, and the text selected on pages it was sent with, in its bubble
 * under what the user typed. Each is a link that takes the current tab to the page, as a link in
 * Notion would; a modified click (to open it in a new tab or window) is left to the browser.
 */
export function SentPages({ pages, selections }: { pages?: QuestionPage[]; selections?: QuestionSelection[] }) {
  if (!pages?.length && !selections?.length) return null
  const open = (event: MouseEvent<HTMLAnchorElement>, url: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    void chrome.tabs.update({ url })
  }
  return (
    <ul className="sent-pages" aria-label="Pages sent">
      {pages?.map((page, i) => (
        <li key={i}>
          <a href={page.url} onClick={(event) => open(event, page.url)}>
            <PageIcon page={page} />
            <span className="page-title">{titleOf(page)}</span>
          </a>
        </li>
      ))}
      {selections?.map((selection, i) => (
        <li key={`s${i}`} title={selection.title || undefined}>
          {/* A link takes the tab to the page, where Chrome finds the selection and marks it. */}
          {linksTo(selection.url) ? (
            <a href={selection.url} onClick={(event) => open(event, selection.url)}>
              <Icon name="quote" />
              <span className="page-title">{selectionLabel(selection)}</span>
            </a>
          ) : (
            <span className="sent-quote">
              <Icon name="quote" />
              <span className="page-title">{selectionLabel(selection)}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
