import { isNotion, pageIdFromUrl, toUuid } from '../notion/hosts'
import { hexId } from '../notion/markdown'

export * from '@cofun/app/tools/shared'

/** What a backslash keeps literal in a title, as read_page escapes it (see `inline` in notion/blocks.ts). */
const ESCAPED = '\\`*_~[]^|#><$@'

/**
 * A page title as read_page shows it (inline Markdown, see `inline` in notion/blocks.ts) as the user
 * sees it in Notion: marks dropped, a link or mention as its text, code and escaped characters as
 * they are. For the side panel only; what the model reads keeps the Markdown.
 */
export function plainTitle(markdown: string): string {
  const md = markdown.replace(/<\/?span\b[^>]*>/g, '')
  const word = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c)
  let out = ''
  for (let i = 0; i < md.length; i++) {
    const c = md[i]
    if (c === '\\' && ESCAPED.includes(md[i + 1] ?? '')) {
      out += md[++i]
    } else if (c === '`' && md.indexOf('`', i + 1) > i) {
      const end = md.indexOf('`', i + 1)
      out += md.slice(i + 1, end)
      i = end
    } else if (c === '[' || (c === '@' && md[i + 1] === '[')) {
      // `[Title](id)` and `@[Name]`: the text between the brackets, its own Markdown read too.
      const start = c === '@' ? i + 2 : i + 1
      let end = start
      while (end < md.length && md[end] !== ']') end += md[end] === '\\' ? 2 : 1
      if (end >= md.length) {
        out += c
        continue
      }
      out += plainTitle(md.slice(start, end))
      const target = md[end + 1] === '(' ? md.indexOf(')', end + 2) : -1
      i = target > end ? target : end
    } else if (c === '*' || c === '~' || (c === '_' && !(word(md[i - 1]) && word(md[i + 1])))) {
      // A mark.
    } else out += c
  }
  return out
}

/** Pages given as ids or URLs, as ids; what isn't a page is left out. */
export function idsOf(pages: string[] | undefined): string[] {
  return (pages ?? []).flatMap((p) => {
    const id = pageArg(p)
    return id ? [hexId(id)] : []
  })
}

/**
 * A page id from what the model gave: a Notion URL (with or without `https://`), an id, a page
 * slug ending in its id (`Title-<id>`), or a reference to a page (`^<id>`).
 */
export function pageArg(text: string): string | undefined {
  // `/<id>` is how read_page shows links to pages.
  let value = text
    .trim()
    .replace(/^\^/, '')
    .replace(/^\/(?=[0-9a-f]{32}\b)/i, '')
  if (/^((www\.)?notion\.so|app\.notion\.com)\//i.test(value)) value = `https://${value}`
  // notion.so redirects to www.notion.so, the host Notion's pages live on.
  value = value.replace(/^https:\/\/notion\.so\//i, 'https://www.notion.so/')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return isNotion(value) ? pageIdFromUrl(value) : undefined
  if (value.includes('/')) return undefined
  return toUuid(value) ?? toUuid(/[0-9a-f]{32}$/i.exec(value.replace(/-/g, ''))?.[0] ?? '')
}

/**
 * Markdown as the user reads it: links and people (`@[Ann]`) as their text, no mention marks,
 * colors, marks, or escapes, so filters compare against what Notion shows. Code spans and equations
 * are kept as they are: their text has no escapes (`C:\temp` keeps its backslash). An equation is
 * found as edit_page's parser finds one (see `inline` in notion/blocks.ts), so prices stay text.
 */
export function shownText(markdown: string): string {
  return markdown.replace(
    /`([^`]*)`|\$(?=\S)((?:\\.|[^$\\\n])*?(?:\\.|[^$\\\s]))\$(?!\w)|\[((?:\\.|[^\]\\])*)\]\([^)]*\)|@\[((?:\\.|[^\]\\])*)\]|<span color="[^"]*">|<\/span>|\\(.)|[*~]|(?<=^|[\s,(])@(?=\d{4}-\d{2}-\d{2})/g,
    (_, code?: string, equation?: string, link?: string, person?: string, escaped?: string) => {
      if (code !== undefined) return code
      // As stored: read_page shows a `<br>` in LaTeX as `\<br>`.
      if (equation !== undefined) return equation.replace(/\\(<br\s*\/?>)/gi, '$1')
      const named = link ?? person
      return named !== undefined ? shownText(named) : (escaped ?? '')
    },
  )
}

export const GIVE_PAGE = 'Give `page`: the id read_page shows after "Page:".'

export const TITLE_EMPTY = '`title` must not be empty.'
export const PAGES_LIST = '`pages` must be a list with at least one page.'

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
