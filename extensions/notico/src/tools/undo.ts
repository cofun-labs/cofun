// Undoing what a question changed in Notion: the write tools record each change here as they make
// it (recordWrite, notUndoable), and undoChanges puts a question's changes back, from the reply's
// Undo button in the side panel or from undo_changes when the user asks in words. What a change is,
// and how it is undone, is the site layer's (notion/undo.ts).
import { defineTool } from '../tool'
import { z } from '../zod'
import { NotionError, type Operation, type RecordMap } from '../notion/api'
import { activeNotionTab, type NotionTab } from '../notion/tab'
import {
  PAGE_HISTORY,
  UndoError,
  changesOf,
  describeUndo,
  merge,
  notUndone,
  planUndo,
  readBack,
  undoPointers,
  undoable,
  type QuestionChanges,
} from '../notion/undo'
import { toUuid } from '../notion/hosts'
import { hexId } from '../notion/markdown'
import type { ToolMemory } from './memory'
import { verb } from './shared'

/** What a write is on, for the user: the page its changes are on (all of them), and page titles by id. */
interface Written {
  page?: string
  titles?: Record<string, string>
  /** Blocks the tool already read back after the write, which need no read of their own. */
  known?: RecordMap
}

/**
 * Records a write the tool just made (`operations`, sent to `space`), from the records it read
 * before (`before`), so the question's changes can be undone. Reads the changed blocks back, as the
 * question left them. A write it can't undo is named as such instead; so is one whose blocks could
 * not be read back. A read back that stops the question stops it, the write being saved.
 */
export async function recordWrite(
  memory: ToolMemory,
  tab: NotionTab,
  space: string,
  operations: Operation[],
  before: RecordMap,
  { page, titles = {}, known }: Written = {},
): Promise<void> {
  const what = titleOf(titles, page)
  const next = changesOf(operations, before, page)
  const prior = memory.changes
  // One workspace per question: its undo is one transaction. A question that only noted what it
  // can't undo has none yet.
  if (!next || (prior?.space && prior.space !== space)) return notUndoable(memory, `a change on ${what}`)
  const ids = new Set(operations.map((op) => toUuid(op.pointer.id) ?? op.pointer.id))
  try {
    const changes = await readBack(tab.client, space, merge(prior?.changes ?? [], next), ids, known)
    memory.changes = {
      space,
      changes,
      titles: { ...prior?.titles, ...titles },
      cannot: prior?.cannot ?? [],
    }
  } catch (err) {
    notUndoable(memory, `a change on ${what}`)
    if (err instanceof NotionError && err.stopsQuestion)
      throw new NotionError('notion_error', 'The change was saved.', {
        cause: err,
        stopsQuestion: `The change was saved. ${err.stopsQuestion}`,
        mayHaveChanged: true,
      })
    console.warn('Could not read back a change to undo it later', err)
  }
}

/**
 * Records a page the question made without a transaction of its own (a copy Notion made): it goes
 * to the trash when the question is undone.
 */
export async function recordCreated(
  memory: ToolMemory,
  tab: NotionTab,
  space: string,
  page: { id: string; parent: string; type: string; title: string },
): Promise<void> {
  // As the transaction that would have made it: the page, set under its parent.
  const made: Operation = {
    pointer: { table: 'block', id: page.id },
    path: [],
    command: 'set',
    args: { id: page.id, type: page.type, parent_id: page.parent, parent_table: 'block' },
  }
  await recordWrite(memory, tab, space, [made], {}, { page: page.id, titles: { [page.id]: page.title } })
}

/** Notes a change of the question that undoing it won't put back, in words: “the comment on “Notes””. */
export function notUndoable(memory: ToolMemory, what: string): void {
  const prior = memory.changes
  memory.changes = {
    space: prior?.space ?? '',
    changes: prior?.changes ?? [],
    titles: prior?.titles ?? {},
    cannot: [...new Set([...(prior?.cannot ?? []), what])],
  }
}

/**
 * Runs a write the question's undo won't put back (`what`, in words): noted once it ran, or once it
 * failed in a way that may have changed something.
 */
export async function unrecorded<T>(memory: ToolMemory, what: string, write: () => Promise<T>): Promise<T> {
  try {
    const done = await write()
    notUndoable(memory, what)
    return done
  } catch (err) {
    if (err instanceof NotionError && err.mayHaveChanged) notUndoable(memory, what)
    throw err
  }
}

/** A page for the user: its title in quotes when known, else “a page”. */
function titleOf(titles: Record<string, string>, page?: string): string {
  const title = page ? titles[page]?.trim() : undefined
  return title ? `“${title}”` : 'a page'
}

const UNKNOWN =
  'Notion did not confirm the undo, so it may or may not have been made. Check the pages before undoing again.'

/**
 * Undoes what question `q` changed, in the Notion tab `tab`: refuses (an UndoError, nothing sent)
 * when something it changed has changed since, and otherwise sends the undo once and reads the
 * pages back to check it. `landed` is called as soon as Notion took it. Resolves with what was
 * done, in words.
 */
async function undoChanges(
  q: QuestionChanges,
  tab: NotionTab,
  landed: () => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!undoable(q)) throw new UndoError('Nothing of that question can be undone.')
  const pointers = undoPointers(q)
  const current = await tab.client.findRecords(pointers, { deleted: true })
  const plan = planUndo(q, current, tab.client.userId)
  signal?.throwIfAborted()
  try {
    await tab.client.submitUndo(q.space, plan.operations, plan.trashed)
  } catch (err) {
    if (err instanceof NotionError && err.code === 'outcome_unknown')
      throw new NotionError('outcome_unknown', UNKNOWN, { cause: err, stopsQuestion: err.stopsQuestion })
    // Taken, but what came after it failed: it is undone.
    if (err instanceof NotionError && err.mayHaveChanged) landed()
    throw err
  }
  landed()
  const done = [
    'Undone:',
    ...describeUndo({ ...q, cannot: [] }).map((line) => `    ${line}`),
    ...(q.cannot.length ? [`Not undone: ${q.cannot.join('; ')}.`] : []),
  ]
  let off: string[]
  try {
    off = notUndone(q, await tab.client.findRecords(pointers, { deleted: true }))
  } catch (err) {
    if (err instanceof NotionError && err.stopsQuestion)
      throw new NotionError('notion_error', 'The changes were undone.', {
        cause: err,
        stopsQuestion: `The changes were undone. ${err.stopsQuestion}`,
        mayHaveChanged: true,
      })
    return [...done, 'The pages could not be read back to check it: look at them in Notion.'].join('\n')
  }
  if (off.length)
    throw new NotionError(
      'notion_error',
      `Notion took the undo, but ${off.join(', ')} ${off.length === 1 ? 'is' : 'are'} not as before the question. ` +
        PAGE_HISTORY,
      { mayHaveChanged: true },
    )
  return done.join('\n')
}

/**
 * Undoes question `q` from the side panel's Undo button, in the current tab, which must be on Notion;
 * its requests count toward no question. Marks `q` undone once Notion took it.
 */
export async function undoQuestion(q: QuestionChanges): Promise<string> {
  const tab = await activeNotionTab({ counted: false })
  return await undoChanges(q, tab, () => (q.undone = true))
}

/** The latest question of the chat whose changes can be undone, with its id; none when there is none. */
function latestUndoable(memory: ToolMemory): [string, QuestionChanges] | undefined {
  return [...memory.undos].reverse().find(([, q]) => undoable(q) || q.cannot.length > 0)
}

/** Forgets what the agent saw of the pages an undo changed, which are not as it saw them now. */
export function forgetUndone(memory: ToolMemory, q: QuestionChanges): void {
  memory.forgetPages(new Set(q.changes.flatMap((c) => [c.id, c.page])))
}

export const undoChangesTool = defineTool({
  changesData: true,
  // It puts back what may have been the user's wish: they see what it undoes, and agree, each time.
  needsConfirmation: true,
  name: 'undo_changes',
  description:
    'Undoes what the latest earlier question of this chat changed in Notion: deletes the blocks it added, ' +
    'moves the pages and rows it created to the trash, brings back the blocks it deleted, and sets back the ' +
    'text, titles, icons, and properties it changed. Use it only when the user asks to undo. The user sees ' +
    'what it undoes and agrees first. Nothing is undone if a page it changed was changed since; comments, ' +
    "moves, the trash, and a database's properties are never undone.",
  describe: () => ({ verb: verb('undo', 'undoing', 'undid'), what: 'the last changes' }),
  args: z.strictObject({}),
  preview: (_args, { memory }) => {
    const latest = latestUndoable(memory)
    if (!latest) return 'Nothing to undo: no earlier question of this chat changed Notion.'
    return ['Undo what the last question that changed Notion did', ...describeUndo(latest[1])].join('\n')
  },
  run: async (_args, signal, { memory }) => {
    const latest = latestUndoable(memory)
    if (!latest) throw new UndoError('No earlier question of this chat changed Notion, so there is nothing to undo.')
    const [, q] = latest
    if (!undoable(q))
      throw new UndoError(`The last question's changes can't be undone here: ${q.cannot.join('; ')}. ${PAGE_HISTORY}`)
    const tab = await activeNotionTab()
    try {
      const text = await undoChanges(
        q,
        tab,
        () => {
          q.undone = true
          // The model ran it: it knows.
          q.told = true
        },
        signal,
      )
      return { text, details: { changed: [...new Set(q.changes.map((c) => hexId(c.page)))] } }
    } finally {
      forgetUndone(memory, q)
    }
  },
})
