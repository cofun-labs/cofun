import type { QuestionPage } from '../agent/types'
import type { SearchContinuation } from '../confluence/api'
import type { CloudCommentJob } from '../confluence/cloud-inspection'
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

export type ConfluenceContinuation = SearchContinuation | { comments: CloudCommentJob[] }

/** State the tools need while the agent is answering a conversation. */
export class ToolMemory {
  tabs: ReadonlyMap<number, QuestionPage> = new Map()
  /** References and continuations granted by site results in the current question. */
  confluenceResources = new Set<string>()
  nextConfluencePages = new Map<string, { id: string; continuation: ConfluenceContinuation }>()
  confluenceQuestion?: ConfluenceQuestion
  confluenceUndo?: ConfluenceUndo
}
