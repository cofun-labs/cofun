// Web pages read by their address: read_web_page has the worker fetch a page plainly, and
// render_web_page has it render one drawn by scripts in a browser, which is slower, costs credits,
// and is limited to a few a minute. The model chooses the address: one the user gave, a link it found, one a search
// found, or one it thinks of (docs/security.md, "Accepted: web pages at any address"). search_web
// has the worker search the web, with a query the model writes (docs/security.md, "Accepted: web
// searches").
import { WebError, type ToolContext } from '../agent'
import { isNotion } from '../notion/hosts'
import { clip } from '../notion/comments'
import { defineTool } from '../tool'
import { z } from '../zod'
import { KEPT_CHARS, withText } from './results'
import { READ, SEARCH, asData, asPageText, count, on, verb } from './shared'

const TITLE_CHARS = 200
const URL_CHARS = 2000

const RENDER = verb('render', 'rendering', 'rendered')

/** Results one search asks for: the most the worker gives. */
const SEARCH_RESULTS = 10
/** The longest query the worker takes. */
const QUERY_CHARS = 1024

/** The address the model gave, as the worker would read it, or undefined when it is not a web address. */
function addressOf(given: string): URL | undefined {
  const raw = given.trim()
  try {
    // A bare host (`example.com/notes`), as people write them, is read over https.
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    url.hash = ''
    return url
  } catch {
    return undefined
  }
}

/** In a tab, the user's own browser shows what a sign-in or a bot check stops the worker from reading. */
const OPEN_IN_TAB =
  'Ask the user to open the page in a tab and ask again there: read_current_tab reads the page they are on.'

/** What the model is told when the worker could not read the page, by the worker's code. */
function refusal(err: WebError, render: boolean): string {
  switch (err.code) {
    case 'not_allowed':
      return `Notico can't read this address: ${err.message}.`
    case 'no_access':
      return `The site would not show the page to Notico, which reads public pages only: it may need a sign-in. ${OPEN_IN_TAB}`
    case 'bot_check':
      return `The site asked for a bot check, so Notico could not read the page. ${OPEN_IN_TAB}`
    case 'no_text':
      return render
        ? `The page shows no text, even rendered. ${OPEN_IN_TAB}`
        : 'The page shows no text without running its scripts. render_web_page can render it in a browser (slower), ' +
            `or: ${OPEN_IN_TAB}`
    case 'not_found':
      return 'The site has no page at this address. Check the address with the user.'
    case 'unsupported_type':
      return `Notico reads only web pages and plain text, and ${err.message}.`
    default:
      // A reason the extension doesn't know, or a worker it could not reach or read: the page was not read.
      return `Could not ${render ? 'render' : 'read'} the page: ${err.message}.`
  }
}

/**
 * What the model is told when the worker could not read a page or search: the reason, and, when it
 * may have cost the user credits, not to `repeat` the call (CLAUDE.md, "Calling outside services").
 */
function failed(reason: string, err: WebError, repeat: string): string {
  return err.charged ? `${reason} It may have cost the user credits: don't ${repeat} again in this question.` : reason
}

/** Reads the page for a tool: checks the address, the question's limit, and turns what was read into the result. */
async function readPageAt(
  given: string,
  render: boolean,
  signal: AbortSignal | undefined,
  context: ToolContext | undefined,
) {
  const url = addressOf(given)
  if (!url) throw new Error('Not read: the address is not a web address (http or https).')
  if (isNotion(url.href)) throw new Error('This is a Notion page: read it with read_page instead.')
  if (!context) throw new Error('Could not read the page: there is no worker to read it with.')
  let page
  try {
    page = await context.readWeb(url.href, KEPT_CHARS, render, signal)
  } catch (err) {
    // A request turned away stops the question: thrown as it is, with what the user is told.
    if (err instanceof WebError && !err.stopsQuestion)
      throw new Error(failed(refusal(err, render), err, 'render this page'), { cause: err })
    throw err
  }
  const host = new URL(page.url).host
  const lines = [
    // As JSON, so the title and URL stay inside their quotes and on their line.
    `Web page${render ? ', rendered,' : ''} on ${host}: ${JSON.stringify({ title: clip(page.title, TITLE_CHARS), url: clip(page.url, URL_CHARS) })}`,
    ...(page.url !== url.href ? [`[The address redirected here from ${clip(url.href, URL_CHARS)}.]`] : []),
    ...(page.scripted && !render
      ? [
          '[The page shows little text and runs scripts: it may show more once they run. If this is not what the ' +
            'question needs, render_web_page can render it (slower).]',
        ]
      : []),
  ]
  const { title, text, chars } = page
  const tool = render ? 'render_web_page' : 'read_web_page'
  // Text as the worker gives it, escaped as text: a render's Markdown is Browser Run's, which does not
  // escape the page's own brackets as the extension's does (asPageMarkdown).
  const read = { tool, title, url: page.url, markdown: false, text, chars }
  return withText(lines, read, page.title.trim() || host, context)
}

const Args = z.strictObject({
  url: z.string().describe('The address of the page (http or https).'),
})

export const readWebPage = defineTool({
  name: 'read_web_page',
  description:
    "Reads a web page by its address: the page's title and main text, as anyone sees it without signing in. " +
    'For a page the user is on, use read_current_tab; for a Notion page, ' +
    'read_page. A page that needs a sign-in or a bot check cannot be read; a page drawn by scripts shows no text ' +
    'here, and render_web_page can render it. A long page is kept on the device and given in parts: its first ' +
    'part comes with an id that read_result and search_result take.',
  describe: (_args, details) => on(READ, details?.name, 'a web page'),
  args: Args,
  run: ({ url }, signal, context) => readPageAt(url, false, signal, context),
})

export const renderWebPage = defineTool({
  name: 'render_web_page',
  description:
    'Renders a web page in a browser and reads its text as Markdown: what the page shows once its scripts run. ' +
    'It reads pages drawn by scripts, which read_web_page reads with no text or too little. It is slower than ' +
    'read_web_page, costs the user credits for the browser time it uses, and only a few pages can be rendered a ' +
    'minute, so read_web_page is usually the better first ' +
    'try; render right away when the page is likely drawn by scripts (a web app, say). A long page is kept and ' +
    'given in parts, as read_web_page does.',
  describe: (_args, details) => on(RENDER, details?.name, 'a web page'),
  args: Args,
  run: ({ url }, signal, context) => readPageAt(url, true, signal, context),
})

const SearchArgs = z.strictObject({
  query: z.string().describe('What to search for, as you would type it into a search engine.'),
})

export const searchWeb = defineTool({
  name: 'search_web',
  description:
    'Searches the web, for current information or sources beyond Notion and the pages the user gave. Gives up to ' +
    `${SEARCH_RESULTS} results, each with its page's URL, title, and a description of the page. To read a result's ` +
    'page in full, use read_web_page with its URL. Each search costs the user credits: search only when the question ' +
    'needs it.',
  describe: (args, details) => {
    const query = details?.name ?? args?.query.trim()
    return query ? { verb: SEARCH, what: 'the web for', name: query } : { verb: SEARCH, what: 'the web' }
  },
  args: SearchArgs,
  run: async ({ query }, signal, context) => {
    const asked = query.trim()
    if (!asked) throw new Error('Not searched: `query` is empty.')
    if (asked.length > QUERY_CHARS)
      throw new Error(
        `Not searched: \`query\` is ${asked.length} characters long; at most ${QUERY_CHARS} are searched.`,
      )
    if (!context) throw new Error('Could not search the web: there is no worker to search with.')
    let results
    try {
      results = await context.searchWeb(asked, SEARCH_RESULTS, signal)
    } catch (err) {
      // A search turned away stops the question: thrown as it is, with what the user is told.
      if (err instanceof WebError && !err.stopsQuestion)
        throw new Error(failed(`Could not search the web: ${err.message}.`, err, 'search for the same query'), {
          cause: err,
        })
      throw err
    }
    const lines = [
      // As JSON, so the query, titles, and URLs stay inside their quotes and on their line.
      `Web search for ${JSON.stringify(clip(asked, QUERY_CHARS))}: ${results.length ? count(results.length, 'result') : 'no results'}.`,
      ...results.flatMap((r, n) => [
        `${n + 1}. ${JSON.stringify({ title: clip(r.title, TITLE_CHARS), url: clip(r.url, URL_CHARS) })}`,
        asPageText(r.description),
      ]),
    ]
    return { text: asData(lines), details: { name: asked } }
  },
})
