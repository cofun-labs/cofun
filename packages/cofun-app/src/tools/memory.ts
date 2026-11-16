import type { QuestionPage } from '../agent'

/** The browsing context carried by one agent. Site tools keep their own cache keyed by this object. */
export class ToolMemory {
  carried: { openPage: boolean; tabs: ReadonlyMap<number, QuestionPage> } = { openPage: true, tabs: new Map() }
}
