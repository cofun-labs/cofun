// Checks that the use case scenarios in docs/use-cases and the tests named after them agree (docs/bdd.md).
//
// One rule fails: an api-test scenario marked ✅ must have a test that names its ID. Everything else
// the check notices is a warning, for whoever runs it to tidy when it suits them.

/** A file's path, relative to the repository root, and its text. */
export interface SourceFile {
  path: string
  text: string
}

export interface Report {
  errors: string[]
  warnings: string[]
  /** How many scenario rows were read, by strategy. */
  scenarios: { 'api-test': number; 'ai-e2e': number }
}

type Strategy = 'api-test' | 'ai-e2e'

interface Row {
  id: string
  strategy: Strategy
  verified: boolean
  priority: string
  /** Where the row is: `docs/use-cases/….md:12`. */
  at: string
}

const ROW = /^\|\s*(UC-[A-Z]+-\d+-S\d+)\s*\|([^|]*)\|([^|]*)\|/
/** A table's header (`| ID | Priority | …`) or separator (`| --- | … |`) line. */
const TABLE_FRAME = /^\|\s*ID\s*\||^\|[\s:|-]+$/
const STRATEGY = /^###\s+(api-test|ai-e2e)\s*$/
const TEST_ID = /\[(UC-[A-Z]+-\d+-S\d+)\]/g

function readRows(file: SourceFile, report: Report): Row[] {
  const rows: Row[] = []
  let strategy: Strategy | undefined
  file.text.split('\n').forEach((line, index) => {
    const at = `${file.path}:${index + 1}`
    const heading = STRATEGY.exec(line)
    if (heading) {
      strategy = heading[1] === 'api-test' ? 'api-test' : 'ai-e2e'
      return
    }
    if (line.startsWith('#')) {
      strategy = undefined
      return
    }
    // A row the check can't read would escape it, so these fail rather than warn.
    const row = ROW.exec(line)
    if (!row) {
      if (strategy && line.startsWith('|') && !TABLE_FRAME.test(line.trim())) {
        report.errors.push(`${at}: a row whose ID cell is not a scenario ID like UC-CHAT-001-S01`)
      }
      return
    }
    const id = row[1]
    const priority = row[2].trim()
    const status = row[3].trim()
    if (!strategy) {
      report.errors.push(`${at}: ${id} is not under an "### api-test" or "### ai-e2e" heading`)
      return
    }
    if (status !== '✅' && status !== '🚧') {
      report.errors.push(`${at}: ${id} has status "${status}"; use ✅ or 🚧`)
      return
    }
    rows.push({ id, strategy, verified: status === '✅', priority, at })
  })
  return rows
}

/** Every scenario ID a test file names in brackets, with where it is. */
function readTestIds(file: SourceFile): Map<string, string[]> {
  const ids = new Map<string, string[]>()
  file.text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(TEST_ID)) {
      const at = `${file.path}:${index + 1}`
      ids.set(match[1], [...(ids.get(match[1]) ?? []), at])
    }
  })
  return ids
}

export function checkUseCases(useCases: SourceFile[], tests: SourceFile[]): Report {
  const report: Report = { errors: [], warnings: [], scenarios: { 'api-test': 0, 'ai-e2e': 0 } }

  const rows = useCases.flatMap((file) => readRows(file, report))
  const tested = new Map<string, string[]>()
  for (const file of tests) {
    for (const [id, at] of readTestIds(file)) tested.set(id, [...(tested.get(id) ?? []), ...at])
  }

  const byId = new Map<string, Row[]>()
  for (const row of rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row])

  for (const row of rows) {
    report.scenarios[row.strategy]++
    const at = tested.get(row.id)
    if (row.strategy === 'api-test') {
      if (row.verified && !at) report.errors.push(`${row.at}: ${row.id} is ✅ api-test, but no test names it`)
      if (!row.verified && at) report.warnings.push(`${row.at}: ${row.id} is 🚧 but has a test (${at[0]}): mark it ✅`)
      // P0 must be verified before merge (AGENTS.md); a warning, since a PR may add one on its way there.
      if (!row.verified && !at && row.priority === 'P0') {
        report.warnings.push(`${row.at}: ${row.id} is P0 and 🚧 with no test yet; P0 is verified before merge`)
      }
    } else if (at) {
      report.warnings.push(`${row.at}: ${row.id} is ai-e2e, but a test names it (${at[0]})`)
    }
  }

  for (const [id, same] of byId) {
    if (same.length > 1) report.warnings.push(`${id} is in more than one row: ${same.map((row) => row.at).join(', ')}`)
  }

  for (const [id, at] of tested) {
    if (!byId.has(id)) report.warnings.push(`${at[0]}: names ${id}, which no use case has`)
  }

  return report
}
