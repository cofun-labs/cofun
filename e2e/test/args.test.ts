import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMEOUT_S, UsageError, parseArgs } from '../src/args'

const ID = '0123456789abcdef0123456789abcdef'
const UUID = '01234567-89ab-cdef-0123-456789abcdef'

describe('parseArgs', () => {
  it('shows help without a command, or with -h', () => {
    expect(parseArgs([]).command).toEqual({ name: 'help' })
    expect(parseArgs(['ask', '-h']).command).toEqual({ name: 'help' })
  })

  it('takes the lock owner from --owner, in either form', () => {
    expect(parseArgs(['reload', '--owner', 'issue-1'])).toEqual({ command: { name: 'reload' }, owner: 'issue-1' })
    expect(parseArgs(['--owner=issue-1', 'close']).owner).toBe('issue-1')
  })

  it('takes an optional Notion URL for panel, and refuses other sites', () => {
    expect(parseArgs(['panel']).command).toEqual({ name: 'panel', url: undefined })
    const url = `https://app.notion.com/p/${ID}`
    expect(parseArgs(['panel', url]).command).toEqual({ name: 'panel', url })
    expect(() => parseArgs(['panel', 'https://example.com/'])).toThrow(UsageError)
  })

  it('reads ask with its answer, timeout, and output options', () => {
    expect(parseArgs(['ask', 'Make a child page', '--allow', '--timeout', '60', '--json']).command).toEqual({
      name: 'ask',
      question: 'Make a child page',
      answer: 'allow',
      timeoutMs: 60_000,
      json: true,
    })
    expect(parseArgs(['ask', 'hi', '--deny']).command).toMatchObject({ answer: 'deny' })
  })

  it('lets ask go without a question, to keep waiting for the last reply', () => {
    expect(parseArgs(['ask', '--allow']).command).toEqual({
      name: 'ask',
      question: undefined,
      answer: 'allow',
      timeoutMs: DEFAULT_TIMEOUT_S * 1000,
      json: false,
    })
  })

  it('refuses contradicting or misplaced ask options', () => {
    expect(() => parseArgs(['ask', 'hi', '--allow', '--deny'])).toThrow('not both')
    expect(() => parseArgs(['ask', 'hi', '--timeout', 'soon'])).toThrow('Not a number')
    expect(() => parseArgs(['ask', 'hi', '--timeout'])).toThrow('needs a value')
    expect(() => parseArgs(['ask', '  '])).toThrow('empty')
    expect(() => parseArgs(['page', 'T', '--allow'])).toThrow('only goes with ask')
    expect(() => parseArgs(['ask', 'one', 'two'])).toThrow('Too many arguments')
  })

  it('joins the Markdown arguments of page into lines', () => {
    expect(parseArgs(['page', 'Plan', '## Goals', 'Ship it']).command).toEqual({
      name: 'page',
      title: 'Plan',
      markdown: '## Goals\nShip it',
    })
    expect(() => parseArgs(['page'])).toThrow('needs a title')
  })

  it('passes everything after -- as arguments, even if it looks like an option', () => {
    expect(parseArgs(['page', 'Plan', '--', '--- not an option']).command).toMatchObject({
      markdown: '--- not an option',
    })
  })

  it('takes the rows of db as given', () => {
    expect(parseArgs(['db', 'Tasks', 'Write post|Done|2026-11-03', 'Plan']).command).toEqual({
      name: 'db',
      title: 'Tasks',
      rows: ['Write post|Done|2026-11-03', 'Plan'],
    })
  })

  it('takes a page id for trash, dashed or not', () => {
    expect(parseArgs(['trash', ID]).command).toEqual({ name: 'trash', id: UUID })
    expect(parseArgs(['trash', UUID.toUpperCase()]).command).toEqual({ name: 'trash', id: UUID })
    expect(() => parseArgs(['trash', 'my page'])).toThrow('Not a Notion id')
    expect(() => parseArgs(['trash'])).toThrow('needs the id')
  })

  it('reads lock actions, with a purpose only for acquire', () => {
    expect(parseArgs(['lock', 'acquire', 'UC-NOTION-007-S04', 'run']).command).toEqual({
      name: 'lock',
      action: 'acquire',
      purpose: 'UC-NOTION-007-S04 run',
    })
    expect(parseArgs(['lock', 'status']).command).toEqual({ name: 'lock', action: 'status', purpose: undefined })
    expect(() => parseArgs(['lock', 'steal'])).toThrow(UsageError)
    expect(() => parseArgs(['lock', 'release', 'now'])).toThrow('Too many arguments')
  })

  it('refuses unknown commands and options', () => {
    expect(() => parseArgs(['deploy'])).toThrow('Unknown command')
    expect(() => parseArgs(['reload', '--force'])).toThrow('Unknown option')
    expect(() => parseArgs(['reload', 'now'])).toThrow('Too many arguments')
  })
})
