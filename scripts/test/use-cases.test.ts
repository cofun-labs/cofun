import { describe, expect, it } from 'vitest'
import { checkUseCases } from '../use-cases.ts'

const TABLE = '| ID | Priority | Status | Scenario |\n| --- | --- | --- | --- |'

function useCase(apiTest: string[], aiE2e: string[] = []) {
  const text = [
    '# UC-NOTICO-CHAT-001: Ask the AI',
    '## Scenarios',
    '### api-test',
    TABLE,
    ...apiTest,
    '### ai-e2e',
    aiE2e.length > 0 ? TABLE : '(none)',
    ...aiE2e,
  ].join('\n')
  return { path: 'extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md', text }
}

function testIn(path: string, ...ids: string[]) {
  return { path, text: ids.map((id) => `it('[${id}] does it', () => {})`).join('\n') }
}

function test(...ids: string[]) {
  return testIn('worker/test/api.test.ts', ...ids)
}

function workerUseCase(...rows: string[]) {
  const text = ['# UC-COFUN-ADMIN-001: Look up an account', '## Scenarios', '### api-test', TABLE, ...rows].join('\n')
  return { path: 'worker/use-cases/admin/UC-COFUN-ADMIN-001-account.md', text }
}

describe('checkUseCases', () => {
  it('passes when every ✅ api-test scenario has a test', () => {
    const report = checkUseCases(
      [
        useCase(
          ['| UC-NOTICO-CHAT-001-S01 | P0 | ✅ | Given …; when …; then … |'],
          ['| UC-NOTICO-CHAT-001-S02 | P1 | ✅ | … |'],
        ),
      ],
      [test('UC-NOTICO-CHAT-001-S01')],
    )
    expect(report).toEqual({ errors: [], warnings: [], scenarios: { 'api-test': 1, 'ai-e2e': 1 } })
  })

  it('fails when a ✅ api-test scenario has no test, naming the file, line, and ID', () => {
    const report = checkUseCases([useCase(['| UC-NOTICO-CHAT-001-S01 | P0 | ✅ | … |'])], [])
    expect(report.errors).toEqual([
      'extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 is ✅ api-test, but no test names it',
    ])
  })

  it('warns about a P0 🚧 api-test scenario with no test yet', () => {
    const report = checkUseCases([useCase(['| UC-NOTICO-CHAT-001-S01 | P0 | 🚧 | … |'])], [])
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([
      'extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 is P0 and 🚧 with no test yet; P0 is verified before merge',
    ])
  })

  it('reads a row with leading spaces, as Markdown does', () => {
    const report = checkUseCases([useCase(['  | UC-NOTICO-CHAT-001-S01 | P1 | ✅ | … |'])], [])
    expect(report.errors).toEqual([
      'extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 is ✅ api-test, but no test names it',
    ])
  })

  it('does not count an ID named in a comment, or by a skipped or to-do test', () => {
    const tests = {
      path: 'worker/test/api.test.ts',
      text: [
        '// [UC-NOTICO-CHAT-001-S01] is covered below',
        "it.skip('[UC-NOTICO-CHAT-001-S01] does it', () => {})",
        "it.todo('[UC-NOTICO-CHAT-001-S01] does it')",
      ].join('\n'),
    }
    const report = checkUseCases([useCase(['| UC-NOTICO-CHAT-001-S01 | P1 | ✅ | … |'])], [tests])
    expect(report.errors).toEqual([
      'extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 is ✅ api-test, but no test names it',
    ])
  })

  it('is silent about a P1 or P2 🚧 api-test scenario with no test yet', () => {
    const report = checkUseCases([useCase(['| UC-NOTICO-CHAT-001-S01 | P1 | 🚧 | … |'])], [])
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it('warns when a 🚧 api-test scenario already has a test', () => {
    const report = checkUseCases(
      [useCase(['| UC-NOTICO-CHAT-001-S01 | P1 | 🚧 | … |'])],
      [test('UC-NOTICO-CHAT-001-S01')],
    )
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([
      'extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 is 🚧 but has a test (worker/test/api.test.ts:1): mark it ✅',
    ])
  })

  it('warns when a test names an ID no use case has', () => {
    const report = checkUseCases([useCase([])], [test('UC-NOTICO-CHAT-001-S09')])
    expect(report.warnings).toEqual(['worker/test/api.test.ts:1: names UC-NOTICO-CHAT-001-S09, which no use case has'])
  })

  it('warns when an ID is in more than one row', () => {
    const report = checkUseCases(
      [useCase(['| UC-NOTICO-CHAT-001-S01 | P0 | ✅ | … |', '| UC-NOTICO-CHAT-001-S01 | P1 | ✅ | … |'])],
      [test('UC-NOTICO-CHAT-001-S01')],
    )
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([
      'UC-NOTICO-CHAT-001-S01 is in more than one row: extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6, extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:7',
    ])
  })

  it('warns when a test names an ai-e2e scenario', () => {
    const report = checkUseCases(
      [useCase([], ['| UC-NOTICO-CHAT-001-S02 | P1 | 🚧 | … |'])],
      [test('UC-NOTICO-CHAT-001-S02')],
    )
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([
      'extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:9: UC-NOTICO-CHAT-001-S02 is ai-e2e, but a test names it (worker/test/api.test.ts:1)',
    ])
  })

  it('fails on a row it cannot read, so a typo cannot hide a scenario from the check', () => {
    const report = checkUseCases(
      [
        useCase([
          '| UC-NOTICO-CHAT-001-S01 | P0 | done | … |',
          '| `UC-NOTICO-CHAT-001-S02` | P0 | ✅ | … |',
          '| UC-NOTICO-CHAT-001-03 | P0 | ✅ | … |',
        ]),
        { path: 'worker/use-cases/x.md', text: `## Scenarios\n${TABLE}\n| UC-COFUN-CHAT-002-S01 | P0 | ✅ | … |` },
      ],
      [],
    )
    expect(report.errors).toEqual([
      'extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 has status "done"; use ✅ or 🚧',
      'extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:7: a row whose ID cell is not a scenario ID like UC-NOTICO-CHAT-001-S01',
      'extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:8: a row whose ID cell is not a scenario ID like UC-NOTICO-CHAT-001-S01',
      'worker/use-cases/x.md:4: UC-COFUN-CHAT-002-S01 is not under an "### api-test" or "### ai-e2e" heading',
    ])
  })

  it("matches an extension's scenario with its own tests and the worker's", () => {
    const report = checkUseCases(
      [useCase(['| UC-NOTICO-CHAT-001-S01 | P0 | ✅ | … |', '| UC-NOTICO-CHAT-001-S02 | P0 | ✅ | … |'])],
      [testIn('extensions/notico/test/chat.test.ts', 'UC-NOTICO-CHAT-001-S01'), test('UC-NOTICO-CHAT-001-S02')],
    )
    expect(report).toEqual({ errors: [], warnings: [], scenarios: { 'api-test': 2, 'ai-e2e': 0 } })
  })

  it("does not match a scenario with another product's tests", () => {
    const report = checkUseCases(
      [
        useCase(['| UC-NOTICO-CHAT-001-S01 | P0 | ✅ | … |']),
        workerUseCase('| UC-COFUN-ADMIN-001-S01 | P0 | ✅ | … |'),
      ],
      [
        testIn('extensions/goodoco/test/chat.test.ts', 'UC-NOTICO-CHAT-001-S01'),
        testIn('extensions/notico/test/admin.test.ts', 'UC-COFUN-ADMIN-001-S01'),
      ],
    )
    expect(report.errors).toEqual([
      'extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 is ✅ api-test, but no test names it',
      'worker/use-cases/admin/UC-COFUN-ADMIN-001-account.md:6: UC-COFUN-ADMIN-001-S01 is ✅ api-test, but no test names it',
    ])
    expect(report.warnings).toEqual([
      'extensions/goodoco/test/chat.test.ts:1: names UC-NOTICO-CHAT-001-S01, which no use case of goodoco has',
      'extensions/notico/test/admin.test.ts:1: names UC-COFUN-ADMIN-001-S01, which no use case of notico has',
    ])
  })

  it("warns when an ID's prefix does not match the product whose folder holds it", () => {
    const report = checkUseCases(
      [
        useCase(['| UC-COFUN-CHAT-001-S01 | P1 | 🚧 | … |']),
        workerUseCase('| UC-NOTICO-ADMIN-001-S01 | P1 | 🚧 | … |'),
      ],
      [],
    )
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([
      "extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-COFUN-CHAT-001-S01 is in notico's use cases, so its ID starts with UC-NOTICO-",
      "worker/use-cases/admin/UC-COFUN-ADMIN-001-account.md:6: UC-NOTICO-ADMIN-001-S01 is in worker's use cases, so its ID starts with UC-COFUN-",
    ])
  })

  it('warns when a test names an ID without its product, which counts for nothing', () => {
    const report = checkUseCases([useCase(['| UC-NOTICO-CHAT-001-S01 | P1 | ✅ | … |'])], [test('UC-PAGES-001-S01')])
    expect(report.errors).toEqual([
      'extensions/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 is ✅ api-test, but no test names it',
    ])
    expect(report.warnings).toEqual([
      'worker/test/api.test.ts:1: names UC-PAGES-001-S01, which has no product in it and counts for nothing (IDs are like UC-NOTICO-CHAT-001-S01)',
    ])
  })

  it("refuses an extension folder whose name can't be an ID prefix", () => {
    expect(() => checkUseCases([], [testIn('extensions/foo-bar/test/chat.test.ts', 'UC-FOOBAR-CHAT-001-S01')])).toThrow(
      "extensions/foo-bar: an extension's folder name is lowercase letters only (docs/bdd.md#ids)",
    )
  })
})
