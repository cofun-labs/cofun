// The current tab and the tabs the user added to the chat: @cofun/tools's tab tools, bound to this
// extension's memory of a chat, and the notes a question carries about the current tab, the tabs and
// the text selected on pages that it was sent with.
import { addedTabsNote, selectionNotes, tabTools } from '@cofun/tools'
import type { QuestionPage } from '@cofun/agent'
import type { Selection } from '@cofun/tools/selection'
import { confluenceOrigin, mayUseSite, type CapturedTab, type ConfluenceTab } from '../confluence/tab'
import type { ToolMemory } from './memory'

export const { getCurrentTab, readCurrentTab, readTab } = tabTools<ToolMemory>({
  product: 'Confluco',
  addedTabs: (memory) => memory.tabs,
})

/** Sets up the tabs the current question can use and describes new context for the model. */
export function carryPages(
  memory: ToolMemory,
  added: QuestionPage[],
  selections: Selection[],
  earlier: QuestionPage[],
): string {
  memory.tabs = new Map([...earlier, ...added].flatMap((page) => (page.tab === undefined ? [] : [[page.tab, page]])))
  const tabs = addedTabsNote(added)
  return [...(tabs ? [tabs] : []), ...selectionNotes(selections)].join('\n')
}

/**
 * The note telling the model whether the tab the question was asked on is a Confluence page, so it
 * picks the Confluence tools or read_current_tab first. Only that fact, never the tab's address or
 * title. `captured` and `tab` are the question's own (see ConfluenceQuestion), so the note and the
 * tools agree. A tab that could be Confluence on a site Confluco may not use yet can't be checked
 * without the user's leave: the note says it may be one, and a Confluence tool asks for the site. When
 * the check itself failed (the tab changed as it ran), there is no note.
 */
export async function currentTabNote(
  captured: Promise<CapturedTab | undefined>,
  tab: Promise<ConfluenceTab | undefined>,
): Promise<string | undefined> {
  const at = await captured
  const origin = at && confluenceOrigin(at)
  if (!origin) return NOT_CONFLUENCE
  try {
    if (await tab) return '[The current tab is a Confluence page.]'
  } catch {
    return undefined
  }
  if (await mayUseSite(origin).catch(() => false)) return NOT_CONFLUENCE
  return '[The current tab may be a Confluence page, on a site Confluco may not use yet.]'
}

const NOT_CONFLUENCE = '[The current tab is not a Confluence page.]'
