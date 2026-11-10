import { readFileSync } from 'node:fs'

/** The committed build config of the hosted extension (extension/.env), as `KEY=value` lines. */
export function hostedEnv(): Record<string, string> {
  const text = readFileSync(new URL('../../extension/.env', import.meta.url), 'utf8')
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => /^\w+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
  )
}
