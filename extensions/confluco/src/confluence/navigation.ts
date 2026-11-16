import { z } from '../zod'
import { collection, collectionStart } from './collection'
import { readableText } from './readable-text'
import { pageLink, publishedPage } from './references'
import { requireTab, type ConfluenceTab } from './tab'

const spaceKey = z
  .string()
  .regex(/^(?:~[^\p{C}/\\%;?#]+|[a-zA-Z0-9][a-zA-Z0-9_-]*)$/u)
  .max(255)

export const searchArgs = z.strictObject({
  query: z.string().trim().min(1).max(200).describe('Text to find in published pages.'),
  field: z.enum(['text', 'title']).default('text').describe('Search the full page or only its title.'),
  spaceKey: spaceKey.optional().describe('Restrict the search to this space key.'),
  start: collectionStart,
})
const searchHit = z.object({ content: publishedPage, excerpt: z.string().max(16_000).optional() })
function cqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export async function searchPages(
  input: z.output<typeof searchArgs>,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const spaceFilter = input.spaceKey ? ` AND space = ${cqlString(input.spaceKey)}` : ''
  const cql = `type = page AND ${input.field} ~ ${cqlString(input.query.replace(/\s+/g, ' '))}${spaceFilter}`
  const { items, ...next } = await collection(tab, 'search', { cql }, input.start, searchHit, { signal })
  const results = items.map(({ content, excerpt }) => ({
    ...pageLink(tab.instance, content),
    ...(excerpt && { excerpt: readableText(excerpt.replace(/@@@(?:end)?hl@@@/gi, '')).slice(0, 320) }),
  }))
  return { results, ...next }
}
