/**
 * Text (or an object of text) as JSON: quotes, backslashes, and line breaks escaped, so it stays on
 * its line and inside its quotes. JSON leaves Unicode's own line separators as they are; those are
 * escaped too.
 */
export function quote(text: string | Record<string, string>): string {
  return JSON.stringify(text).replace(
    /[\u0085\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/** Text cut to `max` characters, ending with … when cut. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
