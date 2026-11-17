// Tools the agent can run and how the side panel describes them.
import type { ToolDetails } from '../agent'
import type { Action, Tool } from '../tool'
import {
  browseConfluenceTree,
  getConfluencePageAccess,
  getConfluenceSpace,
  listConfluenceAttachments,
  listConfluenceComments,
  listConfluenceLabels,
  listConfluenceSpaces,
  listConfluenceVersions,
  readConfluencePage,
  readConfluenceVersion,
  searchConfluencePages,
} from './confluence'
import { CONFLUENCE_WRITES } from './confluence-writes'
import { getCurrentTab, readCurrentTab, readTab } from './current'
import { verb } from './shared'
import { readResult, searchResult } from './results'
import { readWebPage, renderWebPage, searchWeb } from './web'

export {
  carryPages,
  currentTabReadable,
  openWebTabs,
  addedTabNow,
  SELECTION_END,
  selectionsCarried,
  type WebTab,
} from './current'
export type { ToolMemory } from './memory'
export { DATA_LINE } from './shared'

const SELF_MANAGED_TOOLS: Tool[] = [
  listConfluenceSpaces,
  getConfluenceSpace,
  browseConfluenceTree,
  listConfluenceVersions,
  readConfluenceVersion,
  getConfluencePageAccess,
  listConfluenceLabels,
  listConfluenceComments,
  listConfluenceAttachments,
  ...CONFLUENCE_WRITES,
]

const CLOUD_TOOLS: Tool[] = [
  readConfluencePage,
  searchConfluencePages,
  getCurrentTab,
  readCurrentTab,
  readTab,
  readWebPage,
  renderWebPage,
  searchWeb,
  readResult,
  searchResult,
]

export const TOOLS = [...CLOUD_TOOLS, ...SELF_MANAGED_TOOLS]
export const CLOUD_TOOL_NAMES: ReadonlySet<string> = new Set(CLOUD_TOOLS.map(({ name }) => name))

/** A call in the user's words, also one from a saved session whose tool is gone. */
export function describeCall(name: string, args: unknown, details?: ToolDetails): Action {
  return (
    TOOLS.find((t) => t.name === name)?.describe(args, details) ?? {
      verb: verb('use', 'using', 'used'),
      what: 'a tool',
    }
  )
}

/** The tools that read a web page, from a tab or by its address; the one that renders it; and the web search. */
const WEB_READS = new Set([readWebPage, renderWebPage, readCurrentTab, readTab].map((tool) => tool.name))
const RENDER = renderWebPage.name
const SEARCH = searchWeb.name

/** What a question's calls that worked did on the web: the pages read (each read counts), how many were rendered, and the searches. */
export function webTouchedBy(calls: { name: string }[]): { read: number; rendered: number; searches: number } {
  const count = (test: (name: string) => boolean) => calls.filter((call) => test(call.name)).length
  return {
    read: count((name) => WEB_READS.has(name)),
    rendered: count((name) => name === RENDER),
    searches: count((name) => name === SEARCH),
  }
}
