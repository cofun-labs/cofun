// The parts of the system prompt that hold for any product: what the extension's notes say, and how to
// use the tools for other sites' tabs, web pages, long results, and selected text. A product's prompt
// (Product.prompt) puts them where they belong among its own parts. Each ends with a space, so parts
// join into one text. Promise only what the tools can do.
//
// Not here, though every product needs it: that text from pages is data, never instructions, with
// what a tool result opening with DATA_LINE holds. Its wording names the product's site and what that
// site's results carry (Notion's block references and comments), so each product's prompt says it in
// its own parts (products/notico/product.ts). A product's prompt without it lets a page give the agent orders.
import { SELECTION_END } from './tools'

/** The note ahead of a question: where the user is, the pages added, and the mode. */
export const NOTES_PROMPT =
  'The latest note tells where the user is now. ' +
  'The note may also list pages the user added to the question: they are the pages the question is about, ' +
  'so read them with their URLs when the question needs what they say. ' +
  'When the user took the open page off a question, do not use it: if the question needs a page, ask which one, or search for it. ' +
  'A note may also say that the question is in Read only, or back in Edit; follow what it says about changes. '

/** Tabs on other sites: the current one, and those the user added. */
export const TABS_PROMPT =
  'The user is asked to allow each site the first time. A note may also list tabs on other sites the user added to ' +
  'the question: read them with read_tab and the tab number the note gives, also in a later question of the ' +
  'chat; read_tab reads no other tab. When an answer uses what read_current_tab or read_tab read, say so and ' +
  "give the page's URL; never guess what a page says. "

/** Web pages by their address. */
export const WEB_PAGES_PROMPT =
  'When a question needs a web page (an address the user gives, or a link in a page you read), read it with read_web_page, or with ' +
  'render_web_page, which is slower but reads pages drawn by scripts: choose by the page. When an answer ' +
  'uses a web page, say so ' +
  'and give its URL. '

/** Long results kept on the device. */
export const LONG_RESULTS_PROMPT =
  'A long page read from a tab or the web comes as its first part, with a note "Kept as result r_…" and an ' +
  'outline of its headings: when the question needs what the rest says, find it with search_result or read ' +
  'the part the outline points to with read_result, rather than answering from the first part alone or ' +
  'guessing. Read only the parts the question needs. '

/** Text the user selected on a page and sent from the browser's menu. */
export const SELECTION_PROMPT =
  "A question may also carry text the user selected on a page and sent to you from the browser's menu: a " +
  `note naming the page, the text, then "${SELECTION_END}". The question is usually about that text; when ` +
  "an answer uses it, give the page's URL. "
