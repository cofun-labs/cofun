// Checks that the use case scenarios and the tests named after them agree (docs/bdd.md).
//
// Each product keeps its use cases next to its code: an extension's in extensions/<name>/use-cases/,
// and the worker's (behavior of the backend alone) in worker/use-cases/. A shared package has none:
// what every extension shares is Webco's. A scenario is matched only against the tests that can
// verify it: its own product's tests and the worker's. A package's tests may name Webco's scenarios
// (more cases of a rule of the shared code, tested where they are cheapest), but don't verify them.
//
// Two rules fail: an api-test scenario marked ✅ must have such a test that names its ID, and every test
// names a scenario ID or says which harm it guards with [@no-uc:<kind>] (docs/bdd.md#what-gets-a-test).
// Everything else the check notices is a warning, for whoever runs it to tidy when it suits them.

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
/** The extension with only what every extension shares, whose scenarios a package's tests may verify too. */
const WEBCO = 'webco'

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
  /** The product whose folder holds the test: an extension's folder name, `packages/<name>`, or `worker`. */
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
  // A package's folder name is lowercase words joined by hyphens: worker-client.
  const pkg = /^packages\/([^/]+)\//.exec(file)
  if (pkg) {
    if (!/^[a-z]+(-[a-z]+)*$/.test(pkg[1])) {
      throw new Error(
        `packages/${pkg[1]}: a package's folder name is lowercase words and hyphens only (docs/bdd.md#ids)`,
      )
    }
    return `packages/${pkg[1]}`
  }
  const extension = /^extensions\/([^/]+)\//.exec(file)
  if (!extension) throw new Error(`${file} is not in an extension's folder, a package's, or the worker's`)
  // The folder name, in capitals, is the product's ID prefix, which may hold letters only.
  if (!/^[a-z]+$/.test(extension[1])) {
    throw new Error(
      `extensions/${extension[1]}: an extension's folder name is lowercase letters only (docs/bdd.md#ids)`,
    )
  }
  return extension[1]
}

/** What a product's IDs start with: its name in capitals, or COFUN for the worker (the platform every extension shares). */
function prefixOf(product: string): string {
  return product === WORKER ? 'COFUN' : product.toUpperCase()
}

function readRows(file: SourceFile, report: Report): Row[] {
  const rows: Row[] = []
  const product = productOf(file.path)
  // A package is implementation, not a product: one of its use cases would be read as no one's.
  if (product.startsWith('packages/')) {
    report.errors.push(
      `${file.path}: a package has no use cases; a rule of what every extension shares is Webco's, in extensions/webco/use-cases/ (docs/bdd.md#products)`,
    )
    return rows
  }
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

/** What a test without a scenario guards against, in `[@no-uc:<kind>]` (docs/bdd.md#what-gets-a-test). */
const NO_UC_KINDS = ['data', 'notion-safety', 'money', 'access', 'privacy', 'contract', 'wiring']
/** A tag at the start of a test's name: a scenario ID, or `@no-uc:` and the kind of harm. */
const NAME_TAG = new RegExp(`^\\[(?:${SCENARIO_ID.replace('(', '(?:')}|@no-uc:([a-z-]*))\\]`)

/**
 * The text of a test file with what can't hold a test blanked out (comments, and the inside of
 * strings, templates, and regular expressions), so `it(` in a comment or a string is no test. Offsets
 * and lines stay where they were; quotes stay, so a name is found where it starts.
 */
function codeOnly(text: string): string {
  const out = text.split('')
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  let previous = ''
  while (i < text.length) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      const to = end === -1 ? text.length : end
      blank(i, to)
      i = to
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const to = end === -1 ? text.length : end + 2
      blank(i, to)
      i = to
    } else if (c === "'" || c === '"' || c === '`' || (c === '/' && startsValue(text, i, previous))) {
      let j = i + 1
      let inClass = false
      while (j < text.length && (text[j] !== c || inClass)) {
        if (text[j] === '\\') j++
        else if (c === '/' && text[j] === '[') inClass = true
        else if (c === '/' && text[j] === ']') inClass = false
        else if (c !== '`' && text[j] === '\n') break
        j++
      }
      blank(i + 1, j)
      previous = c
      i = j + 1
      continue
    } else {
      if (!/\s/.test(c)) previous = c
      i++
    }
  }
  return out.join('')
}

/**
 * Whether a `/` at `i` starts a regular expression, not a division: it does where a value may start,
 * after an operator, an opening bracket, a keyword such as `return` or `of`, or nothing.
 */
function startsValue(text: string, i: number, previous: string): boolean {
  const before = text.slice(Math.max(0, i - 16), i).trimEnd()
  // Not after `<`, which in JSX is a closing tag's (`</p>`), nor after `++` or `--`, which end a value.
  if (/(?:\+\+|--)$/.test(before)) return false
  if (/^$|[(,=:[!&|?{};>+\-*%~^]$/.test(previous)) return true
  return /(?:^|[^\w$.])(?:return|typeof|case|of|in|instanceof|delete|void|throw|new|do|else|yield|await)$/.test(before)
}

/** The offset just after the bracket that closes the one at `i`, in code with its strings blanked. */
function closing(code: string, i: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}', '`': '`' }
  const close = pairs[code[i]]
  if (close === '`') return code.indexOf('`', i + 1) + 1 || code.length
  let depth = 0
  for (let j = i; j < code.length; j++) {
    if (code[j] === code[i]) depth++
    else if (code[j] === close && --depth === 0) return j + 1
  }
  return code.length
}

/**
 * Every test in a file, in every form it may be written in (`it(`, `test(`, `it.only(`,
 * `it.each(…)(`, `it.each`…`(`, in a loop or a callback), but `.skip` and `.todo`: the offset where
 * its name starts, and the name, or `undefined` when it isn't written out as a string. A test is the
 * last call of an `it` or `test` chain, and its name that call's first argument.
 */
function readTests(text: string): { at: number; name: string | undefined }[] {
  const code = codeOnly(text)
  const tests: { at: number; name: string | undefined }[] = []
  for (const match of code.matchAll(/(?<![\w$.])(?:it|test)\b(?=\s*[.(`])/g)) {
    let i = match.index + match[0].length
    let skipped = false
    let lastCall: number | undefined
    for (;;) {
      while (/\s/.test(code[i] ?? '')) i++
      if (code[i] === '.') {
        const word = /^\.\s*(\w+)/.exec(code.slice(i))
        if (!word) break
        if (word[1] === 'skip' || word[1] === 'todo') skipped = true
        i += word[0].length
      } else if (code[i] === '(') {
        lastCall = i
        i = closing(code, i)
      } else if (code[i] === '`') {
        i = closing(code, i)
      } else break
    }
    if (skipped || lastCall === undefined) continue
    let start = lastCall + 1
    while (/\s/.test(code[start] ?? '')) start++
    const quote = text[start]
    if (quote !== "'" && quote !== '"' && quote !== '`') {
      tests.push({ at: start, name: undefined })
      continue
    }
    let end = start + 1
    while (end < text.length && text[end] !== quote) end += text[end] === '\\' ? 2 : 1
    tests.push({ at: start, name: text.slice(start + 1, end) })
  }
  return tests
}

/** Every test's name starts with a scenario ID or a kind of harm it guards; one that does neither fails. */
function checkTestTags(file: SourceFile, report: Report): void {
  for (const { at: offset, name } of readTests(file.text)) {
    const at = `${file.path}:${file.text.slice(0, offset).split('\n').length}`
    const tag = name === undefined ? null : NAME_TAG.exec(name)
    if (tag?.[1] !== undefined && !NO_UC_KINDS.includes(tag[1])) {
      report.errors.push(`${at}: [@no-uc:${tag[1]}] is not a kind of harm; use one of ${NO_UC_KINDS.join(', ')}`)
    } else if (!tag) {
      report.errors.push(
        `${at}: a test whose name starts with no scenario ID and no [@no-uc:<kind>] ` +
          `(${NO_UC_KINDS.join(', ')}), or is not written out; see docs/bdd.md#what-gets-a-test`,
      )
    }
  }
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

/** Whether a test in one product's folder verifies a scenario: its own product's, or any from the worker's tests. */
function verifies(test: TestId, row: Row): boolean {
  return test.product === row.product || test.product === WORKER
}

/**
 * Whether a test may name a scenario: one it verifies, or Webco's from a package's tests, which hold
 * more cases of a rule Webco's own tests show once. Those don't count toward its ✅: only a test
 * through the side panel (or the worker's) does.
 */
function names(test: TestId, row: Row): boolean {
  return verifies(test, row) || (row.product === WEBCO && test.product.startsWith('packages/'))
}

/** Words past which a Behavior section is likely a list of rules, not a few sentences (docs/bdd.md#structure). */
const BEHAVIOR_WORDS = 150

/** Warns when a use case's Behavior, up to its Key constraints or the next heading, runs past BEHAVIOR_WORDS. */
function checkBehavior(file: SourceFile, report: Report): void {
  const behavior = /^## Behavior\n([\s\S]*?)(?=^Key constraints?:|^#)/m.exec(file.text)
  const words = behavior?.[1].split(/\s+/).filter(Boolean).length ?? 0
  if (words > BEHAVIOR_WORDS) {
    report.warnings.push(
      `${file.path}: its Behavior is ${words} words; keep it to a few sentences (docs/bdd.md#structure)`,
    )
  }
}

export function checkUseCases(useCases: SourceFile[], tests: SourceFile[]): Report {
  const report: Report = { errors: [], warnings: [], scenarios: { 'api-test': 0, 'ai-e2e': 0 } }
  for (const file of useCases) checkBehavior(file, report)

  const rows = useCases.flatMap((file) => readRows(file, report))
  const tested = new Map<string, TestId[]>()
  for (const file of tests) {
    for (const [id, found] of readTestIds(file, report)) tested.set(id, [...(tested.get(id) ?? []), ...found])
    checkTestTags(file, report)
  }

  const byId = new Map<string, Row[]>()
  for (const row of rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row])

  for (const row of rows) {
    report.scenarios[row.strategy]++
    const test = tested.get(row.id)?.find((found) => verifies(found, row))?.at
    if (row.strategy === 'api-test') {
      if (row.verified && !test) {
        const named = tested.get(row.id)?.some((found) => names(found, row))
        report.errors.push(
          named
            ? `${row.at}: ${row.id} is ✅ api-test, but only a package's tests name it; a test of Webco's side panel verifies it`
            : `${row.at}: ${row.id} is ✅ api-test, but no test names it`,
        )
      }
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
      if (!(byId.get(id) ?? []).some((row) => names(test, row))) {
        const where =
          test.product === WORKER
            ? 'no use case'
            : test.product.startsWith('packages/')
              ? `no use case of ${WEBCO}`
              : `no use case of ${test.product}`
        report.warnings.push(`${test.at}: names ${id}, which ${where} has`)
        break
      }
    }
  }

  return report
}
