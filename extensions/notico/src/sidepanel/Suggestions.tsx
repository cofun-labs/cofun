import type { Mode } from '@cofun/agent/mode'
import type { TabKind } from '@cofun/tools'
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
  /** With no Notion page in the tab: what Notico could read there (read_current_tab), a YouTube video or a page. */
  readable?: TabKind
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
function startSet({ page, removed, added, readable, mode }: StartContext): StartSet {
  const readOnly = mode === 'read_only'
  if (!page && removed)
    return {
      heading: 'What are you looking for?',
      line: added
        ? 'The open page is off the question: Notico works from the pages you added and your workspace.'
        : 'No page goes with the question, so Notico works from your whole workspace.',
      suggestions: [
        { icon: 'search', text: 'Find the page about …' },
        { icon: 'list', text: "What's in my workspace?" },
        { icon: 'question', text: 'Which of my pages mention …' },
      ],
    }
  // Another site: Notion's tools run only in a Notion tab, so only the tab and the web are offered.
  if (!page) {
    const web: Suggestion = { icon: 'globe', text: 'Search the web for …' }
    // Read only changes nothing, so it can't save the page either.
    const note = readOnly
      ? 'To search your Notion workspace, open a Notion page in this tab.'
      : 'To search or edit your Notion workspace, open a Notion page in this tab. To save this page to Notion, ' +
        'open the page to save it under, then add this tab with +.'
    if (readable === 'video')
      return {
        heading: 'What do you want to know about this video?',
        line: "This tab isn't a Notion page. Notico can read this video's transcript and search the web.",
        suggestions: [
          { icon: 'summary', text: 'Summarize this video' },
          { icon: 'clock', text: 'List its key moments with their times' },
          { icon: 'question', text: 'What does the video say about …' },
          web,
        ],
        note: readOnly
          ? note
          : 'To search or edit your Notion workspace, open a Notion page in this tab. To save notes on this video ' +
            'to Notion, open the page to save them under, then add this tab with +.',
      }
    return readable
      ? {
          heading: 'What do you want to know about this page?',
          line: "This tab isn't a Notion page. Notico can read it and search the web.",
          suggestions: [
            { icon: 'summary', text: 'Summarize this page' },
            { icon: 'question', text: 'What does this page say about …' },
            { icon: 'list', text: 'List its key points' },
            web,
          ],
          note,
        }
      : {
          heading: 'What are you looking for?',
          line: "Notico can't read this tab, but it can search the web.",
          suggestions: [web],
          note,
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
