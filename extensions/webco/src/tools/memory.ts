import type { QuestionPage } from '@cofun/agent'

/** State the tools need while the agent is answering a conversation: the tabs the user added to it. */
export class ToolMemory {
  tabs: ReadonlyMap<number, QuestionPage> = new Map()
}
