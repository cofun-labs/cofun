// More cases of how a tool call's prompt is answered than the side panel's tests can reach: the UI
// shows one prompt at a time and hides it once answered (extensions/webco/test/read-current-tab.test.tsx).
import { describe, expect, it } from 'vitest'
import { ToolPrompts } from '../src/prompts'
import type { ToolCallRequest } from '../src/types'

const call = (id: string): ToolCallRequest => ({ id, name: 'read_current_tab', args: {} })

/** Prompts whose `shown` lists each call shown, and `hidden` each call answered, in order. */
function prompts() {
  const shown: string[] = []
  const hidden: string[] = []
  const p = new ToolPrompts((c) => {
    shown.push(c.id)
    return () => hidden.push(c.id)
  })
  return { p, shown, hidden }
}

describe('ToolPrompts', () => {
  it('[UC-WEBCO-PANEL-001-S12] a prompt is answered once: a second answer, or Stop after it, changes nothing', async () => {
    const { p, shown, hidden } = prompts()
    const q = p.question(new AbortController().signal)
    const asked = q.confirm(call('a'))
    expect(shown).toEqual(['a'])

    p.answer('a', true)
    p.answer('a', false)
    p.declineAll()

    await expect(asked).resolves.toBe(true)
    expect(hidden).toEqual(['a'])
  })

  it('[UC-WEBCO-PANEL-001-S12] an answer to an earlier prompt never touches a later one with the same id', async () => {
    const { p } = prompts()
    const first = p.question(new AbortController().signal)
    const earlier = first.confirm(call('a'))
    p.answer('a', false)
    await expect(earlier).resolves.toBe(false)
    first.end()

    const second = p.question(new AbortController().signal)
    let settled = false
    const later = second.confirm(call('a')).then((allow) => ((settled = true), allow))
    // The first question ending again drops only its own answers.
    first.end()
    await Promise.resolve()
    expect(settled).toBe(false)

    p.answer('a', true)
    await expect(later).resolves.toBe(true)
  })

  it('[UC-WEBCO-PANEL-001-S12] Stop or leaving the chat answers every open prompt with no', async () => {
    const { p, hidden } = prompts()
    const q = p.question(new AbortController().signal)
    const a = q.confirm(call('a'))
    const b = q.confirm(call('b'))

    p.declineAll()

    await expect(Promise.all([a, b])).resolves.toEqual([false, false])
    expect(hidden).toEqual(['a', 'b'])
    // Nothing is left to answer.
    p.answer('a', true)
    await expect(a).resolves.toBe(false)
  })

  it('[UC-WEBCO-PANEL-001-S12] a question already stopped answers no without showing the prompt', async () => {
    const { p, shown } = prompts()
    const stop = new AbortController()
    stop.abort()

    await expect(p.question(stop.signal).confirm(call('a'))).resolves.toBe(false)
    expect(shown).toEqual([])
  })

  it('[UC-WEBCO-PANEL-001-S12] a prompt left open when its question ended can no longer be answered', async () => {
    const { p, hidden } = prompts()
    const q = p.question(new AbortController().signal)
    void q.confirm(call('a'))
    q.end()

    p.answer('a', true)
    p.declineAll()
    expect(hidden).toEqual([])
  })
})
