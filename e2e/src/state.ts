// What this tool opened and created, per lock owner, so later commands act only on those: the
// Notion tab and its side panel, and the throwaway pages that `trash` may remove. Kept outside the
// repository, next to the lock.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface State {
  /** CDP target id of the Notion tab this tool opened. */
  notionTarget?: string
  /** CDP target id of the side panel open for that tab. */
  panelTarget?: string
  /** Ids of pages and databases this tool created and hasn't trashed. */
  created: string[]
}

export const STATE_DIR = join(homedir(), '.cache', 'notion-copilot', 'e2e')

/** One file per owner; other characters are escaped, so different owners never share a file. */
export function statePath(owner: string, dir = STATE_DIR): string {
  // Fixed width, so the escape is one-to-one.
  const name = owner.replace(/[^\w.-]/gu, (c) => `%${c.codePointAt(0)!.toString(16).padStart(6, '0')}`)
  return join(dir, `${name}.json`)
}

export async function loadState(path: string): Promise<State> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<State>
    return {
      notionTarget: typeof raw.notionTarget === 'string' ? raw.notionTarget : undefined,
      panelTarget: typeof raw.panelTarget === 'string' ? raw.panelTarget : undefined,
      created: Array.isArray(raw.created) ? raw.created.filter((id) => typeof id === 'string') : [],
    }
  } catch {
    return { created: [] }
  }
}

export async function saveState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`)
}
