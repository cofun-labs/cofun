import type { ComponentType } from 'react'
import type { AgentConfig, HistoryMessage } from './agent'
import type { Analytics } from './analytics'
import type { Mode } from './mode'
import type { Tool } from './tool'
import type { OpenPage } from './tools/current'
import type { ToolMemory } from './tools/memory'

/** A site's tab context and the tool to use instead of a public read of its pages. */
export interface PageSite {
  name: string
  readTool: string
  isPage: (url: string) => boolean
  pageId: (url: string) => string | undefined
  currentPage: () => Promise<OpenPage | undefined>
}

export interface StartContext {
  page?: OpenPage
  removed: boolean
  added: boolean
  mode?: Mode
}

export interface SavedTurn {
  question: string
  markdown: string
  read: number
  changed: string[]
}

export interface FoundPage extends OpenPage {
  path?: string
}

/** The workspace actions integrated into the common panel. */
export interface SiteIntegration extends PageSite {
  origin: string
  openPages: () => Promise<OpenPage[]>
  recentPages: (messages: HistoryMessage[], origin: string) => OpenPage[]
  findPages: (words: string, limit: number, memory: ToolMemory) => Promise<FoundPage[]>
  searchError: (error: unknown) => { limited: boolean; stopsQuestion?: string }
  meter?: AgentConfig['meter']
  saveBlocked: string
  save: (title: string, turns: SavedTurn[]) => Promise<{ url: string }>
  chatTitle: (chat: string) => string
  replyTitle: (chat: string, question: string) => string
}

export interface Product {
  id: string
  name: string
  prompt: string
  tools: Tool[]
  Start: ComponentType<{ context: StartContext; onPick: (text: string, at: number) => void }>
  site?: SiteIntegration
  analytics?: Analytics
}
