import type { QuestionPage } from '../agent'
import { Icon } from './icons'

/** A page's title as the panel shows it; Notion shows a page without one as "Untitled". */
const titleOf = (page: QuestionPage) => page.title.trim() || 'Untitled'

/**
 * The pages the next question goes with, at the top of the composer: for now only the page open in
 * the current tab, which the user can take off the question. Dashed, since the panel added it.
 */
export function ComposerPages({ open, onRemove }: { open?: QuestionPage; onRemove: () => void }) {
  if (!open) return null
  const title = titleOf(open)
  return (
    <ul className="page-chips" aria-label="Pages to send">
      <li className="page-chip added" title="The page open in this tab">
        <Icon name="page" />
        <span className="page-title">{title}</span>
        <button type="button" className="page-remove" aria-label={`Remove ${title}`} title="Remove" onClick={onRemove}>
          <Icon name="close" />
        </button>
      </li>
    </ul>
  )
}

/** The pages a question was sent with, in its bubble under what the user typed. */
export function SentPages({ pages }: { pages?: QuestionPage[] }) {
  if (!pages?.length) return null
  return (
    <ul className="sent-pages" aria-label="Pages sent">
      {pages.map((page, i) => (
        <li key={i}>
          <Icon name="page" />
          <span className="page-title">{titleOf(page)}</span>
        </li>
      ))}
    </ul>
  )
}
