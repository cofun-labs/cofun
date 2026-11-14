import { describe, expect, it } from 'vitest'
import { changelogEntry } from '../changelog.ts'

const CHANGELOG = [
  '# Changelog',
  '',
  'What changed in each version, newest first.',
  '',
  '## 0.2.0 (2026-12-01)',
  '',
  '### Added',
  '',
  '- Read only mode.',
  '',
  '### Fixed',
  '',
  '- Long pages load.',
  '',
  '## 0.1.0.1 (2026-11-20)',
  '',
  'A fix for the first release.',
  '',
  '## 10.1.0 (2026-11-15)',
  '',
  'Not a real version.',
  '',
  '## 0.1.0 (2026-11-13)',
  '',
  'First release.',
  '',
  '### Added',
  '',
  '- An AI side panel next to Notion.',
  '',
].join('\n')

describe('changelogEntry', () => {
  it('returns the text under the version heading, up to the next version', () => {
    expect(changelogEntry(CHANGELOG, '0.2.0')).toBe(
      ['### Added', '', '- Read only mode.', '', '### Fixed', '', '- Long pages load.'].join('\n'),
    )
  })

  it('returns the last entry in the file, up to its end', () => {
    expect(changelogEntry(CHANGELOG, '0.1.0')).toBe(
      ['First release.', '', '### Added', '', '- An AI side panel next to Notion.'].join('\n'),
    )
  })

  it('returns the last entry of a file that does not end with a newline', () => {
    expect(changelogEntry('## 0.1.0 (2026-11-13)\n\nFirst release.', '0.1.0')).toBe('First release.')
  })

  it('finds only the exact version, not one that starts or ends with it', () => {
    expect(changelogEntry(CHANGELOG, '0.1.0.1')).toBe('A fix for the first release.')
    expect(changelogEntry(CHANGELOG, '10.1.0')).toBe('Not a real version.')
    expect(changelogEntry(CHANGELOG, '0.1')).toBeUndefined()
    expect(changelogEntry(CHANGELOG, '1.0')).toBeUndefined()
  })

  it('does not treat the dots of a version as wildcards', () => {
    expect(changelogEntry('## 0x1y0 (2026-11-13)\n\nNot this one.\n', '0.1.0')).toBeUndefined()
  })

  it('returns undefined when the version has no heading', () => {
    expect(changelogEntry(CHANGELOG, '0.3.0')).toBeUndefined()
    expect(changelogEntry('', '0.1.0')).toBeUndefined()
  })

  it('finds a version only in a heading, not in the text of an entry', () => {
    expect(changelogEntry('## 0.2.0 (2026-12-01)\n\nSince 0.1.0:\n\n### 0.1.0\n', '0.1.0')).toBeUndefined()
  })

  it('returns undefined when nothing is written under the heading', () => {
    expect(
      changelogEntry('## 0.2.0 (2026-12-01)\n\n## 0.1.0 (2026-11-13)\n\nFirst release.\n', '0.2.0'),
    ).toBeUndefined()
  })

  it('reads a heading without a date, and a file with Windows line endings', () => {
    expect(changelogEntry('## 0.2.0\r\n\r\n- One.\r\n- Two.\r\n\r\n## 0.1.0\r\n\r\nFirst.\r\n', '0.2.0')).toBe(
      '- One.\n- Two.',
    )
  })
})
