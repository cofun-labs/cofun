// Tools the agent can run in the extension.
import type { ToolSpec } from './agent'

/** Returns the title and URL of the tab open in the side panel's window. */
export const getCurrentPage: ToolSpec = {
  name: 'get_current_page',
  description: 'Returns the title and URL of the Notion page open in the current browser tab.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  run: async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.url) throw new Error('No page is open in this window.')
    // Drop a trailing " | Notion" if the tab title has one; the model does not need it.
    const title = (tab.title ?? '').replace(/\s+\|\s+Notion$/, '')
    return { title, url: tab.url }
  },
}

export const TOOLS: ToolSpec[] = [getCurrentPage]
