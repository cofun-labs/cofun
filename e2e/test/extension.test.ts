import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXTENSION_NAME, type ExtensionStatus, build, isOurManifest, problem } from '../src/extension'
import { loadState, saveState, statePath } from '../src/state'

const enabled: ExtensionStatus = {
  developerMode: true,
  extension: { state: 'ENABLED', location: 'UNPACKED', path: '/checkout/extension/dist', disableReasons: [] },
}

describe('problem', () => {
  it('finds nothing wrong with an enabled unpacked extension', () => {
    expect(problem(enabled)).toBeUndefined()
  })

  it('says Developer mode is off, and that it must be turned on by hand', () => {
    const status: ExtensionStatus = {
      developerMode: false,
      extension: { ...enabled.extension!, state: 'DISABLED', disableReasons: ['unsupportedDeveloperExtension'] },
    }
    expect(problem(status)).toMatch(/Developer mode is off.*by hand/)
  })

  it('says why the extension is disabled', () => {
    const status: ExtensionStatus = {
      developerMode: true,
      extension: { ...enabled.extension!, state: 'DISABLED', disableReasons: ['corruptInstall'] },
    }
    expect(problem(status)).toBe(
      `${EXTENSION_NAME} is disabled (corruptInstall). Enable it in chrome://extensions by hand.`,
    )
  })

  it('refuses an extension that is missing or not loaded from a folder', () => {
    expect(problem({ developerMode: true })).toMatch(/not installed/)
    expect(
      problem({ developerMode: true, extension: { ...enabled.extension!, location: 'FROM_STORE', path: undefined } }),
    ).toMatch(/not loaded unpacked/)
  })
})

describe('build', () => {
  it('refuses to build over a folder that does not hold this extension', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-dist-'))
    try {
      await expect(build('/checkout', dir)).rejects.toThrow("doesn't hold a build")
      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'Another extension' }))
      await expect(build('/checkout', dir)).rejects.toThrow("doesn't hold a build")
      await expect(build('/checkout', 'relative/dist')).rejects.toThrow('relative')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('recognizes its own manifest', () => {
    expect(isOurManifest(JSON.stringify({ manifest_version: 3, name: EXTENSION_NAME }))).toBe(true)
    expect(isOurManifest('not json')).toBe(false)
  })
})

describe('state', () => {
  it('keeps one file per owner, and starts empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-state-'))
    try {
      const path = statePath('claude/issue-106', dir)
      expect(path).toBe(join(dir, 'claude_issue-106.json'))
      expect(await loadState(path)).toEqual({ created: [] })
      await saveState(path, { notionTarget: 'T1', panelTarget: 'T2', created: ['p1'] })
      expect(await loadState(path)).toEqual({ notionTarget: 'T1', panelTarget: 'T2', created: ['p1'] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
