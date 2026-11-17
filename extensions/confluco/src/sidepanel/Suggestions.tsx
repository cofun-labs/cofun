// Confluco's own icon, the one in the toolbar and the store; the Cofun mark alone means Cofun.
import conflucoIcon from '../../icons/icon.svg'
import { Icon, type IconName } from './icons'

/** A suggestion: its words, and where the user goes on typing, if they finish it (the "…"). */
interface Suggestion {
  icon: IconName
  text: string
}

function startSet(readable: boolean) {
  const web: Suggestion = { icon: 'globe', text: 'Search the web for …' }
  return readable
    ? {
        heading: 'What do you want to know about this page?',
        line: 'Confluco can read this tab and search the web.',
        suggestions: [
          { icon: 'summary', text: 'Summarize this page' },
          { icon: 'question', text: 'What does this page say about …' },
          { icon: 'list', text: 'List its key points' },
          web,
        ] satisfies Suggestion[],
      }
    : {
        heading: 'What are you looking for?',
        line: 'Ask a question or search the web.',
        suggestions: [web],
      }
}

/**
 * The start of a chat: Confluco's icon, what it can do here, and suggestions that fit. Picking one
 * gives `onPick` the text for the message box and where the caret goes: where a "…" was, for the
 * user to finish it, or else at the end.
 */
export function ChatStart({ readable, onPick }: { readable: boolean; onPick: (text: string, caret: number) => void }) {
  const { heading, line, suggestions } = startSet(readable)
  return (
    <div className="empty">
      <div className="empty-head">
        <img className="product-icon" src={conflucoIcon} alt="" />
        <p className="empty-title">{heading}</p>
      </div>
      <p>{line}</p>
      <ul className="suggestions" aria-label="Suggestions">
        {suggestions.map(({ icon, text }) => (
          <li key={text}>
            <button
              type="button"
              onClick={() => {
                const at = text.indexOf('…')
                if (at < 0) onPick(text, text.length)
                else onPick(text.slice(0, at) + text.slice(at + 1), at)
              }}
            >
              <Icon name={icon} />
              {text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
