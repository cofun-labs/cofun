// The recent pages the page picker offers, worked out from a saved conversation (pagesIn in
// extensions/notico/src/tools.ts): no Notion request, so plain history is enough here.
import { describe, expect, it } from 'vitest'
import type { HistoryMessage } from '../src/agent'
import { pagesIn } from '../src/tools'

const ORIGINAL = '1a1a1a1a000040008000000000000010'
const COPY = '2b2b2b2b000040008000000000000020'
const ORIGIN = 'https://app.notion.com'

describe('recent pages', () => {
  it('names a page only by the call that read it, never a copy by its original’s title', () => {
    const history: HistoryMessage[] = [
      { role: 'user', text: 'Copy the launch plan' },
      {
        role: 'assistant',
        parts: [
          { type: 'tool_call', id: 'r', name: 'read_page', args: { page: ORIGINAL } },
          { type: 'tool_call', id: 'd', name: 'duplicate_page', args: { page: ORIGINAL } },
        ],
      },
      { role: 'tool', id: 'r', name: 'read_page', status: 'done', result: `Page: Launch plan ^${ORIGINAL}\n\nText.` },
      {
        role: 'tool',
        id: 'd',
        name: 'duplicate_page',
        status: 'done',
        result: `Duplicated "Launch plan" ^${ORIGINAL} as ^${COPY}, right after it.\n`,
      },
    ]
    expect(pagesIn(history, ORIGIN)).toEqual([{ title: 'Launch plan', url: `${ORIGIN}/p/${ORIGINAL}` }])
  })
})
