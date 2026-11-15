// node scripts/release-version.ts <path to CHANGELOG.md> (run by the Release workflow): prints the
// version of the changelog's newest entry, the one a push to main that changes the changelog
// releases. Exits 1, printing nothing to stdout, when the changelog has no entry. It imports nothing
// outside Node, so it runs before `pnpm install`.
import { readFileSync } from 'node:fs'
import { latestVersion } from './changelog.ts'

const [file] = process.argv.slice(2)
const version = file === undefined ? undefined : latestVersion(readFileSync(file, 'utf8'))
if (version === undefined) {
  const message = file === undefined ? 'Usage: node release-version.ts <path to CHANGELOG.md>' : `${file} has no entry.`
  console.error(process.env.GITHUB_ACTIONS === 'true' ? `::error::${message}` : `error: ${message}`)
  process.exitCode = 1
} else {
  console.log(version)
}
