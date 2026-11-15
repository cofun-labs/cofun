// Which addresses count as given by the user, for read_web_page and render_web_page: the address
// written whole in one of their messages, and nothing the model changed in it.
import { describe, expect, it } from 'vitest'
import { givenByUser } from '../src/tools/web'

const ARTICLE = 'https://tea.example/history?lang=en'

describe('an address the user gave', () => {
  it.each([
    ['written whole, before a full stop', ARTICLE, `see ${ARTICLE}.`],
    ['written without its scheme, in brackets', 'http://tea.example/', '(tea.example)'],
    ['with another fragment', 'https://tea.example/a#b', 'https://tea.example/a#c'],
    ['with its characters not encoded', 'https://zh.example/茶', '看看 https://zh.example/茶。'],
  ])('[UC-NOTICO-PANEL-003-S02] counts an address %s', (_, given, text) => {
    expect(givenByUser(given, new URL(given), [text])).toBe(true)
  })

  it.each([
    ['a shorter path', 'https://tea.example/a', 'https://tea.example/a/b'],
    ['a query added', 'https://tea.example/a?x=1', 'tea.example/a'],
    ['the host alone', 'https://tea.example', 'https://tea.example/a'],
    ['the parent of a host the user wrote', 'https://tea.example/a', 'https://evil.tea.example/a'],
    ['a part of the path', 'https://tea.example/a', 'https://x.example/tea.example/a'],
    ['another case', 'https://tea.example/A', 'https://tea.example/a'],
  ])('[UC-NOTICO-PANEL-003-S02] refuses %s of what the user wrote', (_, given, text) => {
    expect(givenByUser(given, new URL(given), [text])).toBe(false)
  })
})
