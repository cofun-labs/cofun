// What the tools share: their common arguments, how the side panel words a call, and reading the
// pages a call names.
import type { Action, Touched, Verb } from '../tool'
import { z } from '../zod'
import { isNotion, pageIdFromUrl, toUuid } from '../notion/hosts'
import { hexId } from '../notion/markdown'

/** How much of a page one read returns, so a long page doesn't fill the conversation. */
export const PART_CHARS = 12_000

const PART_FROM_1 = '`part` must be a whole number from 1.'
/** Which part of a long result to return: a whole number from 1, the first part when left out. */
export const partArg = (description: string) =>
  z.int({ error: PART_FROM_1 }).min(1, { error: PART_FROM_1 }).describe(description).optional()

/** An optional whole number from `min`, up to `max` when there is one; the refusal names the argument. */
export function wholeArg(name: string, description: string, min: number, max?: number) {
  const error =
    max === undefined
      ? `\`${name}\` must be a whole number of at least ${min}.`
      : `\`${name}\` must be a whole number from ${min} to ${max}.`
  const from = z.int({ error }).min(min, { error })
  return (max === undefined ? from : from.max(max, { error })).describe(description).optional()
}

/** An optional text argument as given; models often fill one with an empty string, which means "not given". */
export const filled = (text: string | undefined): string | undefined => (text?.trim() ? text : undefined)

// How the side panel describes a call (see `Tool.describe`).
export const verb = (base: string, ing: string, past: string): Verb => ({ base, ing, past })
export const READ = verb('read', 'reading', 'read')
export const LIST = verb('list', 'listing', 'listed')
export const EDIT = verb('edit', 'editing', 'edited')
export const CREATE = verb('create', 'creating', 'created')
export const UPDATE = verb('update', 'updating', 'updated')
export const CHANGE = verb('change', 'changing', 'changed')
export const MOVE = verb('move', 'moving', 'moved')
export const DUPLICATE = verb('duplicate', 'duplicating', 'duplicated')
export const SEARCH = verb('search', 'searching', 'searched')
export const ADD = verb('add', 'adding', 'added')
export const LOOK = verb('look at', 'looking at', 'looked at')

/** "1 page", "3 pages". */
export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** The first group of `line` in a result: a name the result gives. Anchor it to the result's first line. */
export function named(result: string | undefined, line: RegExp): string | undefined {
  const name = result?.match(line)?.[1]?.trim()
  return name || undefined
}

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

/** A name a result gives in quotes as `quote` writes it (JSON), read back. */
export function quoted(result: string | undefined, line: RegExp): string | undefined {
  const text = named(result, line)
  if (!text) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'string' && value.trim() ? value : undefined
  } catch {
    return undefined
  }
}

/** A name in quotes as `quote` writes it, for a pattern that reads it back with `quoted`. */
export const QUOTED = '"(?:[^"\\\\]|\\\\.)*"'

/** The action on a thing by its name when known, else on what the fallback words say. */
export function on(verb: Verb, name: string | undefined, fallback: string, what?: string): Action {
  return name ? { verb, what, name } : { verb, what: what ? `${what} ${fallback}` : fallback }
}

/** The id a result names on the line that `line` matches, its first group: a page the call acted on. */
export function idIn(result: string, line: RegExp): string[] {
  const id = result.match(line)?.[1]
  return id ? [id] : []
}

/** Pages given as ids or URLs, as ids; what isn't a page is left out. */
export function idsOf(pages: string[] | undefined): string[] {
  return (pages ?? []).flatMap((p) => {
    const id = pageArg(p)
    return id ? [hexId(id)] : []
  })
}

export const NONE: Touched = {}

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
    /`([^`]*)`|\$(?=\S)((?:\\.|[^$\\\n])+?)(?<=\S)\$(?!\w)|\[((?:\\.|[^\]\\])*)\]\([^)]*\)|@\[((?:\\.|[^\]\\])*)\]|<span color="[^"]*">|<\/span>|\\(.)|[*~]|(?<=^|[\s,(])@(?=\d{4}-\d{2}-\d{2})/g,
    (_, code?: string, equation?: string, link?: string, person?: string, escaped?: string) => {
      if (code !== undefined) return code
      if (equation !== undefined) return equation
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
