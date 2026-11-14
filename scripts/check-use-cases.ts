// pnpm use-cases (run by pnpm check): checks the use cases in extensions/*/use-cases and worker/use-cases
// against the tests named after their scenarios (see use-cases.ts and docs/bdd.md). Exits 1 on an
// error; warnings alone exit 0.
import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { type SourceFile, checkUseCases } from './use-cases.ts'

const ROOT = path.resolve(import.meta.dirname, '..')

function read(patterns: string[]): SourceFile[] {
  return globSync(patterns, { cwd: ROOT })
    .sort()
    .map((file) => ({ path: file, text: readFileSync(path.join(ROOT, file), 'utf8') }))
}

const report = checkUseCases(
  read(['extensions/*/use-cases/**/UC-*.md', 'worker/use-cases/**/UC-*.md']),
  read(['worker/test/**/*.test.{ts,tsx}', 'extensions/*/test/**/*.test.{ts,tsx}']),
)

// Use cases lived in docs/use-cases/ before they moved next to their code. One still there, from a
// branch made before the move, would not be read at all, so it fails.
for (const file of globSync('docs/use-cases/**/*.md', { cwd: ROOT }).sort()) {
  report.errors.push(
    `${file}: use cases live in extensions/<name>/use-cases/ and worker/use-cases/ (docs/bdd.md#products)`,
  )
}

for (const warning of report.warnings) console.warn(`warning: ${warning}`)
for (const error of report.errors) console.error(`error: ${error}`)
const { 'api-test': api, 'ai-e2e': e2e } = report.scenarios
console.log(
  `use cases: ${api + e2e} scenarios (${api} api-test, ${e2e} ai-e2e), ` +
    `${report.errors.length} errors, ${report.warnings.length} warnings`,
)
if (report.errors.length > 0) process.exitCode = 1
