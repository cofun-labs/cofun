// Tools the agent can run in the extension.
// The worker's tests import this file too, and their tsconfig has no chrome types.
/// <reference types="chrome" />
import type { ToolSpec } from './agent'
import { isNotion } from './notion'

/**
 * Returns the title and URL of the Notion page open in the side panel's window.
 * Other sites are never reported, so their URLs and titles don't reach the model.
 */
export const getCurrentPage: ToolSpec = {
  name: 'get_current_page',
  description: 'Returns the title and URL of the Notion page open in the current browser tab.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  run: async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || !isNotion(tab.url)) throw new Error('No Notion page is open in this window.')
    // Drop a trailing " | Notion" if the tab title has one; the model does not need it.
    const title = (tab.title ?? '').replace(/\s+\|\s+Notion$/, '')
    return { title, url: tab.url! }
  },
}

export const TOOLS: ToolSpec[] = [getCurrentPage]
