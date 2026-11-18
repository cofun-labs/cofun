// The current tab and the tabs the user added to the chat: @cofun/tools's tab tools, bound to this
// extension's memory of a chat, and the note a question carries about the tabs and the text
// selected on pages that it was sent with.
import { addedTabsNote, selectionNotes, tabTools } from '@cofun/tools'
import type { QuestionPage } from '@cofun/agent'
import type { Selection } from '@cofun/tools/selection'
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
