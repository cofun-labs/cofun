// The tool type of @cofun/agent's framework, bound to this extension's memory of a conversation
// (src/tools/memory.ts). Webco defines no tool of its own: its tools are @cofun/tools's.
import type { Tool as AnyTool } from '@cofun/agent'
import type { ToolMemory } from './tools/memory'

export type { Action, Verb } from '@cofun/agent'

/** A tool as this extension has it: what the agent runs, and how the side panel describes a call. */
export type Tool = AnyTool<ToolMemory>
