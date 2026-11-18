// @cofun/tools: the tools every extension can offer, built on @cofun/agent's tool framework (which
// is @cofun/agent's: defineTool), and what they read the web with. An extension passes what is
// particular to it (its name, its own site, its memory of a chat) as parameters, and lists the tools
// it offers itself.
//
// - The site layer for a page in one of the user's tabs (tab.ts, with markdown.ts; imported as
//   `@cofun/tools/tab`, which loads no agent), and for DuckDuckGo, the free web search a user can
//   choose (duckduckgo/, and free-search.ts for the setting).
// - The tools: web pages by their address and web searches (tools/web.ts), the current tab and the
//   tabs the user added (tools/tabs.ts), and the long results they keep (tools/results.ts).
export { allowDuckDuckGo, loadDuckDuckGoSearch, saveDuckDuckGoSearch, withDuckDuckGo } from './free-search'
export { readResult, searchResult, withText } from './tools/results'
export { DATA_LINE, asData, clip, noteTitle, noteUrl, quote } from './tools/shared'
export {
  SELECTION_END,
  addedTabNow,
  addedTabsNote,
  currentTabReadable,
  openWebTabs,
  selectionNotes,
  selectionsCarried,
  tabTools,
  type OwnSite,
  type WebTab,
} from './tools/tabs'
export { webTools } from './tools/web'
