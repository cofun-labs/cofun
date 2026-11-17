import { normalizeSearchText, readPage, searchPages, SearchArgs } from '../confluence/api'
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
    const page = await readPage(await getInstance(context.accountId), signal)
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
    'Finds published Confluence pages by title or text on the connected self-managed site, using the current tab. ' +
    'Use search terms and any space key from the current user message. Ask for search terms when the user did not provide them. ' +
    'Use start only for the next page returned by this same search during this question. Returns excerpts and source links.',
  describe: (args) => on(SEARCH, args && clip(args.query, 120), 'Confluence pages'),
  run: async (args, signal, { accountId, memory, userText }) => {
    const query = normalizeSearchText(args.query)
    if (!normalizeSearchText(userText).includes(query)) {
      throw new Error('Use search terms from the current user message. Ask the user what to search for.')
    }
    if (args.spaceKey && !userText.includes(args.spaceKey)) {
      throw new Error('Use a space key from the current user message or leave it out.')
    }
    const { nextConfluencePages } = memory
    const instance = await getInstance(accountId)
    const key = JSON.stringify([instance?.origin, instance?.path, query, args.field, args.spaceKey])
    if (args.start !== 0 && args.start !== nextConfluencePages.get(key)) {
      throw new Error('Use the next offset returned by the same Confluence search in this question, or omit start.')
    }
    const results = await searchPages(instance, args, signal)
    if ('nextStart' in results && results.nextStart !== undefined) nextConfluencePages.set(key, results.nextStart)
    else nextConfluencePages.delete(key)
    return { text: asData([JSON.stringify(results)]), details: { name: clip(args.query, 120) } }
  },
})
