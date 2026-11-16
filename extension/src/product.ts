// What makes this extension the product it is, as the code every product could share reads it: the
// side panel, the agent, and usage data take these from the product's definition (products/notico/product.ts)
// instead of naming Notico, Notion, or the Notion tools themselves. A lint rule (.oxlintrc.json)
// keeps that code from importing the site layer or the site's own tools.
import type { AgentConfig } from './agent'
import type { Tool } from './tool'
import type { FoundPage, OpenPage } from './tools/carry'
import type { ToolMemory } from './tools/memory'

/**
 * Who the product is, light enough for the service worker to import without the tools: what the
 * context menu names it by (products/notico/brand.ts).
 */
export interface ProductBrand {
  /** Lowercase, as the worker's X-Cofun-Client header and usage data name the product: `notico`. */
  readonly id: string
  /** As users read it: `Notico`. */
  readonly name: string
}

export interface Product extends ProductBrand {
  /**
   * The URL of its own icon, the one in the toolbar and the store, which the start of a chat shows;
   * the Cofun mark alone means Cofun.
   */
  readonly icon: string
  /** The site it works on. */
  readonly site: HomeSite
  /** The tools its agent is offered. */
  readonly tools: Tool[]
  /** The system prompt, built from the parts every product shares (src/prompt.ts) and its own. */
  readonly prompt: string
  /** The codes its site's errors carry: usage data sends one for a failed tool only when it is listed here. */
  readonly errorCodes: readonly string[]
}

/**
 * What the side panel asks of the site the product works on: its pages open in the browser, a
 * search for the page picker, links to its pages, the count of each question's requests to it,
 * and saving a reply or a chat as one of its pages.
 */
export interface HomeSite {
  /** As users call it: `Notion`. The notes a question carries name it. */
  readonly name: string
  /** Where links to its pages are made when no tab says which of the site's hosts the user is on. */
  readonly origin: string
  /** Whether a tab at `url` is on the site: such a tab is never offered as a tab on another site. */
  shows(url: string): boolean
  /** The id of the page `url` opens, when it opens one. */
  pageId(url: string): string | undefined
  /** A link to the page `id` on `origin`. */
  pageLink(origin: string, id: string): string
  /** The site's page open in the current tab, if one is, as the tab says: no request to the site. */
  currentPage(): Promise<OpenPage | undefined>
  /** The site's pages open in the browser's tabs, as Chrome reports them: no request to the site. */
  openPages(): Promise<OpenPage[]>
  /**
   * Searches the site for the page picker, from the page open in the current tab: for the user, so
   * no tool runs and the requests count toward no question.
   */
  search(words: string, limit: number, memory: ToolMemory): Promise<FoundPage[]>
  /**
   * How a failed search ends the picker's searches: `busy` when the site turned it away for coming
   * too often, and what stops the question that waits for it, when the failure stops one.
   */
  searchFailed(err: unknown): { busy: boolean; stopsQuestion?: string }
  /** Counts each question's requests to the site (see AgentConfig's `meter`). */
  readonly meter: NonNullable<AgentConfig['meter']>
  /**
   * The tools whose card names the very page the call read or changed: what one of their calls that
   * worked touched is offered as a recent page.
   */
  readonly namesTouchedPage: ReadonlySet<string>
  /** Saving a reply, or a whole chat, as a new page under the page open in the current tab. */
  readonly save: SaveAsPage
}

/** One question and its reply, as a saved page holds them. */
export interface SavedTurn {
  question: string
  /** What the reply wrote, as the model's Markdown, without the tools it ran in between. */
  markdown: string
  /** How many pages the reply's tools read, and the ids of those they changed. */
  read: number
  changed: string[]
}

export interface SaveAsPage {
  /** What the user is told while the current tab shows no page to save under. */
  readonly openAPage: string
  /** The title of a page holding one reply. */
  replyTitle(chat: string, question: string): string
  /** The title of a page holding a whole chat. */
  chatTitle(chat: string): string
  /**
   * Creates a page titled `title` holding `turns` under the page open in the current tab, and
   * returns its link. Sent once, never retried; what it throws says, for the user, what went wrong.
   */
  page(title: string, turns: SavedTurn[]): Promise<{ url: string }>
}
