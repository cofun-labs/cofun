// The side panel's saved sessions (extension/src/sessions.ts), on an in-memory IndexedDB.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HistoryMessage } from '../../extension/src/agent'
import {
  filterSessions,
  sessionPages,
  SessionStore,
  titleFor,
  type Session,
  type SessionInfo,
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

let store: SessionStore
let n = 0

beforeEach(() => {
  // A fresh account per test, so tests start with no sessions.
  store = new SessionStore(`user_${n++}`)
})

describe('saved sessions', () => {
  it('[UC-SESSION-001-S03] lists sessions most recently used first, titled with their first question', async () => {
    await store.save(session('a', 'Summarize this page', 1000, ROADMAP))
    await store.save(session('b', 'What changed last week?', 3000, NOTES))
    await store.save(session('c', 'Draft an agenda', 2000))

    const list = await store.list()
    expect(list.map((s) => [s.title, s.page?.title])).toEqual([
      ['What changed last week?', 'Meeting notes'],
      ['Draft an agenda', undefined],
      ['Summarize this page', 'Q4 Roadmap'],
    ])
    // A session saved again after another question moves to the top and keeps its whole conversation.
    const a = (await store.get('a'))!
    const messages: HistoryMessage[] = [...a.messages, { role: 'user', text: 'Thanks' }]
    await store.save({ ...a, messages, updatedAt: 4000 })
    const { messages: _, ...info } = a
    expect((await store.list())[0]).toEqual({ ...info, updatedAt: 4000 })
    expect(await store.get('a')).toEqual({ ...a, messages, updatedAt: 4000 })
  })

  it('[UC-SESSION-001-S04] search by title and filter by the page a session started on', async () => {
    await store.save(session('a', 'Summarize this page', 1000, ROADMAP))
    await store.save(session('b', 'Summarize the decisions', 2000, NOTES))
    await store.save(session('c', 'Draft an agenda', 3000, { ...NOTES, url: `${NOTES.url}?pvs=4#block` }))
    const all = await store.list()
    const ids = (sessions: SessionInfo[]) => sessions.map((s) => s.id)

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
    await store.save(session('a', 'Summarize this page', 1000, ROADMAP))
    await store.save(session('b', 'Draft an agenda', 2000))
    await store.delete('a')
    expect((await store.list()).map((s) => s.id)).toEqual(['b'])
    expect(await store.get('a')).toBeUndefined()
    expect((await store.get('b'))?.title).toBe('Draft an agenda')
  })

  it("[UC-SESSION-001-S09] another account on the same browser sees none of the first account's sessions", async () => {
    const alice = new SessionStore('user_alice_s09')
    const bob = new SessionStore('user_bob_s09')
    await alice.save(session('a', 'Summarize this page', 1000, ROADMAP))
    expect(await bob.list()).toEqual([])
    expect(await bob.get('a')).toBeUndefined()
    // Deleting under one account leaves the other's sessions alone.
    await bob.delete('a')
    expect((await alice.list()).map((s) => s.id)).toEqual(['a'])
  })

  it('a title is the first question on one line, cut to a readable length', () => {
    expect(titleFor([{ role: 'user', text: '  Line one\n\nline two ' }])).toBe('Line one line two')
    const long = titleFor([{ role: 'user', text: 'x'.repeat(300) }])
    expect(long).toHaveLength(100)
    expect(long.endsWith('…')).toBe(true)
  })
})
