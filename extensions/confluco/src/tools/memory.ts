import type { QuestionPage } from '../agent/types'

/** Tabs the user added to this conversation, kept by its agent. */
export class ToolMemory {
  tabs: ReadonlyMap<number, QuestionPage> = new Map()
}
