import type { MouseEvent } from 'react'
import type { QuestionPage } from '../agent'
import { Icon } from './icons'

/** A page's title as the panel shows it; Notion shows a page without one as "Untitled". */
export const titleOf = (page: QuestionPage) => page.title.trim() || 'Untitled'

/** A page's icon: a table for a database, a globe for a tab on another site, a page otherwise. */
export function PageIcon({ page }: { page: QuestionPage }) {
  return <Icon name={page.database ? 'database' : page.web ? 'globe' : 'page'} />
}

/** A page the next question goes with; `auto` when the panel added it (the page open in the tab). */
export interface Chip {
  page: QuestionPage
  auto: boolean
}

/**
 * The pages the next question goes with, at the top of the composer: the page open in the current
 * tab, dashed since the panel added it, and the pages and tabs the user added, each of which they
 * can take off the question.
 */
export function ComposerPages({ chips, onRemove }: { chips: Chip[]; onRemove: (chip: Chip) => void }) {
  if (!chips.length) return null
  return (
    <ul className="page-chips" aria-label="Pages to send">
      {chips.map((chip) => {
        const title = titleOf(chip.page)
        return (
          <li
            key={chip.page.url}
            className={chip.auto ? 'page-chip added' : 'page-chip'}
            title={chip.auto ? 'The page open in this tab' : chip.page.web ? chip.page.url : title}
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
    </ul>
  )
}

/**
 * The pages a question was sent with, in its bubble under what the user typed. Each is a link: a
 * Notion page's takes the current tab to the page, as a link in Notion would; a tab on another
 * site's goes to that tab while one in the window still shows it, else opens it in a new tab. A
 * modified click (to open it in a new tab or window) is left to the browser.
 */
export function SentPages({ pages }: { pages?: QuestionPage[] }) {
  if (!pages?.length) return null
  const open = (event: MouseEvent<HTMLAnchorElement>, page: QuestionPage) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    if (!page.web) return void chrome.tabs.update({ url: page.url })
    void chrome.tabs.query({ currentWindow: true }).then((tabs) => {
      const tab = tabs.find((t) => t.url === page.url)
      return tab?.id === undefined
        ? chrome.tabs.create({ url: page.url })
        : chrome.tabs.update(tab.id, { active: true })
    })
  }
  return (
    <ul className="sent-pages" aria-label="Pages sent">
      {pages.map((page, i) => (
        <li key={i}>
          <a href={page.url} onClick={(event) => open(event, page)}>
            <PageIcon page={page} />
            <span className="page-title">{titleOf(page)}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}
