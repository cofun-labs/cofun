// Reads one version's entry out of an extension's CHANGELOG.md, for the Release workflow, which
// uses it as the body of the GitHub Release (see release-notes.ts and "Releases" in
// docs/development.md).

/**
 * The text under the `## <version> (<date>)` heading, up to the next `## ` heading or the end of
 * the file, without the heading and the blank lines around the text. The version must be the
 * whole first word of the heading, so 0.1.0 finds neither 0.1.0.1 nor 10.1.0. Returns undefined
 * when the changelog has no such heading, or nothing under it.
 */
export function changelogEntry(changelog: string, version: string): string | undefined {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => headingVersion(line) === version)
  if (start === -1) return undefined
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => headingVersion(line) !== undefined)
  const entry = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
  return entry === '' ? undefined : entry
}

/** The first word of a `## ` heading (the version, in a changelog), or undefined for any other line. */
function headingVersion(line: string): string | undefined {
  if (!line.startsWith('## ')) return undefined
  return line.slice(3).trim().split(/\s+/)[0]
}
