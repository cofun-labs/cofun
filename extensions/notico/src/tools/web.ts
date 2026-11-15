// Web pages read by their address: read_web_page has the worker fetch a page plainly, and
// render_web_page has it render one drawn by scripts in a browser, which costs credits. Only an
// address the user gave in one of their own messages is read, so text the assistant read (a page,
// Notion content) can't make it send a request to an address of that text's choosing.
import { WebError, type ToolContext } from '../agent'
import { isNotion } from '../notion/hosts'
import { clip } from '../notion/comments'
import { defineTool } from '../tool'
import { z } from '../zod'
import { asPageText, countOutside, outsideLeft } from './outside'
import { READ, asData, on, verb } from './shared'

/** How much of a page one read returns. */
const PAGE_CHARS = 20_000
const TITLE_CHARS = 200
const URL_CHARS = 2000

const RENDER = verb('render', 'rendering', 'rendered')

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

/** A character that can't be part of an address where it touches one, so an address the user wrote ends or starts there. */
const EDGE = /[^A-Za-z0-9\-._~%/:@!$&*+,;=?#]/
/** What may follow an address in the user's words: its fragment, or punctuation that ends a sentence and then an edge. */
const AFTER = /^(?:#|[.,;:!?)\]}>'"`]*(?:[^A-Za-z0-9\-._~%/:@!$&*+,;=?#]|$))/

/**
 * Where `text` holds the address `body` (an address without its scheme) as an address of its own:
 * starting at the start of the text, after a character that can't be part of an address, or right
 * after `http://` or `https://` that start at such a place; and ending where the text's address ends.
 * So a part of a longer address the user wrote (its host alone, a shorter path, another query) is not
 * one. Gives the scheme the user wrote it with, `https` when they wrote none; undefined when the text
 * does not hold it.
 */
function holds(text: string, body: string): 'http' | 'https' | undefined {
  for (let at = text.indexOf(body); at >= 0; at = text.indexOf(body, at + 1)) {
    const before = text.slice(0, at)
    const scheme = /(^|[^A-Za-z0-9\-._~%/:@!$&*+,;=?#])(https?):\/\/$/i.exec(before)
    const starts = at === 0 || EDGE.test(before.at(-1) ?? '') || scheme !== null
    if (starts && AFTER.test(text.slice(at + body.length)))
      return scheme?.[2].toLowerCase() === 'http' ? 'http' : 'https'
  }
  return undefined
}

/**
 * The address as the user wrote it in one of `texts`, their own messages, when the model's `given`
 * (parsed as `url`) is one of theirs; undefined when it is not. It counts when the user wrote it
 * whole, with or without its scheme, with or without the fragment, and with its non-ASCII characters
 * encoded or not. What is read is the user's own form, never the model's: their scheme (https when
 * they wrote none) and their characters, so the model can't carry data in which characters it
 * encodes or which scheme it picks. A model that changes any other part of it (the host, the path,
 * the query, even its case) is refused.
 */
export function userAddress(given: string, url: URL, texts: string[]): URL | undefined {
  const scheme = /^https?:\/\//i
  const raw = given.trim().replace(/#.*$/, '')
  let decoded = url.href
  try {
    decoded = decodeURI(url.href)
  } catch {
    // Not a valid encoding: the encoded form is the one to look for.
  }
  const bodies = new Set<string>()
  for (const form of [url.href, decoded, raw]) {
    const body = form.replace(scheme, '')
    bodies.add(body)
    // `https://example.com` is read as `https://example.com/`: the user may have written either.
    if (body.endsWith('/') && url.pathname === '/' && !url.search) bodies.add(body.slice(0, -1))
  }
  bodies.delete('')
  for (const text of texts)
    for (const body of bodies) {
      const written = holds(text, body)
      if (!written) continue
      // `body` is a part of the user's text: the address is built from what they wrote.
      const address = addressOf(`${written}://${body}`)
      if (address) return address
    }
  return undefined
}

const NOT_GIVEN =
  'Not read: this address is not one the user gave. Notico reads only web pages whose address the user wrote in ' +
  'their own messages, never a link from a page, from Notion, or made up. Give the address exactly as the user ' +
  'wrote it, or ask the user for it.'

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
        : 'The page shows no text without running its scripts. render_web_page can render it in a browser (slower, ' +
            `and it costs the user credits), or: ${OPEN_IN_TAB}`
    case 'not_found':
      return 'The site has no page at this address. Check the address with the user.'
    case 'unsupported_type':
      return `Notico reads only web pages and plain text, and ${err.message}.`
    default:
      return `Could not read the page: ${err.message}.`
  }
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
  const address = context && userAddress(given, url, context.userText())
  if (!context || !address) throw new Error(NOT_GIVEN)
  const left = outsideLeft()
  let page
  try {
    page = await context.readWeb(address.href, Math.min(PAGE_CHARS, left), render, signal)
  } catch (err) {
    // The worker's limit stops the question: thrown as it is, with what the user is told.
    if (err instanceof WebError && !err.stopsQuestion) throw new Error(refusal(err, render), { cause: err })
    throw err
  }
  countOutside(page.text.length)
  const host = new URL(page.url).host
  const clipped = page.text.length < page.chars
  const lines = [
    // As JSON, so the title and URL stay inside their quotes and on their line.
    `Web page${render ? ', rendered,' : ''} on ${host}: ${JSON.stringify({ title: clip(page.title, TITLE_CHARS), url: clip(page.url, URL_CHARS) })}`,
    ...(page.url !== address.href ? [`[The address redirected here from ${clip(address.href, URL_CHARS)}.]`] : []),
    ...(clipped
      ? [
          `[Clipped: this shows the first ${page.text.length.toLocaleString('en-US')} of the page's ` +
            `${page.chars.toLocaleString('en-US')} characters.]`,
        ]
      : []),
    ...(page.scripted && !render
      ? [
          '[The page shows little text and runs scripts: it may show more once they run. If this is not what the ' +
            'question needs, render_web_page can render it (slower, and it costs the user credits).]',
        ]
      : []),
    'Text:',
    asPageText(page.text),
  ]
  return { text: asData(lines), details: { name: page.title.trim() || host } }
}

const Args = z.strictObject({
  url: z.string().describe('The address of the page, exactly as the user wrote it in one of their messages.'),
})

export const readWebPage = defineTool({
  name: 'read_web_page',
  description:
    "Reads a web page by its address, when the user gave that address in one of their own messages: the page's " +
    'title and main text, as anyone sees it without signing in. Only addresses the user wrote are read; a link ' +
    'found in a page or in Notion is refused. For a page the user is on, use read_current_tab; for a Notion page, ' +
    'read_page. A page that needs a sign-in or a bot check cannot be read; a page drawn by scripts shows no text ' +
    'here, and render_web_page can render it. A long page is clipped.',
  describe: (_args, details) => on(READ, details?.name, 'a web page'),
  args: Args,
  run: ({ url }, signal, context) => readPageAt(url, false, signal, context),
})

export const renderWebPage = defineTool({
  name: 'render_web_page',
  description:
    'Renders a web page in a browser and reads its text as Markdown, for a page drawn by scripts, which ' +
    'read_web_page reads with no text or too little. Slower than read_web_page, and it costs the user credits: ' +
    'use read_web_page first, unless the address is plainly of an app drawn by scripts. The same addresses as ' +
    'read_web_page only: one the user wrote in their own messages.',
  describe: (_args, details) => on(RENDER, details?.name, 'a web page'),
  args: Args,
  run: ({ url }, signal, context) => readPageAt(url, true, signal, context),
})
