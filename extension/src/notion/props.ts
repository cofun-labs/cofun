// Values for a page's title and a database row's properties, from what the model gives to what
// Notion stores, checked against the database's schema before anything is written.
import { MarkdownError, inline, type RichText } from './blocks'
import { formatDate, type Schema } from './markdown'

/** A property value as the model gives it: text, a number, Yes/No, a list of options, or empty. */
export type PropertyInput = string | number | boolean | string[] | null

/** A schema property with what writing it needs. */
export interface PropertyDef {
  name?: string
  type?: string
  options?: { value?: string }[]
}

/** Why a value can't be written; nothing is sent when one is refused. */
export class PropertyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PropertyError'
  }
}

/** Property types whose values Notion computes or keeps elsewhere, or that need ids the model lacks. */
const READ_ONLY = new Set([
  'formula',
  'rollup',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'person',
  'relation',
  'file',
  'button',
  'auto_increment_id',
  'verification',
  'location',
])

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** A title on one line, as Notion keeps it. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Plain text as Notion stores it (a name, a URL), from text the model may have copied out of
 * query_database or read_page: the backslashes their Markdown puts before marks are dropped. A
 * backslash itself is written as two, as tools tell the model.
 */
export function plainText(text: string): string {
  return text.replace(/\\([\\`*~[\]^|<_$@])/g, '$1')
}

/**
 * Markdown as query_database and read_page show a text value or a title, as the rich text Notion
 * stores: the inline Markdown edit_page writes (see `inline`), read as a table cell's. People are
 * still names (see `withPeople`). Markdown that can't be written (an unknown color) is refused.
 */
export function richValue(markdown: string, name = 'The title'): RichText {
  try {
    return cellText(markdown)
  } catch (err) {
    if (err instanceof MarkdownError) throw new PropertyError(`${name}: ${err.message}`)
    throw err
  }
}

/**
 * A table cell's Markdown as rich text. query_database's table writes every `|` as `\|`, in code
 * and equations too, where a backslash is otherwise text: `\|` is read as `|`, as in edit_page's tables.
 */
function cellText(markdown: string): RichText {
  return inline(markdown.replace(/\\\|/g, '|'))
}

/** A link to a page as query_database shows a mention of one: `[Title](<32 hex digits>)`. */
const PAGE_MENTION = /\[((?:\\.|[^\]\\])+)\]\([0-9a-f]{32}\)/gi

/**
 * A text value's or a title's Markdown on one line as the preview shows it: plain text, with
 * people, pages, and dates as their names and no marks. Markdown that can't be written is shown as
 * it is.
 */
export function shownMarkdown(markdown: string): string {
  try {
    // A mentioned page shows by the title its link gives; the rich text keeps only its id.
    return oneLine(cellText(markdown.replace(PAGE_MENTION, '$1')).map(shownRun).join(''))
  } catch (err) {
    if (err instanceof MarkdownError) return oneLine(markdown)
    throw err
  }
}

/** A run of rich text as the preview shows it: a person by name, a date as written, an equation's LaTeX. */
function shownRun([text, marks = []]: RichText[number]): string {
  for (const [mark, arg] of marks) {
    if (mark === 'u') return (arg as { name?: string } | undefined)?.name ?? text
    if (mark === 'd') return formatDate(arg)
    if (mark === 'e') return String(arg)
  }
  return text
}

/**
 * Whether two text values or titles, as Markdown, are stored as the same rich text: the same text
 * with the same formatting, links, and mentions.
 */
export function sameMarkdown(a: string, b: string): boolean {
  try {
    return JSON.stringify(cellText(oneLine(a))) === JSON.stringify(cellText(oneLine(b)))
  } catch (err) {
    if (err instanceof MarkdownError) return false
    throw err
  }
}

/** The schema entry for a property name (any case), as [key, def]. */
export function schemaEntry(schema: Schema, name: string): [string, PropertyDef] {
  const want = name.trim().toLowerCase()
  const found = Object.entries(schema as Record<string, PropertyDef>).find(
    ([key, def]) => (def.name ?? key).toLowerCase() === want,
  )
  if (!found) {
    const names = Object.entries(schema as Record<string, PropertyDef>).map(([key, def]) => def.name ?? key)
    throw new PropertyError(`There is no property “${name}”. The properties are: ${names.join(', ')}.`)
  }
  return found
}

/**
 * The value Notion stores for `input` in a property of this kind. Empty (null or "") clears it.
 * Options must already exist in the schema: Notion's UI would add them, this doesn't. Text and
 * titles are Markdown (see richValue); URLs, emails, and phone numbers are plain text.
 */
export function propertyValue(def: PropertyDef, input: PropertyInput): RichText {
  const name = def.name ?? 'This property'
  const type = def.type ?? 'text'
  if (READ_ONLY.has(type)) throw new PropertyError(`${name} is a ${type.replace(/_/g, ' ')} property; it can't be set.`)
  const text = typeof input === 'string' ? input.trim() : input
  if (text === null || text === '' || (Array.isArray(text) && !text.length)) {
    // An unticked checkbox is stored as No.
    return type === 'checkbox' ? [['No']] : []
  }
  switch (type) {
    case 'title':
      if (typeof text !== 'string') throw new PropertyError(`${name} must be text.`)
      return richValue(oneLine(text), name)
    case 'text':
      if (typeof text !== 'string' && typeof text !== 'number') throw new PropertyError(`${name} must be text.`)
      return typeof text === 'string' ? richValue(text, name) : [[String(text)]]
    case 'url':
    case 'email':
    case 'phone_number':
      if (typeof text !== 'string' && typeof text !== 'number') throw new PropertyError(`${name} must be text.`)
      return [[typeof text === 'string' ? plainText(text) : String(text)]]
    case 'number': {
      const n = typeof text === 'number' ? text : typeof text === 'string' ? Number(text) : Number.NaN
      if (!Number.isFinite(n)) throw new PropertyError(`${name} must be a number, not “${String(input)}”.`)
      return [[String(n)]]
    }
    case 'checkbox': {
      const yes = text === true || (typeof text === 'string' && /^(yes|true)$/i.test(text))
      const no = text === false || (typeof text === 'string' && /^(no|false)$/i.test(text))
      if (!yes && !no) throw new PropertyError(`${name} is a checkbox: give Yes or No.`)
      return [[yes ? 'Yes' : 'No']]
    }
    case 'select':
    case 'status': {
      // An option named 1 may come as the number 1.
      if (typeof text !== 'string' && typeof text !== 'number') throw new PropertyError(`${name} takes one option.`)
      return [[option(def, String(text))]]
    }
    case 'multi_select': {
      const list = Array.isArray(text) ? text : typeof text === 'string' ? text.split(',') : []
      if (!list.length || list.some((v) => typeof v !== 'string'))
        throw new PropertyError(`${name} takes a list of options.`)
      const chosen = [
        ...new Set(
          list
            .map((v) => v.trim())
            .filter(Boolean)
            .map((v) => option(def, v)),
        ),
      ]
      return [[chosen.join(',')]]
    }
    case 'date': {
      if (typeof text !== 'string') throw new PropertyError(`${name} must be a date as YYYY-MM-DD.`)
      const [start, end, ...rest] = text.split(/\s*(?:→|->)\s*/)
      if (
        rest.length ||
        !DATE.test(start) ||
        (end !== undefined && !DATE.test(end)) ||
        !real(start) ||
        (end && !real(end))
      )
        throw new PropertyError(
          `${name} must be a date as YYYY-MM-DD, or a range as YYYY-MM-DD → YYYY-MM-DD, not “${text}”. ` +
            "Times can't be set yet.",
        )
      if (end && end < start) throw new PropertyError(`${name}: the range ends before it starts.`)
      const value = end ? { type: 'daterange', start_date: start, end_date: end } : { type: 'date', start_date: start }
      return [['‣', [['d', value]]]]
    }
    default:
      throw new PropertyError(`${name} is a ${type.replace(/_/g, ' ')} property; it can't be set yet.`)
  }
}

/** The option of a select, status, or multi-select property named `value` (any case). */
function option(def: PropertyDef, value: string): string {
  // As query_database shows it, or with its Markdown escapes undone.
  const wanted = [value.trim(), value.trim().replace(/\\(.)/g, '$1')].map((v) => v.toLowerCase())
  const found = (def.options ?? []).find((o) => wanted.includes((o.value ?? '').toLowerCase()))
  if (!found?.value) {
    const names = (def.options ?? []).map((o) => o.value).filter(Boolean)
    throw new PropertyError(
      `${def.name ?? 'This property'} has no option “${value}”.` +
        (names.length ? ` Its options are: ${names.join(', ')}.` : ' It has no options yet.'),
    )
  }
  return found.value
}

/** Whether a YYYY-MM-DD date exists on the calendar. */
function real(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date
}

/** A value from the model as the preview shows it. */
export function shownInput(input: PropertyInput): string {
  if (input === null || input === '') return '(empty)'
  if (Array.isArray(input)) return input.length ? input.map((v) => oneLine(String(v))).join(', ') : '(empty)'
  return oneLine(String(input))
}

/** A value as propertyValue stores it, on one line as the preview shows it; empty is "". */
export function storedText(def: PropertyDef, value: unknown[]): string {
  const [segment] = value as [string, [string, { start_date?: string; end_date?: string }?][]?][]
  if (!segment) return ''
  const date = segment[1]?.find(([mark]) => mark === 'd')?.[1]
  if (date) return date.end_date ? `${date.start_date} → ${date.end_date}` : String(date.start_date)
  return def.type === 'multi_select' ? segment[0].split(',').join(', ') : oneLine(segment[0])
}
