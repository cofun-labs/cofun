// Checks that the use case scenarios and the tests named after them agree (docs/bdd.md).
//
// Each product keeps its use cases next to its code: an extension's in extensions/<name>/use-cases/,
// the worker's (behavior of the backend alone) in worker/use-cases/. A scenario is matched only
// against the tests that can verify it: an extension's scenarios against its own tests and the
// worker's, the worker's scenarios against the worker's tests.
//
// One rule fails: an api-test scenario marked ✅ must have such a test that names its ID. Everything
// else the check notices is a warning, for whoever runs it to tidy when it suits them.

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

/** The worker, whose tests may verify any product's scenarios. */
const WORKER = 'worker'

interface Row {
  id: string
  strategy: Strategy
  verified: boolean
  priority: string
  /** The product whose folder holds the row: an extension's folder name, or `worker`. */
  product: string
  /** Where the row is: `extensions/notico/use-cases/….md:12`. */
  at: string
}

interface TestId {
  /** The product whose folder holds the test: an extension's folder name, or `worker`. */
  product: string
  at: string
}

const SCENARIO_ID = 'UC-([A-Z]+)-[A-Z]+-\\d+-S\\d+'
const ROW = new RegExp(`^\\|\\s*(${SCENARIO_ID})\\s*\\|([^|]*)\\|([^|]*)\\|`)
/** A table's header (`| ID | Priority | …`) or separator (`| --- | … |`) line. */
const TABLE_FRAME = /^\|\s*ID\s*\||^\|[\s:|-]+$/
const STRATEGY = /^###\s+(api-test|ai-e2e)\s*$/
const TEST_ID = new RegExp(`\\[(${SCENARIO_ID})\\]`, 'g')
/** A scenario ID without a product (`UC-{DOMAIN}-{NNN}-S{NN}`), as IDs were before each product got its prefix. */
const OLD_TEST_ID = /\[(UC-[A-Z]+-\d+-S\d+)\]/g

/** The product a use case or test file belongs to, from its folder. */
function productOf(file: string): string {
  if (file.startsWith(`${WORKER}/`)) return WORKER
  const extension = /^extensions\/([^/]+)\//.exec(file)
  if (!extension) throw new Error(`${file} is not in an extension's folder or the worker's`)
  // The folder name, in capitals, is the product's ID prefix, which may hold letters only.
  if (!/^[a-z]+$/.test(extension[1])) {
    throw new Error(
      `extensions/${extension[1]}: an extension's folder name is lowercase letters only (docs/bdd.md#ids)`,
    )
  }
  return extension[1]
}

/** What a product's IDs start with: its name, or COFUN for the worker (the platform every extension shares). */
function prefixOf(product: string): string {
  return product === WORKER ? 'COFUN' : product.toUpperCase()
}

function readRows(file: SourceFile, report: Report): Row[] {
  const rows: Row[] = []
  const product = productOf(file.path)
  let strategy: Strategy | undefined
  file.text.split('\n').forEach((raw, index) => {
    // Markdown still reads a line with leading spaces as a table row or heading.
    const line = raw.trim()
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
      if (strategy && line.startsWith('|') && !TABLE_FRAME.test(line)) {
        report.errors.push(`${at}: a row whose ID cell is not a scenario ID like UC-${prefixOf(product)}-CHAT-001-S01`)
      }
      return
    }
    const [, id, prefix, priorityCell, statusCell] = row
    const priority = priorityCell.trim()
    const status = statusCell.trim()
    if (!strategy) {
      report.errors.push(`${at}: ${id} is not under an "### api-test" or "### ai-e2e" heading`)
      return
    }
    if (status !== '✅' && status !== '🚧') {
      report.errors.push(`${at}: ${id} has status "${status}"; use ✅ or 🚧`)
      return
    }
    if (prefix !== prefixOf(product)) {
      report.warnings.push(`${at}: ${id} is in ${product}'s use cases, so its ID starts with UC-${prefixOf(product)}-`)
    }
    rows.push({ id, strategy, verified: status === '✅', priority, product, at })
  })
  return rows
}

/** A line that names an ID without testing it: a comment, or a skipped or to-do test. */
const NOT_A_TEST = /^\s*(\/\/|\/?\*)|\.(skip|todo)\b/

/** Every scenario ID a test file names in brackets, with where it is. */
function readTestIds(file: SourceFile, report: Report): Map<string, TestId[]> {
  const ids = new Map<string, TestId[]>()
  const product = productOf(file.path)
  file.text.split('\n').forEach((line, index) => {
    if (NOT_A_TEST.test(line)) return
    const at = `${file.path}:${index + 1}`
    for (const match of line.matchAll(TEST_ID)) {
      ids.set(match[1], [...(ids.get(match[1]) ?? []), { product, at }])
    }
    for (const match of line.matchAll(OLD_TEST_ID)) {
      report.warnings.push(
        `${at}: names ${match[1]}, which has no product in it and counts for nothing (IDs are like UC-NOTICO-CHAT-001-S01)`,
      )
    }
  })
  return ids
}

/** Whether a test in one product's folder may verify a scenario of another's: its own, or any from the worker's tests. */
function verifies(test: TestId, row: Row): boolean {
  return test.product === row.product || test.product === WORKER
}

export function checkUseCases(useCases: SourceFile[], tests: SourceFile[]): Report {
  const report: Report = { errors: [], warnings: [], scenarios: { 'api-test': 0, 'ai-e2e': 0 } }

  const rows = useCases.flatMap((file) => readRows(file, report))
  const tested = new Map<string, TestId[]>()
  for (const file of tests) {
    for (const [id, found] of readTestIds(file, report)) tested.set(id, [...(tested.get(id) ?? []), ...found])
  }

  const byId = new Map<string, Row[]>()
  for (const row of rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row])

  for (const row of rows) {
    report.scenarios[row.strategy]++
    const test = tested.get(row.id)?.find((found) => verifies(found, row))?.at
    if (row.strategy === 'api-test') {
      if (row.verified && !test) report.errors.push(`${row.at}: ${row.id} is ✅ api-test, but no test names it`)
      if (!row.verified && test) report.warnings.push(`${row.at}: ${row.id} is 🚧 but has a test (${test}): mark it ✅`)
      // P0 must be verified before merge (AGENTS.md); a warning, since a PR may add one on its way there.
      if (!row.verified && !test && row.priority === 'P0') {
        report.warnings.push(`${row.at}: ${row.id} is P0 and 🚧 with no test yet; P0 is verified before merge`)
      }
    } else if (test) {
      report.warnings.push(`${row.at}: ${row.id} is ai-e2e, but a test names it (${test})`)
    }
  }

  for (const [id, same] of byId) {
    if (same.length > 1) report.warnings.push(`${id} is in more than one row: ${same.map((row) => row.at).join(', ')}`)
  }

  for (const [id, found] of tested) {
    for (const test of found) {
      if (!(byId.get(id) ?? []).some((row) => verifies(test, row))) {
        const where = test.product === WORKER ? 'no use case' : `no use case of ${test.product}`
        report.warnings.push(`${test.at}: names ${id}, which ${where} has`)
        break
      }
    }
  }

  return report
}
