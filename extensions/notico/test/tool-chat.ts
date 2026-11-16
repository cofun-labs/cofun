// Runs tools as one chat's agent does, for the tests that call tools directly: every call gets the
// same context and so the same memory (src/tools/memory.ts), and what one call read the next one
// knows. A new ToolChat is another chat, which has read nothing. Nobody can be asked, and there is
// no worker and no store to keep long results in.
import type { ToolContext } from '@cofun/app/agent'
import type { Tool } from '@cofun/app/tool'
import { ToolMemory } from '../src/tools/memory'

export class ToolChat {
  readonly memory = new ToolMemory()
  readonly context: ToolContext = {
    ask: async () => false,
    readWeb: async () => {
      throw new Error('There is no worker in this test.')
    },
    searchWeb: async () => {
      throw new Error('There is no worker in this test.')
    },
    keep: async () => {
      throw new Error('There is no store to keep results in.')
    },
    kept: async () => 'unknown',
    questionChars: () => 0,
    memory: this.memory,
  }

  run(tool: Tool, args: unknown, signal?: AbortSignal) {
    return tool.run(args, signal, this.context)
  }

  preview(tool: Tool, args: unknown) {
    return tool.preview?.(args, this.context)
  }
}
