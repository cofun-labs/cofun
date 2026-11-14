// node scripts/release-notes.ts <path to CHANGELOG.md> <version> (run by the Release workflow): prints
// that version's changelog entry, which becomes the body of the GitHub Release. Exits 1, printing
// nothing to stdout, when the changelog has no entry for the version: a version is released only
// after its entry is merged. It imports nothing outside Node, so it runs before `pnpm install`.
import { readFileSync } from 'node:fs'
import { changelogEntry } from './changelog.ts'

function fail(message: string): void {
  // In GitHub Actions the message is also shown as an annotation on the run.
  console.error(process.env.GITHUB_ACTIONS === 'true' ? `::error::${message}` : `error: ${message}`)
  process.exitCode = 1
}

const [file, version] = process.argv.slice(2)
if (file === undefined || version === undefined) {
  fail('Usage: node release-notes.ts <path to CHANGELOG.md> <version>')
} else {
  const entry = changelogEntry(readFileSync(file, 'utf8'), version)
  if (entry === undefined) {
    fail(
      `${file} has no entry for version ${version}. ` +
        `Add a "## ${version} (<date>)" section to it through a PR, then run the release again.`,
    )
  } else {
    console.log(entry)
  }
}
