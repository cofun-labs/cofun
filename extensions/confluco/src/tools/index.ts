// Tools the agent can run and how the side panel describes them.
import type { ToolDetails } from '@cofun/agent'
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
import { readResult, searchResult, webTools } from '@cofun/web'
import { getCurrentTab, readCurrentTab, readTab } from './current'
import { verb } from './shared'

export { carryPages } from './current'

const { readWebPage, renderWebPage, searchWeb } = webTools({ product: 'Confluco' })

const READ_TOOLS: Tool[] = [
  readConfluencePage,
  searchConfluencePages,
  listConfluenceSpaces,
  getConfluenceSpace,
  browseConfluenceTree,
  listConfluenceVersions,
  readConfluenceVersion,
  getConfluencePageAccess,
  listConfluenceLabels,
  listConfluenceComments,
  listConfluenceAttachments,
  getCurrentTab,
  readCurrentTab,
  readTab,
  readWebPage,
  renderWebPage,
  searchWeb,
  readResult,
  searchResult,
]

export const TOOLS = [...READ_TOOLS, ...CONFLUENCE_WRITES]

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
