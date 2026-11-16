// What the start of a Notico chat says and suggests (see Product.start), chosen from what the
// composer already knows: the open Notion page, whether it is a database, and the mode.
import type { ChatStartSet, StartContext, Suggestion } from '../../src/product'
import { titleOf, type OpenPage } from '../../src/tools'

const quoted = (page: OpenPage) => `“${titleOf(page)}”`

/** Fixed sets: no model call, no Notion request. A quoted page title is the page's. */
export function start({ page, removed, added, mode }: StartContext): ChatStartSet {
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
