import type { QuestionPage } from '../agent/types'

/** State the tools need while the agent is answering a conversation. */
export class ToolMemory {
  tabs: ReadonlyMap<number, QuestionPage> = new Map()
  /** The next page a site actually returned for each search during the current question. */
  nextConfluencePages = new Map<string, number>()
}
