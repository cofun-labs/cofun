// What makes this extension the product it is, as the code every product could share reads it: the
// side panel, the agent, and usage data take these from the product's definition (src/notico.ts)
// instead of naming Notico, Notion, or the Notion tools themselves.
import type { Tool } from './tool'

export interface Product {
  /** Lowercase, as the worker's X-Cofun-Client header and usage data name the product: `notico`. */
  readonly id: string
  /** As users read it: `Notico`. */
  readonly name: string
  /** The site it works on, as users call it: `Notion`. */
  readonly site: string
  /** The tools its agent is offered. */
  readonly tools: Tool[]
  /** The system prompt, built from the parts every product shares (src/prompt.ts) and its own. */
  readonly prompt: string
  /** The codes its site's errors carry: usage data sends one for a failed tool only when it is listed here. */
  readonly errorCodes: readonly string[]
}
