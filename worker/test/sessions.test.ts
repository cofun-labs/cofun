// The side panel's saved sessions (extension/src/sessions.ts), on an in-memory IndexedDB.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HistoryMessage } from '../../extension/src/agent'
import {
  deleteSession,
  filterSessions,
  getSession,
  listSessions,
  saveSession,
  sessionPages,
  titleFor,
  type Session,
} from '../../extension/src/sessions'

const ROADMAP = { title: 'Q4 Roadmap', url: 'https://www.notion.so/team/Q4-Roadmap-abc123' }
const NOTES = { title: 'Meeting notes', url: 'https://www.notion.so/team/Meeting-notes-def456' }

function conversation(question: string): HistoryMessage[] {
  return [
    { role: 'user', text: question },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'call-1', name: 'get_current_page', args: {} }] },
    { role: 'tool', id: 'call-1', name: 'get_current_page', status: 'done', result: JSON.stringify(ROADMAP) },
    { role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] },
  ]
}

function session(id: string, question: string, updatedAt: number, page?: Session['page']): Session {
  const messages = conversation(question)
  return { id, title: titleFor(messages), page, createdAt: updatedAt - 1000, updatedAt, messages }
}

beforeEach(async () => {
  for (const s of await listSessions()) await deleteSession(s.id)
})

describe('saved sessions', () => {
  it('[UC-SESSION-001-S03] lists sessions most recently used first, titled with their first question', async () => {
    await saveSession(session('a', 'Summarize this page', 1000, ROADMAP))
    await saveSession(session('b', 'What changed last week?', 3000, NOTES))
    await saveSession(session('c', 'Draft an agenda', 2000))

    const list = await listSessions()
    expect(list.map((s) => [s.title, s.page?.title])).toEqual([
      ['What changed last week?', 'Meeting notes'],
      ['Draft an agenda', undefined],
      ['Summarize this page', 'Q4 Roadmap'],
    ])
    // A session saved again after another question moves to the top, with its whole conversation.
    const a = list[2]
    const messages: HistoryMessage[] = [...a.messages, { role: 'user', text: 'Thanks' }]
    await saveSession({ ...a, messages, updatedAt: 4000 })
    const [top] = await listSessions()
    expect(top).toEqual({ ...a, messages, updatedAt: 4000 })
  })

  it('[UC-SESSION-001-S04] search by title and filter by the page a session started on', async () => {
    await saveSession(session('a', 'Summarize this page', 1000, ROADMAP))
    await saveSession(session('b', 'Summarize the decisions', 2000, NOTES))
    await saveSession(session('c', 'Draft an agenda', 3000, { ...NOTES, url: `${NOTES.url}?pvs=4#block` }))
    const all = await listSessions()
    const ids = (sessions: Session[]) => sessions.map((s) => s.id)

    expect(ids(filterSessions(all, { query: 'SUMMARIZE' }))).toEqual(['b', 'a'])
    // The same page with another query string or fragment counts as one page.
    const pages = sessionPages(all)
    expect(pages.map((p) => p.title)).toEqual(['Meeting notes', 'Q4 Roadmap'])
    const notes = pages[0].key
    expect(ids(filterSessions(all, { page: notes }))).toEqual(['c', 'b'])
    expect(ids(filterSessions(all, { query: 'summarize', page: notes }))).toEqual(['b'])
    expect(ids(filterSessions(all, { query: '  ' }))).toEqual(['c', 'b', 'a'])
  })

  it('[UC-SESSION-001-S05] a deleted session is no longer listed and cannot be reopened', async () => {
    await saveSession(session('a', 'Summarize this page', 1000, ROADMAP))
    await saveSession(session('b', 'Draft an agenda', 2000))
    await deleteSession('a')
    expect((await listSessions()).map((s) => s.id)).toEqual(['b'])
    expect(await getSession('a')).toBeUndefined()
    expect((await getSession('b'))?.title).toBe('Draft an agenda')
  })

  it('a title is the first question on one line, cut to a readable length', () => {
    expect(titleFor([{ role: 'user', text: '  Line one\n\nline two ' }])).toBe('Line one line two')
    const long = titleFor([{ role: 'user', text: 'x'.repeat(300) }])
    expect(long).toHaveLength(100)
    expect(long.endsWith('…')).toBe(true)
  })
})
