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
  return { path: 'extension/products/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md', text }
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
      'extension/products/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 is ✅ api-test, but no test names it',
    ])
  })

  it('warns about a P0 🚧 api-test scenario with no test yet', () => {
    const report = checkUseCases([useCase(['| UC-NOTICO-CHAT-001-S01 | P0 | 🚧 | … |'])], [])
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([
      'extension/products/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 is P0 and 🚧 with no test yet; P0 is verified before merge',
    ])
  })

  it('reads a row with leading spaces, as Markdown does', () => {
    const report = checkUseCases([useCase(['  | UC-NOTICO-CHAT-001-S01 | P1 | ✅ | … |'])], [])
    expect(report.errors).toEqual([
      'extension/products/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 is ✅ api-test, but no test names it',
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
      'extension/products/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 is ✅ api-test, but no test names it',
    ])
  })

  it('is silent about a P1 or P2 🚧 api-test scenario with no test yet', () => {
    const report = checkUseCases([useCase(['| UC-NOTICO-CHAT-001-S01 | P1 | 🚧 | … |'])], [])
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it('warns when a Behavior runs past 150 words, not counting its Key constraints', () => {
    const behavior = (words: number) => ({
      path: 'worker/use-cases/admin/UC-COFUN-ADMIN-001-account.md',
      text: [
        '# UC-COFUN-ADMIN-001: Look up an account',
        '## Behavior',
        'word '.repeat(words),
        'Key constraint:',
        '- a constraint '.repeat(100),
        '## Scenarios',
      ].join('\n'),
    })
    expect(checkUseCases([behavior(150)], []).warnings).toEqual([])
    expect(checkUseCases([behavior(151)], []).warnings).toEqual([
      'worker/use-cases/admin/UC-COFUN-ADMIN-001-account.md: its Behavior is 151 words; keep it to a few sentences (docs/bdd.md#structure)',
    ])
  })

  it('warns when a 🚧 api-test scenario already has a test', () => {
    const report = checkUseCases(
      [useCase(['| UC-NOTICO-CHAT-001-S01 | P1 | 🚧 | … |'])],
      [test('UC-NOTICO-CHAT-001-S01')],
    )
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([
      'extension/products/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 is 🚧 but has a test (worker/test/api.test.ts:1): mark it ✅',
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
      'UC-NOTICO-CHAT-001-S01 is in more than one row: extension/products/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6, extension/products/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:7',
    ])
  })

  it('warns when a test names an ai-e2e scenario', () => {
    const report = checkUseCases(
      [useCase([], ['| UC-NOTICO-CHAT-001-S02 | P1 | 🚧 | … |'])],
      [test('UC-NOTICO-CHAT-001-S02')],
    )
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([
      'extension/products/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:9: UC-NOTICO-CHAT-001-S02 is ai-e2e, but a test names it (worker/test/api.test.ts:1)',
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
      'extension/products/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 has status "done"; use ✅ or 🚧',
      'extension/products/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:7: a row whose ID cell is not a scenario ID like UC-NOTICO-CHAT-001-S01',
      'extension/products/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:8: a row whose ID cell is not a scenario ID like UC-NOTICO-CHAT-001-S01',
      'worker/use-cases/x.md:4: UC-COFUN-CHAT-002-S01 is not under an "### api-test" or "### ai-e2e" heading',
    ])
  })

  it("matches an extension's scenario with its own tests and the worker's", () => {
    const report = checkUseCases(
      [useCase(['| UC-NOTICO-CHAT-001-S01 | P0 | ✅ | … |', '| UC-NOTICO-CHAT-001-S02 | P0 | ✅ | … |'])],
      [testIn('extension/test/chat.test.ts', 'UC-NOTICO-CHAT-001-S01'), test('UC-NOTICO-CHAT-001-S02')],
    )
    expect(report).toEqual({ errors: [], warnings: [], scenarios: { 'api-test': 2, 'ai-e2e': 0 } })
  })

  it("matches any extension product's scenario with the extension's tests", () => {
    const webco = {
      path: 'extension/products/webco/use-cases/chat/UC-WEBCO-CHAT-001-ask.md',
      text: [
        '# UC-WEBCO-CHAT-001: Ask the AI',
        '## Scenarios',
        '### api-test',
        TABLE,
        '| UC-WEBCO-CHAT-001-S01 | P0 | ✅ | … |',
      ].join('\n'),
    }
    const report = checkUseCases(
      [useCase(['| UC-NOTICO-CHAT-001-S01 | P0 | ✅ | … |']), webco],
      [testIn('extension/test/chat.test.ts', 'UC-NOTICO-CHAT-001-S01', 'UC-WEBCO-CHAT-001-S01')],
    )
    expect(report).toEqual({ errors: [], warnings: [], scenarios: { 'api-test': 2, 'ai-e2e': 0 } })
  })

  it("does not match the worker's scenario with the extension's tests", () => {
    const report = checkUseCases(
      [workerUseCase('| UC-COFUN-ADMIN-001-S01 | P0 | ✅ | … |')],
      [testIn('extension/test/admin.test.ts', 'UC-COFUN-ADMIN-001-S01')],
    )
    expect(report.errors).toEqual([
      'worker/use-cases/admin/UC-COFUN-ADMIN-001-account.md:6: UC-COFUN-ADMIN-001-S01 is ✅ api-test, but no test names it',
    ])
    expect(report.warnings).toEqual([
      'extension/test/admin.test.ts:1: names UC-COFUN-ADMIN-001-S01, which no use case of an extension product has',
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
      "extension/products/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-COFUN-CHAT-001-S01 is in notico's use cases, so its ID starts with UC-NOTICO-",
      "worker/use-cases/admin/UC-COFUN-ADMIN-001-account.md:6: UC-NOTICO-ADMIN-001-S01 is in worker's use cases, so its ID starts with UC-COFUN-",
    ])
  })

  it('warns when a test names an ID without its product, which counts for nothing', () => {
    const report = checkUseCases([useCase(['| UC-NOTICO-CHAT-001-S01 | P1 | ✅ | … |'])], [test('UC-PAGES-001-S01')])
    expect(report.errors).toEqual([
      expect.stringContaining('worker/test/api.test.ts:1: a test whose name starts with no scenario ID'),
      'extension/products/notico/use-cases/chat/UC-NOTICO-CHAT-001-ask.md:6: UC-NOTICO-CHAT-001-S01 is ✅ api-test, but no test names it',
    ])
    expect(report.warnings).toEqual([
      'worker/test/api.test.ts:1: names UC-PAGES-001-S01, which has no product in it and counts for nothing (IDs are like UC-NOTICO-CHAT-001-S01)',
    ])
  })

  it('fails on a test whose name starts with neither a scenario ID nor a kind of harm, in any form it is written in', () => {
    const lines: [string, string?][] = [
      ["it('[@no-uc:privacy] logs nothing', () => {})"],
      ['it('],
      ["  '[@no-uc:money] a name the formatter moved to its own line',"],
      ['  () => {},'],
      [')'],
      ["it.each([1, 2])('[@no-uc:data] keeps %s', () => {})"],
      ['it.each(CASES)('],
      ["  '[@no-uc:access] refuses $what',"],
      ['  () => {},'],
      [')'],
      ['it.each(['],
      ["  ['a (b)', \"it's\"],"],
      ["])('[@no-uc:contract] reads %s', () => {})"],
      ['it.each`'],
      ['  a    | b'],
      ['  ${1} | ${2}'],
      ["`('[UC-COFUN-CHAT-001-S01] adds $a and $b', () => {})"],
      ["// it('in a comment is no test')"],
      ['const words = "it(\'in a string is no test\')"'],
      ["it.skip('is skipped, so it is not checked', () => {})"],
      ['it.concurrent(`[@no-uc:privacy] runs with ${others}`, () => {})'],
      ["it('has no tag', () => {})", 'no tag'],
      ["it('[@no-uc:speed] guards a kind that is not one', () => {})", 'speed'],
      ["it('says [@no-uc:data] past the start of its name', () => {})", 'no tag'],
      ["it.each([1])('has no tag either', () => {})", 'no tag'],
      ["it.only('has no tag, though it runs alone', () => {})", 'no tag'],
      ["it.skipIf(slow)('has no tag behind a condition', () => {})", 'no tag'],
      ['for (const c of CASES) it(c.name, () => {})', 'no tag'],
      ['CASES.forEach(([name]) => it(name, () => {}))', 'no tag'],
      ["if (FLAG) it('has no tag behind an if', () => {})", 'no tag'],
      ["describe('a block', () => it('has no tag inside it', () => {}))", 'no tag'],
      ['it.each`'],
      ['  a'],
      ['  ${1}'],
      // A tagged template table's name is on the line that closes it.
      ["`('has no tag after a table', () => {})", 'no tag'],
      // A regular expression after a keyword, with a backtick in it, opens no template.
      ['function quoted(s: string) {'],
      ['  return /`/.test(s)'],
      ['}'],
      ["it('has no tag after a regular expression', () => {})", 'no tag'],
      // A JSX closing tag and `++` are followed by a division, if anything: a template after them is one.
      ['render(<p>hi</p>); const s = `a'],
      ['b`'],
      ["it('has no tag after a closing tag', () => {})", 'no tag'],
      ['const h = i++ / 2, t = `a'],
      ['b`'],
      ["it('has no tag after an increment', () => {})", 'no tag'],
    ]
    const text = lines.map(([line]) => line).join('\n')
    const report = checkUseCases([], [{ path: 'worker/test/api.test.ts', text }])
    const expected = lines.flatMap(([, error], index) => {
      if (!error) return []
      const at = `worker/test/api.test.ts:${index + 1}`
      return [
        error === 'speed'
          ? `${at}: [@no-uc:speed] is not a kind of harm; use one of data, notion-safety, money, access, privacy, contract`
          : expect.stringMatching(new RegExp(`^${at}: a test whose name starts with no scenario ID`)),
      ]
    })
    expect(report.errors).toEqual(expected)
  })

  it("refuses a product folder whose name can't be an ID prefix", () => {
    const useCase = { path: 'extension/products/foo-bar/use-cases/chat/UC-FOOBAR-CHAT-001-ask.md', text: '' }
    expect(() => checkUseCases([useCase], [])).toThrow(
      "extension/products/foo-bar: a product's folder name is lowercase letters only (docs/bdd.md#ids)",
    )
  })
})
