// How a tool call waiting for the user's OK is answered, the same in every extension: it decides
// whether a change to the user's data goes ahead. The side panel only shows the prompt.
import type { ConfirmationAnswer, ConfirmTool, ToolCallRequest } from './types'

type Answer = (allow: ConfirmationAnswer) => void

/**
 * The prompts of one chat, by call id. `show` shows the call as waiting for the user, and returns
 * what to do once it is answered, by the user or by `declineAll`. The agent must never wait on a
 * prompt nobody can see: `show` shows the call even if the panel did not show it yet.
 */
export class ToolPrompts {
  private readonly open = new Map<string, Answer>()

  constructor(private readonly show: (call: ToolCallRequest) => () => void) {}

  /**
   * The confirm of one question, asked with `signal`: once it is aborted, a call is answered no
   * without being shown. `end` drops the answers the question left open, and only those: the next
   * question may reuse an id.
   */
  question(signal: AbortSignal): { confirm: ConfirmTool; end: () => void } {
    const asked = new Map<string, Answer>()
    const confirm: ConfirmTool = (call) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve(false)
        let shown: (() => void) | undefined
        // One answer per prompt: a double click, or Stop racing a click, must not touch a later
        // prompt that reuses this id.
        let done = false
        const answer: Answer = (allow) => {
          if (done) return
          done = true
          if (this.open.get(call.id) === answer) this.open.delete(call.id)
          shown?.()
          resolve(allow)
        }
        asked.set(call.id, answer)
        this.open.set(call.id, answer)
        shown = this.show(call)
      })
    const end = () => {
      for (const [id, answer] of asked) if (this.open.get(id) === answer) this.open.delete(id)
    }
    return { confirm, end }
  }

  /** Answers the prompt of the call `callId`, if it is still waiting for the user. */
  answer(callId: string, allow: ConfirmationAnswer): void {
    this.open.get(callId)?.(allow)
  }

  /** Answers every open prompt with no: the user stopped the question, left the chat, or closed the panel. */
  declineAll(): void {
    for (const answer of [...this.open.values()]) answer(false)
  }
}
