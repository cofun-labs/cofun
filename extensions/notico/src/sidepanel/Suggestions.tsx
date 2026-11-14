import type { Mode } from '../mode'
import type { OpenPage } from '../tools'
// Notico's own icon, the one in the toolbar and the store; the Cofun mark alone means Cofun.
import noticoIcon from '../../icons/icon.svg'
import { Icon, type IconName } from './icons'
import { titleOf } from './Pages'

/** A suggestion: its words, and where the user goes on typing, if they finish it (the "…"). */
interface Suggestion {
  icon: IconName
  text: string
}

/** Where the chat starts: what the next question goes with, as the composer shows it. */
export interface StartContext {
  /** The page open in the tab, while it goes with the question. */
  page?: OpenPage
  /** The tab shows a Notion page, which the user took off the question. */
  removed: boolean
  /** The user added pages to the question by hand. */
  added: boolean
  mode?: Mode
}

interface StartSet {
  heading: string
  /** What Notico can do here; a quoted page title is the page's. */
  line: string
  suggestions: Suggestion[]
  note?: string
}

const quoted = (page: OpenPage) => `“${titleOf(page)}”`

/**
 * The suggestions at the start of a chat, chosen from what the composer already knows: the open
 * page, whether it is a database, and the mode. Fixed sets: no model call, no Notion request.
 */
function startSet({ page, removed, added, mode }: StartContext): StartSet {
  const readOnly = mode === 'read_only'
  if (!page) {
    const suggestions: Suggestion[] = [
      { icon: 'search', text: 'Find the page about …' },
      { icon: 'list', text: "What's in my workspace?" },
      { icon: 'question', text: 'Which of my pages mention …' },
    ]
    if (removed)
      return {
        heading: 'What are you looking for?',
        line: added
          ? 'The open page is off the question: Notico works from the pages you added and your workspace.'
          : 'No page goes with the question, so Notico works from your whole workspace.',
        suggestions,
      }
    return {
      heading: 'What are you looking for?',
      line: "This tab isn't a Notion page.",
      suggestions,
      note: readOnly
        ? 'Open a Notion page to search your workspace or ask about a page.'
        : 'Open a Notion page to search your workspace, or to summarize or edit a page.',
    }
  }
  const summarize: Suggestion = { icon: 'summary', text: `Summarize "${titleOf(page)}"` }
  const related: Suggestion = { icon: 'search', text: 'Find pages related to it' }
  const readOnlyLine = `Read only: Notico reads ${quoted(page)} and your workspace, and changes nothing.`
  if (page.database)
    return readOnly
      ? {
          heading: 'What do you want to know?',
          line: readOnlyLine,
          suggestions: [
            summarize,
            { icon: 'clock', text: 'Which entries changed this week?' },
            { icon: 'columns', text: 'Count the entries by status' },
          ],
        }
      : {
          heading: 'What should we do with this database?',
          line: `Notico can query and update ${quoted(page)} and search your workspace.`,
          suggestions: [
            summarize,
            { icon: 'clock', text: 'Which entries changed this week?' },
            { icon: 'columns', text: 'Count the entries by status' },
            { icon: 'plus', text: 'Add an entry for …' },
          ],
        }
  return readOnly
    ? {
        heading: 'What do you want to know?',
        line: readOnlyLine,
        suggestions: [
          summarize,
          { icon: 'todo', text: 'List its action items and who owns them' },
          { icon: 'question', text: 'What questions does it leave open?' },
          related,
        ],
      }
    : {
        heading: 'What should we do with this page?',
        line: `Notico can read and edit ${quoted(page)} and search your workspace.`,
        suggestions: [
          summarize,
          { icon: 'todo', text: 'Turn its action items into a to-do list' },
          { icon: 'pencil', text: 'Rewrite it to be clearer and shorter' },
          related,
        ],
      }
}

/**
 * The start of a chat: Notico's icon, what it can do here, and suggestions that fit. Picking one
 * gives `onPick` the text for the message box and where the caret goes: where a "…" was, for the
 * user to finish it, or else at the end.
 */
export function ChatStart({
  context,
  onPick,
}: {
  context: StartContext
  onPick: (text: string, caret: number) => void
}) {
  const { heading, line, suggestions, note } = startSet(context)
  return (
    <div className="empty">
      <div className="empty-head">
        <img className="product-icon" src={noticoIcon} alt="" />
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
      {note && (
        <p className="empty-note">
          <Icon name="info" />
          {note}
        </p>
      )}
    </div>
  )
}
