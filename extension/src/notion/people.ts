// Mentions of people: matching the names `@[Name]` gives to the workspace's members, as the
// signed-in user sees them. A mention must name exactly one member, or nothing is written.
import type { NotionClient } from './api'
import { EditError } from './edit'

/** How many members a refusal lists at most. */
const LISTED = 20

/** A name as people are matched by: case, spacing, and Unicode forms don't matter. */
function key(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * The user id of each name, by name. Looks the workspace's members up only when there are names,
 * and refuses with an EditError when a name matches no member or more than one.
 */
export async function findPeople(client: NotionClient, spaceId: string, names: string[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  if (!names.length) return ids
  const people = await client.workspacePeople(spaceId)
  const problems: string[] = []
  for (const name of names) {
    const matches = people.filter((p) => key(p.name) === key(name))
    if (matches.length === 1) ids.set(name, matches[0].id)
    else if (matches.length > 1)
      problems.push(
        `@[${name}]: ${matches.length} workspace members are named “${matches[0].name}”, so a mention can't tell ` +
          'them apart. Write the name as plain text, or ask the user which person they mean.',
      )
    else problems.push(`@[${name}]: no workspace member has that name. ${candidates(name, people)}`)
  }
  if (problems.length) throw new EditError([...problems, 'Nothing was written.'].join('\n'))
  return ids
}

/** Members whose name is like `name`, or else the members there are, for the agent to pick from. */
function candidates(name: string, people: { name: string }[]): string {
  const wanted = key(name)
  const words = wanted.split(' ').filter((w) => w.length > 1)
  const like = people.filter((p) => {
    const k = key(p.name)
    return k.includes(wanted) || wanted.includes(k) || k.split(' ').some((w) => words.includes(w))
  })
  const list = (ps: { name: string }[]) => {
    const names = [...new Set(ps.map((p) => p.name))].sort((a, b) => a.localeCompare(b))
    const shown = names.slice(0, LISTED).map((n) => `“${n}”`)
    return shown.join(', ') + (names.length > LISTED ? `, and ${names.length - LISTED} more` : '')
  }
  if (like.length) return `Members with a similar name: ${list(like)}.`
  if (people.length) return `Members: ${list(people)}.`
  return 'The workspace has no members that can be mentioned.'
}
