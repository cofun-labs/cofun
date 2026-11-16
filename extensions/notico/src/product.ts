import type { Product } from '@cofun/app/product'
import { identify, loadAnalyticsEnabled, saveAnalyticsEnabled, track } from './analytics'
import { LIMITED_STOP, NotionError } from './notion/api'
import { countNotionRequests } from './notion/tab'
import { NOTICO_PROMPT } from './prompt'
import { ChatStart } from './sidepanel/Suggestions'
import { pagesIn, TOOLS } from './tools'
import { notionPages, openNotionPages } from './tools/current'
import { findPages } from './tools/find'
import { chatTitle, OPEN_A_PAGE, replyTitle, savePage } from './tools/save'

export const notico: Product = {
  id: 'notico',
  name: 'Notico',
  prompt: NOTICO_PROMPT,
  tools: TOOLS,
  Start: ChatStart,
  site: {
    ...notionPages,
    origin: 'https://www.notion.so',
    openPages: openNotionPages,
    recentPages: pagesIn,
    findPages,
    searchError(error) {
      const limited = error instanceof NotionError && error.code === 'rate_limited'
      return {
        limited,
        stopsQuestion: (error instanceof NotionError && error.stopsQuestion) || (limited ? LIMITED_STOP : undefined),
      }
    },
    meter: countNotionRequests,
    saveBlocked: OPEN_A_PAGE,
    save: savePage,
    chatTitle,
    replyTitle,
  },
  analytics: { track, identify, loadEnabled: loadAnalyticsEnabled, saveEnabled: saveAnalyticsEnabled },
}
