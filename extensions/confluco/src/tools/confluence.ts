import { readPage, searchPages, SearchArgs } from '../confluence/api'
import { getInstance } from '../confluence/instance'
import { defineTool } from '../tool'
import { z } from '../zod'
import { withText } from './results'
import { asData, clip, on, quote, READ, SEARCH } from './shared'

export const readConfluencePage = defineTool({
  name: 'read_page',
  args: z.strictObject({}),
  description:
    'Reads the published Confluence page open in the current tab on the connected self-managed site. Returns its text, title and source link.',
  describe: (_args, details) => on(READ, details?.name, 'the current Confluence page'),
  run: async (_args, signal, context) => {
    const page = await readPage(context.accountId ? await getInstance(context.accountId) : undefined, signal)
    return withText(
      [`Published Confluence page: ${quote({ title: page.title, url: page.url })}`],
      { ...page, tool: 'read_page', markdown: false, chars: page.text.length },
      clip(page.title, 120),
      context,
    )
  },
})

export const searchConfluencePages = defineTool({
  name: 'search_pages',
  args: SearchArgs,
  description:
    'Finds published Confluence pages by title or text on the connected self-managed site, using the current tab. Returns excerpts and source links.',
  describe: (args) => on(SEARCH, args && clip(args.query, 120), 'Confluence pages'),
  run: async (args, signal, { accountId }) => {
    const results = await searchPages(accountId ? await getInstance(accountId) : undefined, args, signal)
    return { text: asData([JSON.stringify(results)]), details: { name: clip(args.query, 120) } }
  },
})
