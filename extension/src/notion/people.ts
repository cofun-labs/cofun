// Mentions of people: matching the names `@[Name]` gives to the workspace's members, as the
// signed-in user sees them. A mention must name exactly one person, or nothing is written.
import type { NotionClient, NotionRecord } from './api'
import { EditError } from './edit'

/** How many members one refusal lists at most, over all its names. */
const LISTED = 10

/** A name as people are matched by: case, spacing, and Unicode forms don't matter. */
function key(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** People already mentioned (in a block being rewritten): user id by name, or null for a name two of them share. */
export type KnownPeople = Map<string, string | null>

/** The people `title` mentions whose name `users` holds, as read_page shows them. */
export function peopleIn(title: unknown, users: Record<string, NotionRecord> = {}): KnownPeople {
  const known: KnownPeople = new Map()
  if (!Array.isArray(title)) return known
  for (const run of title) {
    if (!Array.isArray(run) || !Array.isArray(run[1])) continue
    for (const mark of run[1] as unknown[][]) {
      const id = mark[0] === 'u' ? String(mark[1]) : undefined
      const name = id ? users[id]?.name : undefined
      if (!id || typeof name !== 'string' || !name.trim()) continue
      const k = key(name)
      known.set(k, known.has(k) && known.get(k) !== id ? null : id)
    }
  }
  return known
}

/**
 * The user id of each name, by name, for each set of names. A name the set's `known` people have
 * (the block being rewritten already mentions them) is that person. The others are looked up among
 * the workspace's members, in one lookup, only if there are any. Refuses with an EditError when a
 * name matches no one or more than one.
 */
export async function findPeople(
  client: NotionClient,
  spaceId: string,
  sets: { names: string[]; known?: KnownPeople }[],
): Promise<Map<string, string>[]> {
  const problems: string[] = []
  const ambiguous = (name: string, who: string) =>
    problems.push(
      `@[${name}]: ${who}, so a mention can't tell them apart. Write the name as plain text, or ask the user ` +
        'which person they mean.',
    )
  const unknown = new Set<string>()
  for (const { names, known } of sets) for (const name of names) if (!known?.has(key(name))) unknown.add(name)
  const people = unknown.size ? await client.workspacePeople(spaceId) : []
  const found = new Map<string, string>()
  const listed = { left: LISTED }
  for (const name of unknown) {
    const matches = people.filter((p) => key(p.name) === key(name))
    if (matches.length === 1) found.set(name, matches[0].id)
    else if (matches.length > 1) ambiguous(name, `${matches.length} workspace members are named “${matches[0].name}”`)
    else problems.push(`@[${name}]: no workspace member has that name. ${candidates(name, people, listed)}`)
  }
  const out = sets.map(({ names, known }) => {
    const ids = new Map<string, string>()
    for (const name of names) {
      const own = known?.get(key(name))
      if (own) ids.set(name, own)
      else if (own === null) ambiguous(name, 'the block mentions more than one person with that name')
      else if (found.has(name)) ids.set(name, found.get(name)!)
    }
    return ids
  })
  if (problems.length) throw new EditError([...new Set(problems), 'Nothing was written.'].join('\n'))
  return out
}

/**
 * Members who share a whole word of their name with `name`, for the agent to pick from, at most
 * `listed.left` more of them. Never the whole list, nor members matched by a letter or two: a
 * refusal mustn't let text in a page have the agent list the workspace's people.
 */
function candidates(name: string, people: { name: string }[], listed: { left: number }): string {
  const words = new Set(key(name).split(' '))
  const like = [
    ...new Set(
      people
        .filter((p) =>
          key(p.name)
            .split(' ')
            .some((w) => words.has(w)),
        )
        .map((p) => p.name),
    ),
  ].sort((a, b) => a.localeCompare(b))
  const shown = like.slice(0, listed.left)
  listed.left -= shown.length
  if (!like.length) return 'No member has a similar name: check the name with the user.'
  if (!shown.length) return 'Some members have a similar name; mention fewer people at once to see them.'
  return `Members with a similar name: ${shown.map((n) => `“${n}”`).join(', ')}${like.length > shown.length ? ', and others' : ''}.`
}
