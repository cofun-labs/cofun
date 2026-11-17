// What this tool opened and created, per lock owner and extension, so later commands act only on those: the
// Notion tab and its side panel, and the throwaway pages that `trash` may remove. Kept outside the
// repository, next to the lock.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ExtensionSlug } from './extension'

export interface State {
  /** CDP target id of the Notion tab this tool opened. */
  notionTarget?: string
  /** CDP target id of the tab on another site this tool opened. */
  otherTarget?: string
  /** CDP target ids of the tabs `tab` opened. */
  tabTargets: string[]
  /** CDP target id of the side panel this tool opened. */
  panelTarget?: string
  /** Ids of pages and databases this tool created and hasn't trashed. */
  created: string[]
}

const STATE_DIR = join(homedir(), '.cache', 'cofun', 'e2e')

/** One file per owner and extension; other characters are escaped, so different owners never share a file. */
export function statePath(owner: string, extension: ExtensionSlug): string {
  // Fixed width, so the escape is one-to-one.
  const name = owner.replace(/[^\w.-]/gu, (c) => `%${c.codePointAt(0)!.toString(16).padStart(6, '0')}`)
  const dir = extension === 'notico' ? STATE_DIR : join(STATE_DIR, extension)
  return join(dir, `${name}.json`)
}

export async function loadState(path: string): Promise<State> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<State>
    return {
      notionTarget: typeof raw.notionTarget === 'string' ? raw.notionTarget : undefined,
      otherTarget: typeof raw.otherTarget === 'string' ? raw.otherTarget : undefined,
      panelTarget: typeof raw.panelTarget === 'string' ? raw.panelTarget : undefined,
      tabTargets: Array.isArray(raw.tabTargets) ? raw.tabTargets.filter((id) => typeof id === 'string') : [],
      created: Array.isArray(raw.created) ? raw.created.filter((id) => typeof id === 'string') : [],
    }
  } catch {
    return { tabTargets: [], created: [] }
  }
}

export async function saveState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`)
}
