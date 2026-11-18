import type { QuestionPage } from '@cofun/agent'
import type { SearchContinuation } from '../confluence/api'
import type { CloudDiscussionPosition } from '../confluence/cloud-inspection'
import type { AttachmentUpload } from '../confluence/attachments'
import type { ConfluenceTab } from '../confluence/tab'
import type { ConfluenceUndo } from '../confluence/undo'

/** A write resolves its target from the browser state at submission, never from later tab switches. */
export interface ConfluenceQuestion {
  tab: Promise<ConfluenceTab | undefined>
  attachment?: AttachmentUpload
  writtenTool?: string
  nextLabel: number
  beforeWrite(): Promise<void>
}

export type ConfluenceContinuation = SearchContinuation | { comments: CloudDiscussionPosition }

/**
 * State the tools need while the agent is answering a conversation. `accountId`: the Cofun account
 * the chat is in, whose connected Confluence site the tools use.
 */
export class ToolMemory {
  constructor(readonly accountId: string) {}

  tabs: ReadonlyMap<number, QuestionPage> = new Map()
  /** References and continuations granted by site results in the current question. */
  confluenceResources = new Set<string>()
  nextConfluencePages = new Map<string, { id: string; continuation: ConfluenceContinuation }>()
  confluenceQuestion?: ConfluenceQuestion
  confluenceUndo?: ConfluenceUndo

  /** A question starts: what the last one's results granted is forgotten. */
  startQuestion(): void {
    this.nextConfluencePages.clear()
    this.confluenceResources.clear()
  }
}
