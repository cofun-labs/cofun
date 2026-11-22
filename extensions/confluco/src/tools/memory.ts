import type { QuestionPage } from '@cofun/agent'
import type { SearchContinuation } from '../confluence/api'
import type { CloudDiscussionPosition } from '../confluence/cloud-inspection'
import type { CapturedTab, ConfluenceTab } from '../confluence/tab'

/** A write resolves its target from the browser state at submission, never from later tab switches. */
export interface ConfluenceQuestion {
  /** The active tab when the question was sent. */
  captured: Promise<CapturedTab | undefined>
  /** That tab as a Confluence site, once Confluco may use the site (see target in target.ts). */
  tab: Promise<ConfluenceTab | undefined>
}

export type ConfluenceContinuation = SearchContinuation | { comments: CloudDiscussionPosition }

/** State the tools need while the agent is answering a conversation. */
export class ToolMemory {
  tabs: ReadonlyMap<number, QuestionPage> = new Map()
  /** References and continuations granted by site results in the current question. */
  confluenceResources = new Set<string>()
  nextConfluencePages = new Map<string, { id: string; continuation: ConfluenceContinuation }>()
  confluenceQuestion?: ConfluenceQuestion

  /** A question starts: what the last one's results granted is forgotten. */
  startQuestion(): void {
    this.nextConfluencePages.clear()
    this.confluenceResources.clear()
  }
}
