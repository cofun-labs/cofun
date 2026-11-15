// Which addresses count as given by the user, for read_web_page and render_web_page: the address
// written whole in one of their messages, and nothing the model changed in it. What is read is the
// address as the user wrote it.
import { describe, expect, it } from 'vitest'
import { userAddress } from '../src/tools/web'

const ARTICLE = 'https://tea.example/history?lang=en'

/** The address read for `given`, when the user wrote `text`. */
const read = (given: string, text: string) => userAddress(given, new URL(given), [text])?.href

describe('an address the user gave', () => {
  it.each([
    ['written whole, before a full stop', ARTICLE, `see ${ARTICLE}.`, ARTICLE],
    ['written without its scheme, in brackets', 'https://tea.example/', '(tea.example)', 'https://tea.example/'],
    ['with another fragment', 'https://tea.example/a#b', 'https://tea.example/a#c', 'https://tea.example/a'],
    [
      'with its characters not encoded',
      'https://zh.example/茶',
      '看看 https://zh.example/茶。',
      'https://zh.example/%E8%8C%B6',
    ],
  ])('[UC-NOTICO-PANEL-003-S02] counts an address %s', (_, given, text, sent) => {
    expect(read(given, text)).toBe(sent)
  })

  it.each([
    [
      'characters it encoded',
      'https://tea.example/%61rticle',
      'https://tea.example/article',
      'https://tea.example/article',
    ],
    ['another scheme', 'https://tea.example/a', 'http://tea.example/a', 'http://tea.example/a'],
    ['a scheme the user did not write', 'http://tea.example/a', 'tea.example/a', 'https://tea.example/a'],
  ])("[UC-NOTICO-PANEL-003-S02] reads the user's own form, not the model's %s", (_, given, text, sent) => {
    expect(read(given, text)).toBe(sent)
  })

  it.each([
    ['a shorter path', 'https://tea.example/a', 'https://tea.example/a/b'],
    ['a query added', 'https://tea.example/a?x=1', 'tea.example/a'],
    ['the host alone', 'https://tea.example', 'https://tea.example/a'],
    ['the parent of a host the user wrote', 'https://tea.example/a', 'https://evil.tea.example/a'],
    ['a part of the path', 'https://tea.example/a', 'https://x.example/tea.example/a'],
    ['another case', 'https://tea.example/A', 'https://tea.example/a'],
    [
      'the address with the words after it',
      'https://tea.example/a and my code is 1234',
      'Read https://tea.example/a and my code is 1234 later',
    ],
    ['the address with the next line', 'https://tea.example/a\nsecret', 'https://tea.example/a\nsecret'],
    ['a space it encoded', 'https://tea.example/a%20and%20more', 'https://tea.example/a and more'],
  ])('[UC-NOTICO-PANEL-003-S02] refuses %s of what the user wrote', (_, given, text) => {
    expect(read(given, text)).toBeUndefined()
  })
})
