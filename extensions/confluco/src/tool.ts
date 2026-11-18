// The tool framework (@cofun/agent's defineTool), bound to this extension's memory of a
// conversation (src/tools/memory.ts), so a tool's context has its type.
import { defineTool as define, type Tool as AnyTool, type ToolDefinition } from '@cofun/agent'
import type { ToolMemory } from './tools/memory'
import type { z } from './zod'

export type { Action, Verb } from '@cofun/agent'

/** A tool as this extension has it: what the agent runs, and how the side panel describes a call. */
export type Tool = AnyTool<ToolMemory>

/** Defines a tool from one zod schema of its arguments (see defineTool in @cofun/agent). */
export function defineTool<S extends z.ZodObject>(definition: ToolDefinition<S, ToolMemory>): Tool {
  return define(definition)
}
