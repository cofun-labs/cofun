import { describe, expect, it } from 'vitest'
import { checkUseCases } from '../use-cases.ts'

const TABLE = '| ID | Priority | Status | Scenario |\n| --- | --- | --- | --- |'

function useCase(apiTest: string[], aiE2e: string[] = []) {
  const text = [
    '# UC-CHAT-001: Ask the AI',
    '## Scenarios',
    '### api-test',
    TABLE,
    ...apiTest,
    '### ai-e2e',
    aiE2e.length > 0 ? TABLE : '(none)',
    ...aiE2e,
  ].join('\n')
  return { path: 'docs/use-cases/notico/chat/UC-CHAT-001-ask.md', text }
}

function test(...ids: string[]) {
  return { path: 'worker/test/api.test.ts', text: ids.map((id) => `it('[${id}] does it', () => {})`).join('\n') }
}

describe('checkUseCases', () => {
  it('passes when every ✅ api-test scenario has a test', () => {
    const report = checkUseCases(
      [useCase(['| UC-CHAT-001-S01 | P0 | ✅ | Given …; when …; then … |'], ['| UC-CHAT-001-S02 | P1 | ✅ | … |'])],
      [test('UC-CHAT-001-S01')],
    )
    expect(report).toEqual({ errors: [], warnings: [], scenarios: { 'api-test': 1, 'ai-e2e': 1 } })
  })

  it('fails when a ✅ api-test scenario has no test, naming the file, line, and ID', () => {
    const report = checkUseCases([useCase(['| UC-CHAT-001-S01 | P0 | ✅ | … |'])], [])
    expect(report.errors).toEqual([
      'docs/use-cases/notico/chat/UC-CHAT-001-ask.md:6: UC-CHAT-001-S01 is ✅ api-test, but no test names it',
    ])
  })

  it('is silent about a 🚧 api-test scenario with no test yet', () => {
    const report = checkUseCases([useCase(['| UC-CHAT-001-S01 | P1 | 🚧 | … |'])], [])
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it('warns when a 🚧 api-test scenario already has a test', () => {
    const report = checkUseCases([useCase(['| UC-CHAT-001-S01 | P1 | 🚧 | … |'])], [test('UC-CHAT-001-S01')])
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([
      'docs/use-cases/notico/chat/UC-CHAT-001-ask.md:6: UC-CHAT-001-S01 is 🚧 but has a test (worker/test/api.test.ts:1): mark it ✅',
    ])
  })

  it('warns when a test names an ID no use case has', () => {
    const report = checkUseCases([useCase([])], [test('UC-CHAT-001-S09')])
    expect(report.warnings).toEqual(['worker/test/api.test.ts:1: names UC-CHAT-001-S09, which no use case has'])
  })

  it('warns when an ID is in more than one row', () => {
    const report = checkUseCases(
      [useCase(['| UC-CHAT-001-S01 | P0 | ✅ | … |', '| UC-CHAT-001-S01 | P1 | ✅ | … |'])],
      [test('UC-CHAT-001-S01')],
    )
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([
      'UC-CHAT-001-S01 is in more than one row: docs/use-cases/notico/chat/UC-CHAT-001-ask.md:6, docs/use-cases/notico/chat/UC-CHAT-001-ask.md:7',
    ])
  })

  it('warns when a test names an ai-e2e scenario', () => {
    const report = checkUseCases([useCase([], ['| UC-CHAT-001-S02 | P1 | 🚧 | … |'])], [test('UC-CHAT-001-S02')])
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([
      'docs/use-cases/notico/chat/UC-CHAT-001-ask.md:9: UC-CHAT-001-S02 is ai-e2e, but a test names it (worker/test/api.test.ts:1)',
    ])
  })

  it('fails on a row it cannot read, so a typo cannot hide a scenario from the check', () => {
    const report = checkUseCases(
      [
        useCase(['| UC-CHAT-001-S01 | P0 | done | … |']),
        { path: 'docs/use-cases/x.md', text: `## Scenarios\n${TABLE}\n| UC-CHAT-001-S03 | P0 | ✅ | … |` },
      ],
      [],
    )
    expect(report.errors).toEqual([
      'docs/use-cases/notico/chat/UC-CHAT-001-ask.md:6: UC-CHAT-001-S01 has status "done"; use ✅ or 🚧',
      'docs/use-cases/x.md:4: UC-CHAT-001-S03 is not under an "### api-test" or "### ai-e2e" heading',
    ])
  })
})
