// Turns the HTML that the script in a tab gives (src/web/tab.ts: the page's main content, with what
// isn't shown already left out and links made absolute) into Markdown, which the Notion write tools
// take, so a page saved to Notion keeps its headings, lists, links, and tables. Runs in the side
// panel, on a document DOMParser makes: an inert one, where no script runs and nothing loads.

import TurndownService from 'turndown'

/** Elements whose content is never part of the text, should the tab have left any in. */
const DROPPED = ['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'head'] as const

/** Whether a table reads as a grid: no table inside it, no cell joined across, and no cell holding blocks. */
const gridOf = new WeakMap<Element, boolean>()
function isGrid(table: Element): boolean {
  let grid = gridOf.get(table)
  if (grid === undefined) {
    grid =
      !table.querySelector('table, h1, h2, h3, h4, h5, h6, ul, ol, pre, blockquote, hr') &&
      ![...table.querySelectorAll('td, th')].some(
        (cell) => Number(cell.getAttribute('colspan') ?? 1) > 1 || Number(cell.getAttribute('rowspan') ?? 1) > 1,
      )
    gridOf.set(table, grid)
  }
  return grid
}

/** The table a part of a table is in, when it is a grid (see isGrid). */
const gridTable = (node: Element) => {
  const table = node.closest('table')
  return table && isGrid(table) ? table : undefined
}

/** A block of its own, as Turndown writes elements it has no rule for. */
const block = (content: string) => `\n\n${content}\n\n`

const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
  strongDelimiter: '**',
  // A line break is a new line, not two spaces at the end of one, which are easy to lose.
  br: '',
})
turndown.remove([...DROPPED])

turndown.addRule('list item', {
  // `- ` and `1. `, as the worker writes them, with what follows a line indented under the marker.
  filter: 'li',
  replacement: (content, node) => {
    const list = node.parentElement
    let marker = '- '
    if (list?.nodeName === 'OL') {
      const start = Number(list.getAttribute('start') ?? 1)
      marker = `${(Number.isFinite(start) ? start : 1) + [...list.children].indexOf(node)}. `
    }
    const body = content
      .replace(/^\n+/, '')
      .replace(/\n+$/, '\n')
      .replace(/\n(?=.)/g, `\n${' '.repeat(marker.length)}`)
    return `${marker}${body}${node.nextElementSibling && !body.endsWith('\n') ? '\n' : ''}`
  },
})

turndown.addRule('image', {
  // Its alt text only: an image's address written into Notion would load where the page is looked at.
  filter: 'img',
  replacement: (_content, node) => turndown.escape((node.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim()),
})

turndown.addRule('link', {
  // The tab kept an address only on links to http(s) pages (see tab.ts); any other is its text.
  filter: (node) => node.nodeName === 'A',
  replacement: (content, node) => {
    const href = node.getAttribute('href') ?? ''
    const text = content.trim()
    if (!/^https?:\/\//i.test(href)) return content
    if (!text) return ''
    // Spaces are encoded already; parentheses would end the address early.
    return `[${text.replace(/\n+/g, ' ')}](${href.replace(/\(/g, '%28').replace(/\)/g, '%29')})`
  },
})

turndown.addRule('code block', {
  // Every pre, with or without a code element in it, fenced longer than any run of backticks it holds.
  filter: 'pre',
  replacement: (_content, node) => {
    // Some pages break a code block's lines with `br` (Medium, some highlighters). The node is the
    // side panel's own parsed copy, so it can be changed.
    for (const br of node.querySelectorAll('br')) br.replaceWith('\n')
    const code = (node.textContent ?? '').replace(/\n$/, '')
    const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((run) => run[0].length))
    const fence = '`'.repeat(Math.max(3, longest + 1))
    const language = /(?:^|\s)lang(?:uage)?-([\w+#-]+)/.exec(
      `${node.getAttribute('class') ?? ''} ${node.querySelector('code')?.getAttribute('class') ?? ''}`,
    )
    return `\n\n${fence}${language?.[1] ?? ''}\n${code}\n${fence}\n\n`
  },
})

// A table that reads as a grid becomes a Markdown table, its first row the header; any other (one
// laid out with tables, say) is its cells' content, one block after another.
turndown.addRule('table cell', {
  filter: ['th', 'td'],
  replacement: (content, node) => {
    if (!gridTable(node)) return block(content)
    // A pipe would end the cell. Only pipes get a backslash: one in the text before it is escaped
    // already (Turndown writes it `\\`), and in a code span GFM reads `\|` as the pipe. A code span
    // with a backslash right before a pipe can't be written in a GFM cell at all: the cell ends there.
    const cell = content
      .replace(/\s*\n+\s*/g, ' ')
      .split('|')
      .join('\\|')
      .trim()
    return `${node.previousElementSibling ? '' : '|'} ${cell} |`
  },
})

turndown.addRule('table row', {
  filter: 'tr',
  replacement: (content, node) => {
    const table = gridTable(node)
    if (!table) return block(content)
    if (table.querySelector('tr') !== node) return `\n${content}`
    // The header sets the columns: one as wide as the widest row, so no row's last cells are lost.
    const widest = Math.max(...[...table.querySelectorAll('tr')].map((row) => row.querySelectorAll('th, td').length))
    const short = widest - node.querySelectorAll('th, td').length
    return `\n${content}${' |'.repeat(short)}\n|${' --- |'.repeat(widest)}`
  },
})

turndown.addRule('table section', {
  filter: ['thead', 'tbody', 'tfoot'],
  replacement: (content, node) => (gridTable(node) ? content : block(content)),
})

turndown.addRule('table caption', {
  // A grid's caption goes above it (see the table rule).
  filter: 'caption',
  replacement: (content, node) => (gridTable(node) ? '' : block(content)),
})

turndown.addRule('table', {
  filter: 'table',
  replacement: (content, node) => {
    if (!isGrid(node)) return block(content)
    const caption = node.querySelector('caption')?.textContent?.replace(/\s+/g, ' ').trim()
    return `${caption ? block(turndown.escape(caption)) : ''}\n\n${content.replace(/^\n+/, '')}\n\n`
  },
})

/** The page's HTML as Markdown, with no more than one empty line in a row. */
export function pageMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return turndown
    .turndown(doc.body)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
